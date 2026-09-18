import {
	SERVER_GENERATION_CAPS,
	generationDigestOf,
	openReceivingIndexer,
	processorCodeFingerprint,
	type Abi,
	type EventProcessor,
	type GenerationId,
	type IndexingSource,
	type PromotionConfig,
	type ProvidedStreamConfig,
	type ReceivedGenerationSpec,
	type ReceivingIndexer,
	type StreamBuilder,
} from '@etherfold/core';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {streamConfigFromEnv, type EnvRecord} from '@etherfold/fetcher-host';
import {
	openForWriting,
	type EntityProcessor,
	type StateStore,
	type WritableStateStore,
} from '@etherfold/processor-entities';
import type {StatusReport} from '@etherfold/server';
// TYPE ONLY, so that naming the store this module builds costs no eager import of
// libSQL: the value arrives through the dynamic import below.
import type {VersionedStateStore as SQLiteStateStore} from '@etherfold/state-store-sqlite';
import {loadContracts, resolveSource, type ProcessorModule} from '@etherfold/utils';
import type {RemoteSQL} from 'remote-sql';
import {readStatusReport} from './cursorReport.js';
import {reorgRecorderFor} from './reorgCounters.js';
import type {ExplicitSource, SourceOrigin, StoreTarget} from './types.js';

// ---------------------------------------------------------------------------------------------------
// THE FOLDING ASSEMBLY EVERY COMMAND THAT OWNS A DATABASE SHARES
// ---------------------------------------------------------------------------------------------------
// Three of the five commands fold: `run` and `build` fetch what they fold,
// `index` receives it. What differs between them is where the batches come
// FROM -- a `LogFetcher` on this side of a direct in-process wire, or a sender
// on the other side of an HTTP one -- and what is IDENTICAL is everything below
// the stream-builder: one stream configuration, one database handle, one
// GENERATION CONTAINER over it, and the two ports that write what a fold
// concluded. So it lives here rather than in any one command's module, which is
// the file-level form of "no component is implemented twice".
//
// ## What the three commands hold is a CONTAINER, not a receiver
//
// They used to hold a bare `StreamBuilder` over one un-namespaced store, which
// meant a changed context reached `processor.clear()`: the state the deployment
// answered from was DISCARDED and it served progressively less until it had
// caught up. `ReceivingIndexer` (`@etherfold/core`) is the chain-free generation
// container that removes that outage, and this is where the CLI supplies the
// three things that container deliberately cannot have, because
// `@etherfold/core` knows no database:
//
//   the REGISTRY SUBSTRATE  rows in `_generations` / `_generation_slots`
//                           (`generationRegistryPortOnSQL`, ADR-0054), so a
//                           restart comes back holding what it held and
//                           pointing where it last pointed;
//   the STATE NAMESPACE     a generation's state is a TABLE-NAME NAMESPACE
//                           inside the one database (ADR-0053), named from the
//                           generation identity, which is computable BEFORE the
//                           processor exists;
//   the STREAM's two ends   `emissionAppenderFor` to store what the WRITER of a
//                           stream folded (ADR-0052) and
//                           `storedEmissionReplaySource` to re-fold it, which is
//                           what makes a processor upgrade cost a local scan.
//
// The commands then differ in EXECUTION and in nothing else: `run` follows the
// tip and serves, `build` stops at the tip and exits holding exactly ONE
// generation, `index` is fed over the wire. Their databases are comparable
// generation for generation, which is what
// `packages/cli/test/equivalence.test.ts` asserts over one fixture chain.
// ---------------------------------------------------------------------------------------------------

