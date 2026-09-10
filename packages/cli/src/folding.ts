import {
	SERVER_GENERATION_CAPS,
	generationDigestOf,
	openReceivingIndexer,
	type Abi,
	type EventProcessor,
	type GenerationId,
	type IndexingSource,
	type ProvidedStreamConfig,
	type ReceivingIndexer,
	type StreamBuilder,
} from '@etherfold/core';
import {streamConfigFromEnv, type EnvRecord} from '@etherfold/fetcher-host';
import type {EntityProcessor, StateStore} from '@etherfold/processor-entities';
import type {StatusReport} from '@etherfold/server';
// TYPE ONLY, so that naming the store this module builds costs no eager import of
// libSQL: the value arrives through the dynamic import below.
import type {VersionedStateStore as SQLiteStateStore} from '@etherfold/state-store-sqlite';
import {loadContracts} from '@etherfold/utils';
import type {RemoteSQL} from 'remote-sql';
import {readStatusReport} from './cursorReport.js';
import {reorgRecorderFor} from './reorgCounters.js';
import type {ExplicitSource, StoreTarget} from './types.js';

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
//   the REGISTRY SUBSTRATE  rows in `_generations` / `_generation_pointer`
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
	container: ReceivingIndexer<ABI, ProcessResultType, StateStore>;
	/** The ONE handle every one of them folds into and a server answers over. */
	db: RemoteSQL;
	/** The OPENING fold's store: its own table namespace (ADR-0053). */
	store: StateStore;
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
 * ## Why the state factory can name its namespace up front
 *
 * A generation is `{stream digest, processor version hash}`, the digest is a
 * function of the source and the stream config, and `entityProcessorVersionHash`
 * is the very function `EntityEventProcessor.getVersionHash()` answers with -- so
 * the namespace is computable BEFORE the processor exists (ADR-0053) and the
 * state-then-processor build order (ADR-0043) still holds. The identity the
 * container OBSERVES afterwards, from the processor's own hash, is therefore the
 * one the tables were named from and the two cannot disagree.
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
	},
): Promise<FoldingAssembly<ABI, ProcessResultType>> {
	const [{EntityEventProcessor, entityProcessorVersionHash}, {VersionedStateStore}, server] = await Promise.all([
		import('@etherfold/processor-entities'),
		import('@etherfold/state-store-sqlite'),
		// the stream's two ends and the registry substrate are the TABLE OWNER's:
		// `@etherfold/server` ships the DDL, both of ADR-0006's views and the seq
		// allocation the writer and the reader have to agree about, so a second copy of
		// any of them here would be a second definition of what a position in that
		// stream means. What this module owns is which DATABASE and which NAME.
		import('@etherfold/server'),
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
			finalityDepth: context.finalityDepth,
		});

	const container = await openReceivingIndexer<ABI, ProcessResultType, StateStore>({
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
		source: context.source,
		stream: context.stream,
		recordReorg: reorgRecorderFor(db),
		appendEmissions: server.emissionAppenderFor(db, context.indexer),
		replay: server.storedEmissionReplaySource<ABI>(db, context.indexer),
		generation: {
			createState: (generation) =>
				stateFor({stream: generation.stream, processor: entityProcessorVersionHash(declared)}),
			// The CLI intentionally constructs the processor with NO factory argument (the
			// server passes its folder); see MEDIUM-3.
			createProcessor: (state) =>
				new EntityEventProcessor<ABI, any>(state, declared, {
					finalityDepth: context.finalityDepth,
				}) as unknown as EventProcessor<ABI, ProcessResultType>,
		},
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
	container: ReceivingIndexer<ABI, ProcessResultType, StateStore>,
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
