import {
	VersionedStateStore,
	type PruneOptions,
	type PruneReport,
	type VersionedStateStoreOptions,
} from '@etherfold/state-store-sqlite';
import {
	EntityEventProcessor,
	entityProcessorVersionHash,
	openForWriting,
	type EntityProcessor,
} from '@etherfold/processor-entities';
import {
	assertProcessorVersion,
	processorCodeFingerprint,
	type Abi,
	type EventProcessor,
	type IndexingSource,
	type LastSync,
	type LogEvent,
	type UsedStreamConfig,
} from '@etherfold/core';
import type {RemoteSQL} from 'remote-sql';
import {VersionedStateView} from './view.js';

/**
 * Re-exported: the stream shaping is backend-agnostic and now lives at the seam,
 * but this package's public surface has always carried these two.
 */
export {forkPoint, groupByBlock} from '@etherfold/processor-entities';

/**
 * What a deployment chooses about WHERE the state is kept, as opposed to what
 * the processor computes.
 *
 * Retention is the whole of it today, and it is passed straight through to the
 * store, which validates it at construction (a window below the finality depth
 * is refused there, naming both numbers). `finalityDepth` is checked a second
 * time at `load`, against the finality the stream actually runs with; see
 * `EntityEventProcessor`'s `assertRetentionCoversReorgs` for why one number
 * configured in two places has to be reconciled rather than trusted.
 *
 * Setting a window bounds what this state ANSWERS immediately; bounding what it
 * HOLDS is `prune`, which the deployment schedules.
 */
/**
 * What this convenience class passes through to the store it builds for you.
 *
 * `tableNamespace` is here because a generation's state IS a table-name namespace
 * inside one database (ADR-0053), so WITHOUT it two generations built through this
 * class over one handle land on the same tables -- which is the single failure the
 * namespace exists to prevent, and it would fail silently. The `Pick` predates the
 * namespace; the entity-path assembly (`VersionedStateStore` + `EntityEventProcessor`,
 * which is what the CLI folds through) always took it, so this closes the gap
 * between the two ways of building the same thing rather than adding an axis.
 */
export type VersionedStateProcessorOptions = Pick<
	VersionedStateStoreOptions,
	'retention' | 'finalityDepth' | 'tableNamespace'
>;

/**
 * The SQLite flavour of `EntityEventProcessor`: build the store from a
 * `RemoteSQL`, and hand back the SQL-tier read handle.
 *
 * ## What is left of it, and what that says
 *
 * Almost nothing, and that is the point. Revert-then-apply, the block grouping,
 * read-your-writes, the version hash, the code fingerprint, the retention
 * reconciliation and the sync cursor all live once, in
 * `@etherfold/processor-entities`, written against `StateStore` and therefore
 * shared by every backend. Two copies of that logic -- one for SQLite and one
 * for everything else -- is exactly the drift the storage seam exists to
 * prevent, and this class exists to be the convenience it was always doing
 * alongside: `new VersionedStateEventProcessor(db, processor)` instead of
 * building a `VersionedStateStore` and passing it in.
 *
 * ## The two things it genuinely adds
 *
 * **A store from a database handle.** The neutral processor takes a
 * `StateStore`; this takes the `RemoteSQL` a server already has and constructs
 * one, with the deployment's retention validated where it was configured.
 *
 * **The SQL read tier.** `state` is a `VersionedStateView`, which is the seam's
 * four reads PLUS `queryCurrent` / `queryAsOf` (caller-supplied SQL) and block
 * addressing by hash and by time. Those exist here and are absent from
 * `EntityStateView` on purpose: a consumer that needs SQL predicates is told at
 * COMPILE time that a backend-neutral handle cannot give them, instead of by a
 * runtime throw in a browser tab. Choosing this class is choosing that tier.
 *
 * ## Revert is replay-free, and that is ADR-0001's revisit condition arriving
 *
 * The reasoning moved with the code, onto `EntityEventProcessor`. The observable
 * contract is unchanged here, and that is asserted rather than asserted-to:
 * `test/reorg.test.ts` runs the scenarios the retired in-memory path pinned, and
 * expects the same states.
 */
export class VersionedStateEventProcessor<ABI extends Abi, ProcessorConfig = undefined> implements EventProcessor<
	ABI,
	VersionedStateView