/**
 * The stream configuration every command indexes under, DERIVED ONCE from the
 * environment and handed to both halves.
 *
 * The RESOLVED object is hashed into the wire identity, so a sending
 * `LogFetcher` and a receiving `StreamBuilder` must reach the same `finality`
 * from the same input. Its resolved form is also what the entity store's
 * retention floor is checked against, which is why nothing here writes a
 * finality number of its own.
 *
 * ## Why this is a function of the environment and not a constant
 *
 * It was `const STREAM_CONFIG = {}`, on the reasoning that an empty config makes
 * both halves take the same default. That held only while nothing else fed the
 * config. The fetcher host reads the stream settings from the environment
 * (`STREAM_FINALITY`) and merged the caller's
 * override OVER it -- and a spread of `{}` cannot remove a key the
 * environment has already put there. So the sender resolved `STREAM_FINALITY` and the receiver resolved
 * the default, the two digests could never match, and `run` and `build` refused
 * to start on any host that set the documented variable.
 *
 * Deriving here fixes it in the direction that keeps the variable WORKING: both
 * halves honour it, rather than agreeing by both ignoring it, which would have
 * satisfied the hash while silently discarding a documented setting (and this
 * repo's rule is that nothing is accepted and ignored). It also means the
 * combined shape and the split shape read one environment the same way.
 */
export function streamConfigFor(env: EnvRecord): ProvidedStreamConfig {
	return streamConfigFromEnv(env);
}

/**
 * Turn a source ORIGIN a chain-free command resolved into the source itself.
 *
 * Two arms and no third, which is the type talking: the module route is the only
 * one that can cost an `eth_chainId` call, so a command that makes no chain call
 * has already refused it by name (`requireExplicitSource`). Both `fetch` (no
 * processor module to read a source out of) and `index` (no node to ask) land
 * here, for different reasons and on the same two arms.
 */
export async function openExplicitSource<ABI extends Abi>(origin: ExplicitSource<ABI>): Promise<IndexingSource<ABI>> {
	switch (origin.from) {
		case 'deployments':
			return loadContracts<ABI>(origin.folder);
		case 'INDEXING_SOURCE':
			return origin.source;
	}
}

/**
 * Turn a resolved source ORIGIN into the source itself, all three arms.
 *
 * The origin was decided from the flags and the environment alone; this is where
 * the side effect it names actually happens, and the three arms are deliberately
 * not equivalent. Both explicit arms are CHAIN-FREE, which is what lets `index`
 * -- the receiving half, which makes no chain call at all -- resolve a source as
 * a first-class case rather than as a special case bolted on. The module arm is
 * the only one that may cost an `eth_chainId` call, and it is the only one a
 * chain-free caller is refused (`requireExplicitSource`).
 *
 * It lives HERE, beside the fold it feeds, because it is run TWICE against one
 * deployment: once when the process assembles (`prepareIndexing`), and again
 * whenever that process is asked to RE-READ its configuration
 * (`reconfigure.ts`). A source change and a processor change arrive together, so
 * a re-read that reloaded the module and kept the old source would half-apply
 * the author's intent.
 */
export async function openIndexingSource<ABI extends Abi, ProcessResultType>(
	origin: SourceOrigin<ABI>,
	processorModule: ProcessorModule<ABI, ProcessResultType>,
	provider: EIP1193ProviderWithoutEvents,
): Promise<IndexingSource<ABI>> {
	const source =
		origin.from === 'processor-module'
			? await resolveSource<ABI, ProcessResultType>(processorModule, provider as never)
			: await openExplicitSource<ABI>(origin);
	if (!source || !source.contracts) {
		throw new Error(
			`contracts data not found in the processor module, it needs to be provided either as exported field named ` +
				`"contractsData" or as field "contractsDataPerChain" indexed by chainID`,
		);
	}
	return source;
}

/**
 * A fold against a database that carries none of the fixed tables, where the
 * operator has said something else migrates it.
 *
 * REFUSED at start-up rather than discovered on the first batch, because a fold
 * now REGISTERS its generation before it reads or writes anything: the registry
 * and the canonical pointer are ROWS (ADR-0054), so a database without them is
 * one this process cannot hold a generation in at all. Discovered lazily it
 * would be a process reporting itself healthy while every cycle failed; named
 * here it is a refusal that says which two things would fix it.
 *
 * `--no-auto-setup` keeps its exact meaning and is deliberately not overridden:
 * it says somebody else owns this database's migrations, and applying the schema
 * anyway would be this process deciding otherwise on their behalf.
 */
