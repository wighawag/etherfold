import {resolveStreamConfig, streamDigestOf, type Abi, type GenerationId, type ReceivingIndexer} from '@etherfold/core';
import type {EnvRecord} from '@etherfold/fetcher-host';
import type {EntityProcessor, WritableStateStore} from '@etherfold/processor-entities';
import type {ReconfigureReport} from '@etherfold/server';
import {instantiateProcessor, loadProcessorModule} from '@etherfold/utils';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {logs} from 'named-logs';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {RemoteSQL} from 'remote-sql';
import {resolveCommandConfig} from './config.js';
import {foldPartsFor, openIndexingSource, streamConfigFor} from './folding.js';
import type {Options, RunConfig} from './types.js';

const logger = logs('etherfold');

// ---------------------------------------------------------------------------------------------------
// THE RE-READ: WHAT `POST /{indexer}/admin/reconfigure` ACTUALLY DOES ON THIS PROCESS
// ---------------------------------------------------------------------------------------------------
// A generation used to be registered when the container OPENED, from
// configuration, and nothing watched a file or exposed a route that added one --
// so a changed processor reached a running deployment by RESTARTING it. This is
// the trigger that removes the restart, and the whole of what it does is to redo
// the two resolutions `prepareIndexing` did and hand the result to
// `container.add`.
//
// ## Three rules it does not get to break
//
//  1. **It registers BESIDE and never restarts.** Nothing here re-opens the
//     container, re-binds the port, re-opens the database or touches the
//     incumbent's tables. The incumbent goes on answering every read throughout,
//     which is the property this affordance exists to preserve: a reload that
//     briefly stops answering is a WORSE outcome than the restart it replaces.
//  2. **A failure leaves the deployment exactly as it was.** A processor that
//     does not compile is the NORMAL state between the two halves of one change,
//     not an exception, so the whole re-read happens BEFORE `add` is reached and
//     a refusal is reported as data. `add` itself already registers nothing for a
//     generation it refuses.
//  3. **It answers WHAT it did.** `registered`, `unchanged` or `failed` -- see
//     `ReconfigureReport` (`@etherfold/server`), and the section below on why
//     `unchanged` is the one a developer will actually meet most often.
//
// ## WHY `unchanged` IS COMMON, AND WHAT MOVES THE IDENTITY
//
// A generation is registered only when its IDENTITY differs, and the processor
// half of that identity is `getVersionHash()`: the author-DECLARED `version`,
// plus a hash of the entity declarations and the processor config. It is
// deliberately NOT a hash of the handler source -- the code fingerprint is
// ADVISORY and stays out of the identity, because a bundler re-emitting the same
// behaviour differently would otherwise invalidate every deployment's state
// (`@etherfold/core`, `utils/fingerprint.ts`, which records that as a deviation
// from ADR-0008).
//
// So an edit to a HANDLER BODY alone names the generation this deployment
// already holds, and the honest answer is `unchanged`. That is not a failure of
// the trigger and it is not something to paper over by folding the fingerprint
// into the identity: the author bumps `version` (or changes the entity
// declarations, or the source) when they mean "this is a different fold", and the
// message this returns says exactly that, so "I saved the file and nothing
// happened" has an answer rather than three indistinguishable causes.
//
// ## THE MODULE CACHE, AND WHAT DEFEATING IT COSTS
//
// `import(specifier)` returns the CACHED module for a path already imported, so
// a re-read that did nothing about it would observe a rebuild as no change at
// all -- the trigger would appear to work and never see an edit. The loader
// already takes an injected importer (`LoadProcessorModuleOptions.importModule`),
// so this supplies one that appends a unique query to the module's file URL,
// which is a different key in the ESM registry and therefore a fresh evaluation.
//
// The COST is stated rather than discovered: every reload adds a module instance
// to that registry and NONE of them are ever collected, because the registry is
// keyed by URL and holds its entries for the life of the process. For a
// development loop that is nothing. For a long-lived deployment being poked by a
// deploy hook it is a slow, bounded-by-nothing growth in retained modules, so a
// production caller should be triggering this per BUILD and not per minute. The
// alternative -- a fresh worker per reload -- costs a process boundary the fold
// would then have to cross, which is a much larger design for a hazard this
// small.
// ---------------------------------------------------------------------------------------------------

/** The query a reload's specifier carries, so a cached module is not what comes back. */
const RELOAD_QUERY = 'etherfold-reload';