> {
	private readonly store: VersionedStateStore;
	private readonly view: VersionedStateView;
	private config: ProcessorConfig | undefined;
	/** The depth the store was configured with, kept for the fold this claims for. */
	private readonly finalityDepth: number | undefined;
	/**
	 * The neutral processor over the CLAIMED store, built on FIRST USE.
	 *
	 * Not in the constructor, because claiming is a WRITE and `openForWriting` is
	 * therefore asynchronous (ADR-0077), while this convenience class is `new`ed
	 * synchronously by every caller it has. Deferring it costs nothing that matters:
	 * the store is one this class BUILT and nothing else holds, so there is no rival
	 * to lose it to in between, and the first operation that could mutate is the
	 * first that needs the claim. It is memoised, so the claim is taken once.
	 *
	 * The claim is still EXPLICIT -- what was removed with the seam's mutating half
	 * is a mutation nobody claimed for, not a claim at a particular line.
	 */
	private folding: Promise<EntityEventProcessor<ABI, ProcessorConfig>> | undefined;

	constructor(
		db: RemoteSQL,
		private readonly processor: EntityProcessor<ABI, ProcessorConfig>,
		options: VersionedStateProcessorOptions = {},
	) {
		// Checked here as well as inside, and NOT because one of them is redundant:
		// the message names the class the caller actually constructed, and a
		// deployment told to fix `EntityEventProcessor` would be looking for a class
		// it never wrote. Refused at construction, not at load: a version-less
		// processor's hash is a constant, and a constant invalidates nothing, ever.
		assertProcessorVersion(processor, 'VersionedStateEventProcessor');
		// The retention setting is validated HERE, by the store, because that is
		// where it was configured: a floor violation belongs at construction and not
		// on the first read it would have answered wrongly.
		this.store = new VersionedStateStore(db, processor.entities, options);
		this.view = new VersionedStateView(this.store);
		this.finalityDepth = options.finalityDepth;
	}

	/**
	 * CLAIM the store this class built, and the fold over it. Memoised.
	 *
	 * The config is re-applied on every call rather than once at build time, so a
	 * `configure` that arrived before the claim and one that arrived after mean the
	 * same thing to the fold. `configure` itself stays synchronous, because
	 * `getVersionHash` is a function of the config and a host reads it before
	 * anything is folded.
	 */
	private async folded(): Promise<EntityEventProcessor<ABI, ProcessorConfig>> {
		this.folding ??= openForWriting(this.store).then(
			(claimed) =>
				new EntityEventProcessor<ABI, ProcessorConfig>(claimed, this.processor, {
					...(this.finalityDepth === undefined ? {} : {finalityDepth: this.finalityDepth}),
				}),
		);
		const fold = await this.folding;
		if (this.config !== undefined) fold.configure(this.config);
		return fold;
	}

	/** The read handle, also what `load` and `process` hand back: the SQL tier. */
	get state(): VersionedStateView {
		return this.view;
	}

	/** See `EntityEventProcessor.prune`: a write, scheduled by the host, never by `process`. */
	async prune(options?: PruneOptions): Promise<PruneReport> {
		return (await this.folded()).prune(options);
	}

	/**
	 * See `EntityEventProcessor.getVersionHash`: the version plus the declarations and
	 * config.
	 *
	 * Through the SHARED function rather than through the fold, because a host reads
	 * this before anything is folded (it names the state's table namespace,
	 * ADR-0053) and `EntityEventProcessor.getVersionHash` is that same function. Two
	 * spellings of one formula is how a namespace comes to be keyed on a hash the
	 * fold does not have; one function called twice is not.
	 */
	getVersionHash(): string {
		return entityProcessorVersionHash(this.processor, this.config);
	}

	/** Advisory; see `EventProcessor.getCodeFingerprint`. Taken from the author's object. */
	getCodeFingerprint(): string | undefined {
		return processorCodeFingerprint(this.processor);
	}

	configure(config: ProcessorConfig): void {
		this.config = config;
	}

	/**
	 * Delegated, with the SQL-tier handle substituted for the neutral one.
	 *
	 * The substitution is the whole difference between the two classes, and it is
	 * two lines rather than a second `load`: what a consumer may ASK the state is
	 * a property of the backend, and everything about GETTING there is not.
	 */
	async load(
		source: IndexingSource<ABI>,
		streamConfig: UsedStreamConfig,
	): Promise<{state: VersionedStateView; lastSync: LastSync<ABI>} | undefined> {
		const loaded = await (await this.folded()).load(source, streamConfig);
		return loaded && {state: this.view, lastSync: loaded.lastSync};
	}

	/**
	 * Delegated. The cursor now rides in the same batch as the block it describes
	 * (`StateStore.applyBlock`'s third argument), which closes the window a
	 * separate `_sync` write used to leave open.
	 */
	async process(eventStream: LogEvent<ABI>[], lastSync: LastSync<ABI>): Promise<VersionedStateView> {
		await (await this.folded()).process(eventStream, lastSync);
		return this.view;
	}

	/** Wipe the state, the history and the cursor. See `EntityEventProcessor.reset`. */
	async reset(): Promise<void> {
		return (await this.folded()).reset();
	}

	/** Same as `reset`, for a store whose state is never anywhere else. */
	async clear(): Promise<void> {
		return (await this.folded()).clear();
	}
}

/** A factory, so each indexer gets its own instance. */
export function fromSQLProcessor<ABI extends Abi, ProcessorConfig = undefined>(
	processor: EntityProcessor<ABI, ProcessorConfig> | (() => EntityProcessor<ABI, ProcessorConfig>),
	options: VersionedStateProcessorOptions = {},
): (db: RemoteSQL) => VersionedStateEventProcessor<ABI, ProcessorConfig> {
	return (db) =>
		new VersionedStateEventProcessor<ABI, ProcessorConfig>(
			db,
			typeof processor === 'function' ? processor() : processor,
			options,
		);
}