function refuseUnmigratedDatabase(db: string): never {
	throw new Error(
		`${db} does not carry the fixed-table schema, and --no-auto-setup says something else migrates it. This ` +
			`command folds under a GENERATION, and a generation is REGISTERED before anything is read or written -- as ` +
			`rows in the registry and the canonical pointer (ADR-0053/ADR-0054) -- so there is nothing here to register ` +
			`it in. Migrate the database first (\`POST /admin/setup\` on a server that already answers it, or ` +
			`\`applySchema\` from @etherfold/server), or drop --no-auto-setup and let this process apply the schema it ` +
			`needs.`,
	);
}

/**
 * Open the ONE database handle this command folds into, with the fixed tables in
 * place.
 *
 * Separate from `openFolding` below, and BEFORE it, because the order is part of
 * the contract: a database this command cannot open, or one it may not migrate,
 * is refused before the source is resolved -- which is the first thing that can
 * touch the chain. What it can no longer come before is the STORE, because a
 * generation's tables are named from the stream digest and that is a function of
 * the source (ADR-0053).
 *
 * The handle is returned rather than kept, because a command that also serves
 * hands this SAME object to the server (`platforms/nodejs`'s `StartOptions.db`
 * takes one): the store and the read surface then see one database rather than
 * two connections with two views of it -- against `:memory:` they would not even
 * be the same database.
 *
 * The imports are dynamic so that a command which never opens a database does
 * not pay for libSQL, matching how `serve` keeps the server's dependency tree
 * off `build`.
 */
export async function openFoldingDatabase(
	target: StoreTarget,
	options: {
		createDB?: (url: string) => RemoteSQL;
		/**
		 * Create the fixed tables (`_meta`, `_emissions`, the generation registry) if
		 * they are absent.
		 *
		 * `build` passes `true` unconditionally: the one-shot binds no port, so nothing
		 * else in that process ever would, and a database it emitted is a publishable
		 * ARTIFACT that must carry its schema version, the reverts it concluded and the
		 * generation it folded under. `run` and `index` pass what `--no-auto-setup`
		 * said, and a `false` against a database that has not been migrated is a
		 * refusal (see `refuseUnmigratedDatabase`) rather than a slow failure.
		 */
		applyFixedSchema: boolean;
	},
): Promise<RemoteSQL> {
	const [{createNodeDB, ensureFixedSchema}, {readSchemaState}] = await Promise.all([
		import('@etherfold/platform-nodejs'),
		import('@etherfold/server'),
	]);
	const handle = options.createDB ? options.createDB(target.db) : createNodeDB(target.db);
	if (options.applyFixedSchema) {
		await ensureFixedSchema(handle, target.db);
	} else if (!(await readSchemaState(handle)).applied) {
		refuseUnmigratedDatabase(target.db);
	}
	return handle;
}

/**
 * ONE DECLARED PROCESSOR, as this deployment's database folds it: the state its
 * generations land in, the identity it is FILED under, and the two factories a
 * container builds a fold from.
 *
 * Built by `foldPartsFor` and named as a type because it is assembled TWICE over
 * one running deployment: once by `openFolding` for the fold a process comes up
 * with, and again by a RE-READ for the processor that has just been rebuilt
 * (`reconfigure.ts`). The successor has to land in the same database, under the
 * same namespacing convention and with the same retention and finality, or it
 * would not be the same deployment reconfigured -- so the assembly exists once
 * and both callers ask for it rather than each spelling it out.
 */
