import type {
	Abi,
	EmissionAppender,
	EventProcessor,
	IndexingSource,
	ProvidedStreamConfig,
	ReorgRecorder,
} from '@etherfold/core';
import {streamConfigFromEnv, type EnvRecord} from '@etherfold/fetcher-host';
import type {EntityProcessor, StateStore} from '@etherfold/processor-entities';
import {loadContracts} from '@etherfold/utils';
import type {RemoteSQL} from 'remote-sql';
import {reorgRecorderFor} from './reorgCounters.js';
import type {ExplicitSource, StoreTarget} from './types.js';

// ---------------------------------------------------------------------------------------------------
// THE FOLDING ASSEMBLY EVERY COMMAND THAT OWNS A DATABASE SHARES
// ---------------------------------------------------------------------------------------------------
// Three of the five commands fold: `run` and `build` fetch what they fold,
// `index` receives it. What differs between them is where the batches come
// FROM -- a `LogFetcher` on this side of a direct in-process wire, or a sender
// on the other side of an HTTP one -- and what is IDENTICAL is everything below
// the stream-builder: one stream configuration, one store, one processor, one
// database handle. So it lives here rather than in any one command's module,
// which is the file-level form of "no component is implemented twice".
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
 * config. The fetcher host reads three settings from the environment
 * (`STREAM_FINALITY`, `STREAM_ALWAYS_FETCH_TIMESTAMPS`,
 * `STREAM_ALWAYS_FETCH_TRANSACTIONS`) and merged the caller's override OVER
 * them -- and a spread of `{}` cannot remove a key the environment has already
 * put there. So the sender resolved `STREAM_FINALITY` and the receiver resolved
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
 * Build the `EventProcessor` a stream-builder drives, plus the store it writes
 * to, the ONE database handle underneath both, and the two PORTS that put what a
 * fold concluded into that database: the recorder that counts a reorg and the
 * appender that stores the emission stream.
 *
 * The handle is returned rather than kept, because a command that also serves
 * hands this SAME object to the server (`platforms/nodejs`'s `StartOptions.db`
 * takes one): the store and the read surface then see one database rather than
 * two connections with two views of it -- against `:memory:` they would not even
 * be the same database.
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
 * The two are not interchangeable and the difference is in the ENGINE rather
 * than here: the count is best-effort, and the append is not (a lost emission is
 * a hole). What this function owes them is the same thing -- the handle, and the
 * NAME the rows are keyed on.
 *
 * The imports are dynamic so that a command which never opens a database does
 * not pay for libSQL, matching how `serve` keeps the server's dependency tree
 * off `build`.
 */
export async function buildProcessor<ABI extends Abi, ProcessResultType>(
	declared: EntityProcessor<ABI, any>,
	target: StoreTarget,
	context: {
		finalityDepth: number;
		/**
		 * The NAMED INDEXER this deployment folds under, which every stored emission
		 * row is keyed on (ADR-0036).
		 *
		 * Required here and defaulted nowhere in this function: WHETHER a command may
		 * default it is a question about the command (`resolveIndexerName` for the
		 * combined shapes, `requireIndexerName` for the two halves of the wire), and a
		 * fallback here would be a third answer neither of them could see.
		 */
		indexer: string;
		createDB?: (url: string) => RemoteSQL;
		/**
		 * Create the fixed tables (`_meta`) if they are absent, rather than leaving it
		 * to whatever binds a port.
		 *
		 * `build` sets it, because the one-shot starts no server and a database it
		 * emitted is a publishable ARTIFACT: without this it would carry neither a
		 * schema version nor a reorg count, and would lose its provenance the moment it
		 * became an INPUT. `run` and `index` leave it alone -- they bind a port, and
		 * `--no-auto-setup` is the operator saying somebody else migrates this
		 * database, which this must not override.
		 */
		applyFixedSchema?: boolean;
	},
): Promise<{
	processor: EventProcessor<ABI, ProcessResultType>;
	store: StateStore;
	db: RemoteSQL;
	recordReorg: ReorgRecorder;
	appendEmissions: EmissionAppender;
}> {
	const [{EntityEventProcessor}, {VersionedStateStore}, {createNodeDB, ensureFixedSchema}, {emissionAppenderFor}] =
		await Promise.all([
			import('@etherfold/processor-entities'),
			import('@etherfold/state-store-sqlite'),
			import('@etherfold/platform-nodejs'),
			// the append is the TABLE OWNER's: `@etherfold/server` ships the DDL, both of
			// ADR-0006's views and the seq allocation the two have to agree about, so a
			// second copy of the write here would be a second definition of what a position
			// in that stream means. What this module owns is which DATABASE and which NAME.
			import('@etherfold/server'),
		]);

	const handle = context.createDB ? context.createDB(target.db) : createNodeDB(target.db);
	if (context.applyFixedSchema) {
		await ensureFixedSchema(handle, target.db);
	}
	// The finality depth is the stream's own, resolved by the caller from
	// `streamConfigFor`: a retention window is validated against the depth a reorg
	// can actually reach, and a number written here instead would be a second
	// opinion about it.
	const store = new VersionedStateStore(handle, declared.entities, {
		retention: target.retention,
		finalityDepth: context.finalityDepth,
	});
	// No cursor of our own: the store holds the rows and the cursor in one
	// transaction, and the stream-builder reads that persisted cursor on every
	// call. Nothing here prunes: pruning is a call a host schedules (ADR-0022), and
	// one inside the index loop would stall whichever block crossed the threshold.
	const processor = new EntityEventProcessor<ABI, any>(store, declared, {
		finalityDepth: context.finalityDepth,
	});
	return {
		processor: processor as unknown as EventProcessor<ABI, ProcessResultType>,
		store,
		db: handle,
		recordReorg: reorgRecorderFor(handle),
		appendEmissions: emissionAppenderFor(handle, context.indexer),
	};
}