/** What a running `run` hands over so that it can be asked to re-read itself. */
export type ReconfigureContext<ABI extends Abi = Abi, ProcessResultType = unknown> = {
	/**
	 * The flags this process was started with, RE-RESOLVED on every call rather
	 * than the already-resolved config, because that is half of what re-reading
	 * means: a deployments folder and `INDEXING_SOURCE` are inputs a rebuild can
	 * move, and a re-read that reloaded the module and kept the old source would
	 * half-apply the author's intent.
	 */
	options: Options;
	/** The environment those flags fall back to -- `process.env` on a real deployment, so it is live. */
	env: EnvRecord;
	/** The chain, for the one arm of source resolution that may cost an `eth_chainId` call. */
	provider: EIP1193ProviderWithoutEvents;
	/** The ONE handle this process folds into. A re-read lands in it and never opens another. */
	db: RemoteSQL;
	/** WHERE that handle was opened, so a re-read naming a different database is refused rather than misfiled. */
	dbUrl: string;
	/** The NAMED INDEXER this process registered, which a re-read may not change under it. */
	indexer: string;
	/** The generations this process holds: what a re-read adds to, beside the live fold. */
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>;
	/** Substituted by a test; a deployment reloads through the cache-busting importer below. */
	importModule?: (specifier: string) => Promise<any>;
};

/**
 * Build the RE-READ this process answers `POST /{indexer}/admin/reconfigure`
 * with.
 *
 * Calls are SERIALISED, one after another, because a watcher firing twice in
 * quick succession would otherwise have two re-reads deciding "is this identity
 * already held" against the same registry at the same time, and both could
 * register. Debouncing belongs to the watcher; not tripping over a burst belongs
 * here.
 */
export function reconfigurerFor<ABI extends Abi, ProcessResultType>(
	held: ReconfigureContext<ABI, ProcessResultType>,
): () => Promise<ReconfigureReport> {
	let reloads = 0;
	let queue: Promise<unknown> = Promise.resolve();

	/**
	 * Import the module as it is ON DISK NOW.
	 *
	 * An INJECTED importer wins and is left alone: a test supplying one is stating
	 * what comes back, and appending a query to a specifier it may never look at
	 * would be this module pretending to control something it does not. Otherwise
	 * the specifier -- always a filesystem path by the time `loadProcessorModule`
	 * hands it over, absolute or resolved against the working directory -- becomes a
	 * file URL carrying a counter. A specifier that is somehow NOT a path is
	 * imported as-is rather than mangled: a bare package name is not something this
	 * can make a URL of, and importing it unchanged is strictly better than
	 * refusing.
	 */
	const importFresh =
		held.importModule ??
		((specifier: string): Promise<any> => {
			if (!isAbsolute(specifier)) return import(specifier);
			const url = pathToFileURL(specifier);
			url.searchParams.set(RELOAD_QUERY, String(++reloads));
			return import(url.href);
		});

	const reread = async (): Promise<ReconfigureReport> => {
		let wanted: GenerationId;
		let parts: Awaited<ReturnType<typeof foldPartsFor<ABI, ProcessResultType>>>;
		let providedStreamConfig: ReturnType<typeof streamConfigFor>;
		let source: Awaited<ReturnType<typeof openIndexingSource<ABI, ProcessResultType>>>;
		try {
			// EVERYTHING that can refuse happens here, before `add` is reached: the
			// configuration, the module, the processor it exports and the source it
			// names. So a broken intermediate state costs the deployment nothing at all.
			const resolved = resolveCommandConfig<'run', ABI>('run', held.options, held.env) as RunConfig<ABI>;
			const refusal = refuseAMovedDeployment(resolved, held);
			if (refusal) return refusal;

			providedStreamConfig = streamConfigFor(held.env);
			// RESOLVED once, and both identities are taken over the same object: the stream
			// digest this generation is filed under and the finality the state is built with
			// cannot be two different answers to one configuration.
			const streamConfig = resolveStreamConfig(providedStreamConfig);
			const processorModule = await loadProcessorModule<ABI, ProcessResultType>(resolved.processor, {
				importModule: importFresh,
			});
			const declared = instantiateProcessor<ABI, ProcessResultType, EntityProcessor<ABI, any>>(processorModule, {
				processorPath: resolved.processor,
			});
			source = await openIndexingSource<ABI, ProcessResultType>(resolved.source, processorModule, held.provider);
			parts = await foldPartsFor<ABI, ProcessResultType>(
				declared,
				resolved.destination,
				held.db,
				streamConfig.finality,
			);
			wanted = {stream: streamDigestOf(source, streamConfig), processor: parts.versionHash};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`reconfigure: this deployment could not re-read its configuration, and nothing changed`, err);
			return {outcome: 'failed', message};
		}

		// A FOLD THIS PROCESS ALREADY HOLDS IS NOT ADDED AGAIN, and this is the check
		// that makes repeated calls free rather than corrosive: `add` does not
		// deduplicate -- the REGISTRY resolves an identity it already holds, but the
		// container would still build a second fold over the same state and start
		// re-folding the stream into it beside the first. So the identity is computed
		// first and compared against what is held, which is also exactly the question
		// the caller asked ("did my change name a different generation").
		const already = held.container.held().some((fold) => sameIdentity(fold.record, wanted));
		if (already) {
			logger.info(
				`reconfigure: the configuration names {stream: ${wanted.stream}, processor: ${wanted.processor}}, which ` +
					`this deployment already holds, so NOTHING was registered`,
			);
			return {
				outcome: 'unchanged',
				generation: wanted,
				message:
					`this deployment re-read its configuration and it named the generation it is already holding ` +
					`(processor ${wanted.processor}), so nothing was registered and nothing changed. A generation is ` +
					`identified by the processor's DECLARED version hash -- its \`version\` plus its entity declarations and ` +
					`config -- and not by the source text of its handlers, so editing a handler body alone names the same ` +
					`generation. Bump the processor's \`version\` to say that this is a different fold.`,
			};
		}

		try {
			const fold = await held.container.add({
				source,
				stream: providedStreamConfig,
				...parts.generation,
			});
			const registered: GenerationId = {stream: fold.record.stream, processor: fold.record.processor};
			logger.info(
				`reconfigure: registered {stream: ${registered.stream}, processor: ${registered.processor}} BESIDE the ` +
					`generation answering reads, which keeps its own state and goes on answering. Nothing was discarded.`,
			);
			return {outcome: 'registered', generation: registered};
		} catch (err) {
			// A CAP is the refusal that lands here, and it names what to delete. Nothing
			// is left registered: `add` writes the registry record last of the things that
			// can refuse, so a refusal leaves the deployment holding what it held.
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`reconfigure: the generation this configuration names could not be registered`, err);
			return {outcome: 'failed', message};
		}
	};

	return () => {
		const next = queue.then(reread, reread);
		// the QUEUE never carries a rejection forward: `reread` reports its own
		// failures as outcomes, and a caller's own handler is what sees anything else
		queue = next.catch(() => undefined);
		return next;
	};
}