export type FoldParts<ABI extends Abi, ProcessResultType = unknown> = {
	/**
	 * ONE generation's state, by identity: its entity tables, `_blocks` and
	 * `_cursor` under the namespace that identity names (ADR-0053). NOT claimed --
	 * the claim is taken by `generation.createState`, and this bare form is what a
	 * DROP is performed through.
	 */
	stateFor(id: GenerationId): SQLiteStateStore;
	/**
	 * The processor half of the generation identity this declaration WILL have,
	 * computable before the processor exists (ADR-0053).
	 *
	 * WHERE IT CAME FROM is the ARRIVAL's business and not this module's
	 * (ADR-0086). A deployment whose `--processor` path named a self-contained
	 * BUNDLE is identified by the SHA-256 of those bytes, which the arrival supplied
	 * and which no author can state or fail to state. A deployment whose path named
	 * an unbundled module has no bytes that describe it, so it keeps the
	 * author-DECLARED identity `EntityEventProcessor.getVersionHash()` answers with
	 * (`version` plus a hash of the entity declarations and the config) -- unchanged,
	 * because four migrate batches and a contract task are still to land.
	 *
	 * Renamed from `versionHash`, which now describes only one of the two: a field
	 * whose name says DECLARED VERSION while it holds a hash of bytes is the kind of
	 * quiet re-meaning that costs a reader an afternoon.
	 *
	 * It is a string the registry compares for equality and renders into messages.
	 * NOTHING reads it to work out which arrival produced it, which is exactly what
	 * lets two derivations coexist through the migration and after it.
	 */
	processorIdentity: string;
	/**
	 * The ADVISORY second opinion this declaration answers with: a digest of the
	 * HANDLER SOURCE, and the very value `EntityEventProcessor.getCodeFingerprint()`
	 * returns -- taken here, from the same declared object, for the reason
	 * `processorIdentity` is (one formula, one spelling).
	 *
	 * `undefined` is a real answer and means "cannot tell", never "unchanged": a
	 * processor whose handlers are all bound or proxied has no readable source.
	 *
	 * It is NOT part of any identity and nothing branches on it. It exists so that a
	 * RE-READ can say whether the module it just imported differs from the fold this
	 * process is running (`reconfigure.ts`), which is the question a developer who
	 * saved a file is actually asking and the one a DECLARED identity cannot answer.
	 * A deployment folding a BUNDLE has no such question -- its identity moves with
	 * every edit -- so this is the declared path's affordance and goes with it.
	 */
	codeFingerprint: string | undefined;
	/**
	 * The two factories, in ADR-0043's order: state FIRST, then the fold over it --
	 * plus the IDENTITY they are both built under, stated rather than left to be asked
	 * for.
	 *
	 * The identity is on the SPEC because the container is HANDED one and never asks
	 * where it came from (ADR-0086). Left off, `processorIdentityOf` falls back on
	 * `EventProcessor.getVersionHash()`, which answers the same string today on both
	 * arrivals -- a bundle's fold was constructed with it, and a declared one computes
	 * it through the very function `processorIdentity` above calls -- but which is a
	 * question a processor built from bytes cannot answer, and a method this family
	 * removes. So it is `processorIdentity` above, restated nowhere: ONE value reaching
	 * the table namespace, the fold and the registry record, which is what stops any
	 * two of them spelling it differently.
	 */
	generation: Pick<
		ReceivedGenerationSpec<ABI, ProcessResultType, WritableStateStore>,
		'createState' | 'createProcessor' | 'processorIdentity'
	>;
};

/**
 * Build the fold parts above for ONE declared processor over ONE database.
 *
 * ## Why the state factory can name its namespace up front
 *
 * A generation is `{stream digest, fold identity}`, the digest is a function of
 * the source and the stream config, and the fold half is a value this function
 * ALREADY HOLDS -- so the namespace is computable BEFORE the processor exists
 * (ADR-0053) and the state-then-processor build order (ADR-0043) still holds.
 *
 * It holds it either way, which is what keeps that true across both arrivals
 * (ADR-0086). Where the arrival derived one, it was handed in as `identity` and
 * is passed unchanged to the namespace, to the fold and to the registry. Where it
 * did not -- an unbundled module, which has no bytes that describe it --
 * `entityProcessorVersionHash` is the very function
 * `EntityEventProcessor.getVersionHash()` answers with, so the two cannot
 * diverge. Either way the identity the container OBSERVES afterwards is the one
 * the tables were named from.
 *
 * The imports are dynamic so that a command which never opens a database does not
 * pay for libSQL, matching how `serve` keeps the server's dependency tree off
 * `build`.
 */
