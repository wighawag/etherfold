import {
	resolveStreamConfig,
	streamDigestOf,
	type Abi,
	type GenerationId,
	type IndexingSource,
	type ProvidedStreamConfig,
	type ReceivingIndexer,
} from '@etherfold/core';
import type {EntityProcessor, WritableStateStore} from '@etherfold/processor-entities';
import type {ReconfigureReport} from '@etherfold/server';
import {loadProcessorArtifact} from '@etherfold/utils';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {logs} from 'named-logs';
import type {RemoteSQL} from 'remote-sql';
import {foldPartsFor, openIndexingSource} from './folding.js';
import {arrivalQueue, sameIdentity, type ArrivalQueue} from './arrivalQueue.js';
import type {StoreTarget} from './types.js';

const logger = logs('etherfold');

// ---------------------------------------------------------------------------------------------------
// THE UPLOAD: WHAT `POST /{indexer}/admin/upload` ACTUALLY DOES ON AN `etherfold node`
// ---------------------------------------------------------------------------------------------------
// The RECEIVING half of The Graph's deploy shape (ADR-0085's amendment of
// 2026-09-22): the BYTES of an already-built bundle arrive, and the generation they
// name is registered BESIDE the incumbent. From there everything is existing
// machinery: the incumbent goes on answering, the successor catches up, and the
// promotion policy moves the pointer.
//
// It is served by `etherfold node` ALONE (ADR-0094): `node` RECEIVES its code and is
// configured with none, while `run` is CONFIGURED and receives none. So nothing here
// holds an upload to a source an operator configured: a `node` never has one.
//
// ## Everything that can refuse happens BEFORE `add`
//
// Not "register, then unwind on failure": a refused upload must leave the registry,
// the slots and the held folds EXACTLY as they were, and an unwind is a second
// write that can itself fail half-way. So the whole of the refusable work is done
// first and `add` is reached only with a generation that is going to be registered:
//
//  1. the LOADER (`loadProcessorArtifact`, `@etherfold/utils`) hashes the bytes,
//     refuses a bundle that is not self-contained with the repository's ONE
//     definition of that (`unresolvedImportsOf`, which `readProcessorPath` shares),
//     and refuses one that throws on evaluation or carries no processor -- as DATA;
//  2. the SOURCE the upload carries is resolved through the route a processor
//     module already supplies its contracts by (`resolveSource`), and a module that
//     carries none is refused: an upload ALWAYS carries its own contracts;
//  3. the fold parts are assembled the ONE way this deployment assembles them
//     (`foldPartsFor`), so the successor lands in the same database under the same
//     namespacing, retention and finality.
//
// `add` itself refuses what it refuses (a cap) before its registry write.
//
// ## The IDENTITY is this process's, from the bytes
//
// The loader's hash of the octets received (ADR-0086). Nothing the sender says about
// identity is read, and the route carries nothing it could say it with. The same
// bytes go to `add` beside that identity, so the generation's row KEEPS exactly the
// code that names it (ADR-0092) through the one registration path every Node
// generation takes -- there is no second route to the store.
//
// ## The contracts an upload carries are the ones it is registered on
//
// A source changes LEGITIMATELY, in development and in production -- a new event a
// new handler needs, a contract upgraded with new events (decided by the maintainer
// on 2026-09-26, ADR-0085's relocated decisions). So an upload carrying different
// contracts from the incumbent's registers a successor on its NEW stream, with the
// consequences for the incumbent and the fetcher any new-stream successor has
// (`fetchers.ts`); one carrying the same contracts lands on the stream the incumbent
// is on. The successor is always registered on the UPLOAD's own source, the
// contracts its handlers were written for.
// ---------------------------------------------------------------------------------------------------

/** What a running `node` hands over so that it can receive an upload. */
export type UploadContext<ABI extends Abi = Abi, ProcessResultType = unknown> = {
	/** The chain, for the one step that may cost an `eth_chainId` call: resolving the contracts an upload carries. */
	provider: EIP1193ProviderWithoutEvents;
	/** The ONE handle this process folds into. An upload lands in it and never opens another. */
	db: RemoteSQL;
	/** Where state goes, exactly as this process resolved it at start: the successor lands under the same rules. */
	destination: StoreTarget;
	/**
	 * The stream config this process came up with, AS PROVIDED (`streamConfigFor`), and
	 * what `add` is handed. Taken from the start rather than resolved again: an upload changes
	 * the processor and the contracts it carries, and nothing else about the deployment.
	 */
	stream: ProvidedStreamConfig;
	/** The generations this process holds: what an upload adds to, beside the live fold. */
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>;
	/**
	 * How THIS deployment builds the fold parts of a processor that arrives, where it is
	 * not plain `foldPartsFor`: a `node` notes the entities each arrival declares
	 * (`WaitingFoldingAssembly.foldParts`, ADR-0093). Absent means `foldPartsFor`.
	 */
	foldParts?: typeof foldPartsFor;
};