/** Whether two generation identities are the same one. */
function sameIdentity(a: GenerationId, b: GenerationId): boolean {
	return a.stream === b.stream && a.processor === b.processor;
}

/**
 * REFUSE a re-read whose configuration has moved the deployment itself, rather
 * than quietly folding the new thing into the old place.
 *
 * Two inputs decide WHERE rows go and WHAT KEY they carry -- the database and the
 * named indexer -- and neither is re-appliable here: this process registered one
 * name with its server and opened one handle for it, and a re-read adds a
 * generation to THAT deployment. Accepting a changed value and ignoring it would
 * be the one thing this repo's configuration layer forbids by name, and acting on
 * it would mean writing a generation into a database nothing is serving.
 *
 * Every other input a re-read sees is deliberately NOT refused, because none of
 * them is silently dropped: the node URL, the request rate and the port belong to
 * the fetcher and the server this process already started, which a re-read does
 * not rebuild and does not claim to. Restarting is how those move.
 */
function refuseAMovedDeployment<ABI extends Abi, ProcessResultType>(
	resolved: RunConfig<ABI>,
	held: ReconfigureContext<ABI, ProcessResultType>,
): ReconfigureReport | undefined {
	if (resolved.indexer !== held.indexer) {
		return {
			outcome: 'failed',
			message:
				`this configuration names the indexer ${JSON.stringify(resolved.indexer)} and this process is serving ` +
				`${JSON.stringify(held.indexer)}. A named indexer is the unit a deployment registers and every stored row ` +
				`is keyed on, so it cannot be moved by a re-read: nothing was registered. Restart to serve the other name.`,
		};
	}
	if (resolved.destination.db !== held.dbUrl) {
		return {
			outcome: 'failed',
			message:
				`this configuration names the database ${JSON.stringify(resolved.destination.db)} and this process folds ` +
				`into ${JSON.stringify(held.dbUrl)}. A re-read adds a generation to the deployment that is RUNNING, and a ` +
				`generation written into a database this process is not serving would answer nobody's reads: nothing was ` +
				`registered. Restart to fold into the other database.`,
		};
	}
	return undefined;
}