export async function foldPartsFor<ABI extends Abi, ProcessResultType>(
	declared: EntityProcessor<ABI, any>,
	target: StoreTarget,
	db: RemoteSQL,
	/** The stream's own resolved finality, which the retention window is validated against. */
	finalityDepth: number,
	/**
	 * The identity the ARRIVAL derived, where it derived one: the SHA-256 of the
	 * bundle this deployment was configured with (ADR-0086).
	 *
	 * ABSENT is a real answer and means the path named an unbundled module, which has
	 * no bytes that describe it -- so the identity falls back to the author's own
	 * declaration, exactly as it always did. It is deliberately an OVERRIDE of the
	 * declared value rather than a special case of it: the two derivations are peers
	 * and the contract task removes the declared one, at which point this parameter
	 * stops being optional rather than the branch changing shape.
	 */
	identity?: string,
): Promise<FoldParts<ABI, ProcessResultType>> {
	const [{EntityEventProcessor, entityProcessorVersionHash}, {VersionedStateStore}] = await Promise.all([
		import('@etherfold/processor-entities'),
		import('@etherfold/state-store-sqlite'),
	]);

	/**
	 * ONE generation's state: the entity tables, `_blocks` and `_cursor` under the
	 * namespace that generation's identity names, in the database every other
	 * generation of this name also lives in (ADR-0053).
	 *
	 * The finality depth is the stream's own, resolved by the caller from
	 * `streamConfigFor`: a retention window is validated against the depth a reorg
	 * can actually reach, and a number written here instead would be a second
	 * opinion about it. It is also the FLOOR a `revert-only` store prunes at
	 * (`retentionFloor`), which is why stating it matters to a deployment that set no
	 * window at all.
	 *
	 * Nothing here prunes, and nothing on the fold's path does: pruning is a call a
	 * host SCHEDULES (ADR-0022), and one inside the index loop would stall whichever
	 * block crossed the threshold. This command set schedules it between cycles and,
	 * on the one-shot, before it exits -- see `pruning.ts`.
	 */
	const stateFor = (id: GenerationId): SQLiteStateStore =>
		new VersionedStateStore(db, declared.entities, {
			tableNamespace: generationDigestOf(id),
			retention: target.retention,
			finalityDepth,
		});
	// the ARRIVAL's identity where there is one, and the author's declaration where
	// there is not. `entityProcessorVersionHash` is not called at all for a bundle:
	// asking a processor built from bytes to state its own version is the question
	// ADR-0086 says it cannot answer.
	const processorIdentity = identity ?? entityProcessorVersionHash(declared);

	return {
		stateFor,
		processorIdentity,
		// The AUTHOR'S OWN OBJECT is fingerprinted, exactly as `EntityEventProcessor`
		// fingerprints it: its `on<Event>` handlers and `handleUnparsedEvent` ARE the
		// logic, and the wrapper around them is this package's code, which no author edit
		// moves.
		codeFingerprint: processorCodeFingerprint(declared),
		generation: {
			// STATED, so the container takes it rather than asking the fold for it: the
			// registry record, the table namespace above and the processor below are then one
			// value handed to three places (ADR-0086).
			processorIdentity,
			// CLAIMED here, which is the ONE place this process takes the store: folding is
			// writing, and the ability to mutate is obtained by claiming (ADR-0077). A
			// second process pointed at this database takes the claim and this one's next
			// mutation is refused whole rather than half-applied (ADR-0075).
			createState: (generation) => openForWriting(stateFor({stream: generation.stream, processor: processorIdentity})),
			// The CLI intentionally constructs the processor with NO factory argument (the
			// server passes its folder); see MEDIUM-3.
			//
			// The fold is HANDED the arrival's identity where there is one, rather than
			// computing one (ADR-0086). That is what keeps ONE answer to "which generation is
			// this" everywhere below: the container registers what the fold answers, the
			// receiver advertises it on the feed, and the stored cursor records it -- so the
			// table namespace named above from `processorIdentity` and the identity the
			// registry files cannot be two different values.
			createProcessor: (state) =>
				new EntityEventProcessor<ABI, any>(state, declared, {
					finalityDepth,
					...(identity === undefined ? {} : {identity}),
				}) as unknown as EventProcessor<ABI, ProcessResultType>,
		},
	};
}