/**
 * Build the UPLOAD a `node` answers `POST /{indexer}/admin/upload` with.
 *
 * Calls wait in `queue` (`arrivalQueue`), so no two uploads decide "is this identity
 * already held" against one registry at once.
 */
export function uploaderFor<ABI extends Abi, ProcessResultType>(
	held: UploadContext<ABI, ProcessResultType>,
	queue: ArrivalQueue = arrivalQueue(),
): (bundle: Uint8Array) => Promise<ReconfigureReport> {
	const receive = async (bundle: Uint8Array): Promise<ReconfigureReport> => {
		let wanted: GenerationId;
		let source: IndexingSource<ABI>;
		let parts: Awaited<ReturnType<typeof foldPartsFor<ABI, ProcessResultType>>>;
		try {
			// 1. THE BYTES, as data: hashed, checked for self-containment, then evaluated.
			const artifact = await loadProcessorArtifact<ABI, ProcessResultType, EntityProcessor<ABI, any>>(bundle);
			if (artifact.status === 'refused') {
				return refused(
					`the uploaded bundle ${artifact.identity} was refused (${artifact.reason}): ${artifact.why} ` +
						`Nothing was registered.`,
				);
			}
			const streamConfig = resolveStreamConfig(held.stream);
			// 2. THE CONTRACTS IT CARRIES, through the route a processor module already
			// supplies them by. A module that carries none is refused here by the same
			// words a start-up uses.
			source = await openIndexingSource<ABI, ProcessResultType>(
				{from: 'processor-module'},
				artifact.processorModule,
				held.provider,
			);
			// 3. THE FOLD PARTS, the one way this deployment builds them, named by the
			// loader's hash of the bytes and carrying those bytes to the registration.
			parts = await (held.foldParts ?? foldPartsFor)<ABI, ProcessResultType>(
				artifact.processor,
				held.destination,
				held.db,
				streamConfig.finality,
				{identity: artifact.identity, bundle},
			);
			wanted = {stream: streamDigestOf(source, streamConfig), processor: parts.processorIdentity};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`upload: the uploaded bundle could not be prepared, and nothing changed`, err);
			return refused(message);
		}

		// BYTES NAMING A FOLD THIS PROCESS ALREADY HOLDS, where `canonical` or `successor`
		// already names it, change NOTHING, and say so. Every other arrival goes to `add`,
		// which is where what it MEANS is decided: in particular a held generation that
		// `predecessor` names (held only where a revert could not build it again: a promotion
		// stops folding what it superseded wherever it could, ADR-0092's third amendment)
		// is RE-ARMED into `successor` by the registry, with no second fold (ADR-0094). This
		// reads the slot only to answer `unchanged` truthfully; the re-arm is not decided here.
		const slots = await held.container.slots();
		const alreadyWhereItIs =
			(!!slots.canonical && sameIdentity(slots.canonical, wanted)) ||
			(!!slots.successor && sameIdentity(slots.successor, wanted));
		if (alreadyWhereItIs && held.container.held().some((fold) => sameIdentity(fold.record, wanted))) {
			logger.info(
				`upload: the uploaded bytes name {stream: ${wanted.stream}, processor: ${wanted.processor}}, which this ` +
					`deployment already folds, so NOTHING was registered`,
			);
			return {
				arrival: 'upload',
				outcome: 'unchanged',
				generation: wanted,
				message:
					`the uploaded bundle names the generation this deployment is already folding (processor ` +
					`${wanted.processor}), so nothing was registered and nothing changed. A generation is identified by ` +
					`the hash of its bundle's bytes (ADR-0086), and these are the bytes already running here.`,
			};
		}

		try {
			const fold = await held.container.add({source, stream: held.stream, ...parts.generation});
			const registered: GenerationId = {stream: fold.record.stream, processor: fold.record.processor};
			logger.info(
				`upload: registered {stream: ${registered.stream}, processor: ${registered.processor}} BESIDE the ` +
					`generation answering reads, which keeps its own state and goes on answering.`,
			);
			return {arrival: 'upload', outcome: 'registered', generation: registered};
		} catch (err) {
			// A CAP is what lands here, and `add` refuses it before its registry write.
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`upload: the generation the uploaded bundle names could not be registered`, err);
			return refused(message);
		}
	};

	return (bundle) => queue(() => receive(bundle));
}

/** The `failed` arm, named as the upload's. */
function refused(message: string): ReconfigureReport {
	return {arrival: 'upload', outcome: 'failed', message};
}