/** Everything a folding command holds over its one database handle. */
export type FoldingAssembly<ABI extends Abi, ProcessResultType = unknown> = {
	/**
	 * THE GENERATIONS THIS NAMED INDEXER HOLDS, and which one answers reads.
	 *
	 * The chain-free container (`@etherfold/core`), over the durable registry this
	 * database carries. It is what a command hands to its server as the entry for
	 * its name and to its `/status` reporter, and it is what a `run` adds a
	 * successor to.
	 */
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>;
	/** The ONE handle every one of them folds into and a server answers over. */
	db: RemoteSQL;
	/** The OPENING fold's store: its own table namespace (ADR-0053), CLAIMED. */
	store: WritableStateStore;
	/** The OPENING fold's processor. */
	processor: EventProcessor<ABI, ProcessResultType>;
	/** The OPENING fold's receiver, which is this process's one live wire context. */
	streamBuilder: StreamBuilder<ABI, ProcessResultType>;
};

/**
 * Open the GENERATION CONTAINER this command folds through: the registry over
 * this database, the fold it comes up holding, and the two ports that put what a
 * fold concluded into the same database.
 *
 * The STATE and the two factories come from `foldPartsFor` above, which is where
 * the namespacing convention and the claim live; this function is what pairs
 * them with the registry substrate and the stream's two ends.
 *
 * ## Why both ports are built HERE
 *
 * Because this is where the store is OWNED, and both durable facts a fold
 * concludes are written by whoever owns the store: the reorg count (ADR-0050)
 * and the stored emission stream (ADR-0052). All three folding commands come
 * through this function, so all three write both, and none of them can bind a
 * port to a different database than the one it folds into. Each used to live on
 * an HTTP route a combined process never touches, so `run` counted nothing and
 * `run` and `build` stored no stream at all.
 *
 * The APPENDER is handed to the container rather than to a receiver, which is
 * what makes the one-writer rule structural: the container gives it to the
 * WRITER of a stream -- the oldest surviving generation registered on it -- and
 * to nothing else, so a successor re-folding a stored stream cannot append a
 * second history (ADR-0044/ADR-0052). Its READ counterpart is handed over beside
 * it, because a fold on a stream this container already holds is a FOLLOWER and
 * catches up by re-folding those same rows.
 *
 * The imports are dynamic for the reason `openFoldingDatabase`'s are.
 */
export async function openFolding<ABI extends Abi, ProcessResultType>(
	declared: EntityProcessor<ABI, any>,
	target: StoreTarget,
	db: RemoteSQL,
	context: {
		/** What this deployment indexes: half of the stream identity, and of the wire's. */
		source: IndexingSource<ABI>;
		/** The stream config, the other half, exactly as both halves of the wire were given it. */
		stream: ProvidedStreamConfig;
		/** The resolved finality depth, which the retention floor is checked against. */
		finalityDepth: number;
		/**
		 * The NAMED INDEXER this deployment folds under, which every stored emission
		 * row and every registry row is keyed on (ADR-0036).
		 *
		 * Required here and defaulted nowhere in this function: WHETHER a command may
		 * default it is a question about the command (`resolveIndexerName` for the
		 * combined shapes, `requireIndexerName` for the two halves of the wire), and a
		 * fallback here would be a third answer neither of them could see.
		 */
		indexer: string;
		/**
		 * WHEN the canonical pointer moves onto a successor added beside the live fold,
		 * exactly as this deployment's configuration said it (`resolvePromotion`,
		 * `config.ts`).
		 *
		 * OPTIONAL, and absent means the operator said nothing rather than that they
		 * said `on-catch-up`: the default is filled in ONE place
		 * (`resolvePromotionConfig`, `@etherfold/core`), and handing a value down from
		 * here when none was given would be this module forking a default whose whole
		 * point is that it cannot be forked. Passed through untouched for the same
		 * reason `indexer` is required here: WHETHER a command may take this input is a
		 * question about the command, answered by the resolver.
		 */
		promotion?: PromotionConfig;
		/**
		 * The identity the ARRIVAL derived, where it derived one -- the hash of the
		 * bundle this deployment was configured with (ADR-0086). Passed straight through
		 * to `foldPartsFor`, which documents what absent means.
		 */
		processorIdentity?: string;
	},
): Promise<FoldingAssembly<ABI, ProcessResultType>> {
	const [server, parts] = await Promise.all([
		// the stream's two ends and the registry substrate are the TABLE OWNER's:
		// `@etherfold/server` ships the DDL, both of ADR-0006's views and the seq
		// allocation the writer and the reader have to agree about, so a second copy of
		// any of them here would be a second definition of what a position in that
		// stream means. What this module owns is which DATABASE and which NAME.
		import('@etherfold/server'),
		// the state, the identity and the two factories, built the ONE way this
		// deployment builds them -- so a fold added later by a RE-READ lands in the same
		// database under the same convention (`foldPartsFor`).
		foldPartsFor<ABI, ProcessResultType>(declared, target, db, context.finalityDepth, context.processorIdentity),
	]);
	const {stateFor} = parts;

	const container = await openReceivingIndexer<ABI, ProcessResultType, WritableStateStore>({
		port: server.generationRegistryPortOnSQL(db, context.indexer, {
			// deleting a generation is a DROP of its namespace, which is the whole reason
			// the namespace was chosen over a column (ADR-0053). The registry cannot know
			// that convention and deliberately does not: it is injected by whoever named
			// the tables, which is this function.
			dropState: async (id) => {
				await stateFor(id).drop();
			},
		}),
		// A CLI is a server: the database IS the durable artifact here and the retained
		// generation is what the pointer moves BACK to, so it states the same generous
		// bound a server does rather than a browser tab's two (`SERVER_GENERATION_CAPS`).
		// It is stated rather than defaulted because a cap nobody can see is not a bound;
		// there is deliberately no flag for it, since no command in the set takes one and
		// the number a deployment wants is the one this constant already argues for.
		caps: SERVER_GENERATION_CAPS,
		// WHEN the pointer moves onto a successor, and what happens to the generation
		// left behind. Absent is a real answer and the common one, and the container
		// resolves the default from it.
		...(context.promotion === undefined ? {} : {promotion: context.promotion}),
		source: context.source,
		stream: context.stream,
		recordReorg: reorgRecorderFor(db),
		appendEmissions: server.emissionAppenderFor(db, context.indexer),
		replay: server.storedEmissionReplaySource<ABI>(db, context.indexer),
		generation: parts.generation,
	});

	return {
		container,
		db,
		store: container.state,
		processor: container.processor,
		streamBuilder: container.ingestion,
	};
}

/**
 * WHAT THIS PROCESS TELLS `/status`: one entry per generation it holds, and the
 * canonical one's progress as the top-level value.
 *
 * The four lines a host writes between what it HOLDS and what the reporter reads
 * (ADR-0047), written once here because `run` and `index` hold the same container
 * and must not answer the same question two ways. The shape does not depend on
 * how many generations a deployment happens to hold: a process holding one
 * reports one entry, and the same process mid-upgrade reports two, which is how
 * an operator watches a rebuild advance on the page they already have open.
 *
 * The `state` a fold carries is this module's own `VersionedStateStore` -- the
 * container types it as an opaque parameter precisely so `@etherfold/core` names
 * no storage seam -- so the narrowing is honest exactly here, where the factory
 * that built it is written.
 */
export async function foldingStatusReport<ABI extends Abi, ProcessResultType>(
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>,
): Promise<StatusReport> {
	const canonical = await container.canonical();
	return readStatusReport({
		folds: container.held().map((fold) => ({
			generation: fold.record,
			store: fold.state as StateStore,
			follows: fold.follows,
		})),
		...(canonical ? {canonical} : {}),
	});
}
