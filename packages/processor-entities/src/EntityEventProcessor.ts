import {
	assertProcessorVersion,
	processorCodeFingerprint,
	simple_hash,
	type Abi,
	type EventProcessor,
	type IndexingSource,
	type LastSync,
	type LogEvent,
	type UsedStreamConfig,
} from '@etherfold/core';
import type {PruneOptions, PruneReport, StateStore} from '@etherfold/state-store';
import {logs} from 'named-logs';
import {applyEventStream} from './apply.js';
import {parseStoredCursor, SYNC_CURSOR_KEY} from './cursor.js';
import type {EntityProcessor} from './types.js';
import {EntityStateView} from './view.js';

const logger = logs('@etherfold/processor-entities');

/**
 * What a deployment chooses about HOW the state is kept, as opposed to WHERE
 * (the store it hands over) or WHAT (the processor computes it).
 *
 * One field today, and it is here rather than only on the store because it is
 * checked against something the store never sees: see
 * `assertRetentionCoversReorgs`.
 */
export type EntityEventProcessorOptions = {
	/**
	 * The reorg depth this deployment declared when it configured the store's
	 * retention, in block numbers.
	 *
	 * Optional, and only ever used to catch a disagreement. A deployment that set
	 * no retention window has stated no floor and cannot disagree with one.
	 */
	readonly finalityDepth?: number;
};

/**
 * THE IDENTITY OF A FOLD, computable BEFORE the fold exists.
 *
 * The same value `EntityEventProcessor.getVersionHash()` returns, as a FUNCTION
 * of the things a host already holds -- the declared version, the entity
 * declarations and the processor config -- rather than of a constructed
 * processor over a constructed store.
 *
 * It exists because a **generation**'s state is a TABLE-NAME NAMESPACE named
 * from `{stream digest, processor version hash}` (ADR-0053), and a generation is
 * built STATE FIRST (ADR-0043), so the state factory has to name the namespace
 * before the processor it will fold into exists. ADR-0053 records that this is
 * possible; this is where it is possible FROM.
 *
 * It is ONE formula in ONE place, which is the whole point. ADR-0043 rejected
 * having a caller DECLARE the version hash beside its factory, because a
 * declaration that can silently disagree with `getVersionHash()` keys a store on
 * a lie. Calling the owner's own function is not that: `getVersionHash()` is
 * this, so the two cannot diverge.
 */
export function entityProcessorVersionHash<ABI extends Abi, ProcessorConfig = undefined>(
	processor: EntityProcessor<ABI, ProcessorConfig>,
	config?: ProcessorConfig,
): string {
	return `${processor.version}-${simple_hash({entities: processor.entities, config})}`;
}

/**
 * The `EventProcessor` that runs an `EntityProcessor` against ANY `StateStore`.
 *
 * This is the runtime the seam was built for and the one thing that was missing
 * from it. Everything underneath already named no backend --
 * `MutationContext`, the entity declarations, `runBlockHandlers`,
 * `applyEventStream` -- while the only shipped `EventProcessor` over the seam
 * built its own SQLite store from a `RemoteSQL` and kept its cursor in a SQL
 * table. So "one processor, several backends" was true in the test suite and
 * reachable through no deployment. Here the store is INJECTED, and everything
 * this class does to it is at the seam, so the same processor object indexes to
 * SQLite on a server, to IndexedDB in a browser tab, to the light patch store,
 * or to memory in a test, with nothing about the processor changed.
 *
 * ```ts
 * const store = await createBrowserStateStore(myProcessor.entities);   // browser
 * const store = new VersionedStateStore(db, myProcessor.entities);     // server
 * const processor = new EntityEventProcessor(store, myProcessor);
 * ```
 *
 * ## Revert is replay-free, and that is ADR-0001's revisit condition arriving
 *
 * The retired in-memory path (a free-form object plus a patch `History`) undid a reorg with
 * immer reverse-patches, because reverting by replay needs the state as of the
 * fork block and the in-browser path had no way to get it. ADR-0001 records that
 * choice and names the condition that would justify revisiting it: a store that
 * can answer "state as of block N". A versioned `StateStore` is that store, and
 * `revertTo(keepUpTo)` is neither replay nor an undo log, because the history IS
 * the storage model. A backend that keeps a patch log instead
 * (`@etherfold/state-store-patch`) implements the same verb its own way, which
 * is precisely what the seam is for.
 *
 * ## Where the cursor lives
 *
 * In the store, as an opaque string, written in the same transaction as the
 * block it describes. That is not filing: a cursor kept anywhere else is a
 * second round trip after the block, and a crash in that window leaves state
 * ahead of the cursor, which no restart clears. See `cursor.ts` here for what
 * the string means and `cursor.ts` at the seam for why the store owns it.
 *
 * ## What this is NOT
 *
 * Not a second implementation of anything. `VersionedStateEventProcessor` in
 * `@etherfold/processor-sqlite` is now a thin wrapper over this class that
 * builds the store from a `RemoteSQL` and hands back the SQL-tier read handle;
 * revert-then-apply exists once, here, which is the drift this whole seam exists
 * to prevent.
 */
export class EntityEventProcessor<ABI extends Abi, ProcessorConfig = undefined> implements EventProcessor<
	ABI,
	EntityStateView
> {
	private readonly view: EntityStateView;
	private config: ProcessorConfig | undefined;
	/** Kept for the context a future rebuild/upgrade path will need; not read on the hot path. */
	protected source: IndexingSource<ABI> | undefined;
	private finality: number | undefined;
	private migrated = false;

	constructor(
		protected readonly store: StateStore,
		private readonly processor: EntityProcessor<ABI, ProcessorConfig>,
		private readonly options: EntityEventProcessorOptions = {},
	) {
		// Refused at construction, not at load: a version-less processor's hash is a
		// constant, and a constant invalidates nothing, ever.
		assertProcessorVersion(processor, 'EntityEventProcessor');
		this.view = new EntityStateView(store);
	}

	/** The read handle, also what `load` and `process` hand back. */
	get state(): EntityStateView {
		return this.view;
	}

	/**
	 * Enforce the configured retention against the storage: drop the versions it
	 * no longer covers.
	 *
	 * It lives HERE and not on `state` because it is a WRITE, and the view is
	 * read-only for the reason recorded on it: a UI callback holding a handle that
	 * can delete versions is a corruption waiting to happen. The processor is the
	 * writer, so scheduling a prune is scheduling one more thing the writer does.
	 *
	 * It is a call a deployment makes rather than something `process` does on its
	 * own, and that placement is deliberate: pruning costs time proportional to
	 * what it drops (1.1 s at 62,553 versions, measured in
	 * `work/notes/findings/sqlite-in-the-browser.md`), so a prune inside `process`
	 * would stall whichever block crossed a threshold. See `StateStore.prune` for
	 * the whole reasoning and for `maxVersions`, which is how an amortised policy
	 * is expressed. Call it BETWEEN `process` calls: it is a write, and this
	 * processor has one writer.
	 *
	 * On the default (`unbounded`) retention it is a no-op, so a host may schedule
	 * it unconditionally.
	 */
	async prune(options?: PruneOptions): Promise<PruneReport> {
		await this.ensureMigrated();
		return this.store.prune(options);
	}

	/**
	 * Identity of the processor's LOGIC, which is what invalidates stored state.
	 *
	 * The entity declarations are hashed in alongside the version, unlike the
	 * in-memory path which hashes only `version` and config. Here the schema is
	 * part of the state's meaning: renaming a field or changing its type makes
	 * previously written rows mean something else, and a stale `version` string
	 * would let the core adopt them. The core compares this against the stored
	 * cursor's `context.processor` and clears on a mismatch.
	 *
	 * The BACKEND is deliberately not in it. The same declarations on SQLite and
	 * on IndexedDB are the same state, which is the whole claim this class makes;
	 * hashing the store in would discard state for moving a deployment.
	 */
	getVersionHash(): string {
		// through the exported function rather than beside it: a host names this
		// generation's table namespace from the same value before this object exists
		// (`entityProcessorVersionHash`, ADR-0053), and two spellings of one formula is
		// how a namespace comes to be keyed on a hash the fold does not have.
		return entityProcessorVersionHash(this.processor, this.config);
	}

	/**
	 * Advisory; see `EventProcessor.getCodeFingerprint`.
	 *
	 * The entity declarations are already in the version hash, and this covers
	 * what they cannot: the handlers. A schema change here invalidates state on
	 * its own; a handler change is invisible to every hash the author controls,
	 * which is exactly the gap this fills. Taken from the author's object, whose
	 * `on<Event>` functions and `handleUnparsedEvent` are the logic.
	 */
	getCodeFingerprint(): string | undefined {
		return processorCodeFingerprint(this.processor);
	}

	configure(config: ProcessorConfig): void {
		this.config = config;
	}

	async load(
		source: IndexingSource<ABI>,
		streamConfig: UsedStreamConfig,
	): Promise<{state: EntityStateView; lastSync: LastSync<ABI>} | undefined> {
		this.source = source;
		this.finality = streamConfig.finality;
		this.assertRetentionCoversReorgs(streamConfig.finality);

		// No stream-config gate on the time axis here, on purpose, and there is no
		// longer a flag that could be one (ADR-0073): every node implementing
		// execution-apis#639 puts `blockTimestamp` on the log itself, so the engine
		// reads it and never pays a round trip per block for it. The check that
		// matters is per-block, in `blockPointer`: it cannot be known in advance
		// whether a node supplied timestamps, but a block still cannot be recorded
		// without one, and the failure lands on the FIRST block, before anything is
		// written.
		await this.ensureMigrated();

		const lastSync = parseStoredCursor<ABI>(await this.store.readCursor(SYNC_CURSOR_KEY));
		if (!lastSync) return undefined;
		// Returned even when the context does not match: the core's discard path
		// (which is what calls `clear()`) only runs when `load` returns something.
		// See the note on `SYNC_CURSOR_KEY`.
		return {state: this.view, lastSync};
	}

	/**
	 * Apply a stream, reverting first if any of it is a retraction, and move the
	 * cursor WITH the blocks that caused it.
	 *
	 * All of it is `applyEventStream`, at the seam: revert ONCE at the fork point,
	 * group by block hash, run the handlers with read-your-writes, apply each
	 * block as one atomic unit, and hand each `applyBlock` the cursor that
	 * describes that block. None of it is SQL and none of it is duplicated per
	 * backend; the reasoning lives on `applyEventStream` and on `cursor.ts`.
	 *
	 * There is nothing left here, and that is the point: the cursor used to be the
	 * half this shell owned, written as a second round trip after the last block,
	 * and that second round trip was a live defect.
	 */
	async process(eventStream: LogEvent<ABI>[], lastSync: LastSync<ABI>): Promise<EntityStateView> {
		if (this.finality === undefined) {
			throw new Error(`finality not set: load() must be called before process()`);
		}
		await this.ensureMigrated();

		await applyEventStream(this.store, this.processor, eventStream, this.config as ProcessorConfig, {
			key: SYNC_CURSOR_KEY,
			lastSync,
		});

		return this.view;
	}

	/**
	 * Wipe the state back to empty.
	 *
	 * `revertTo(-1)` is the whole of the state half, through the store's public
	 * API: every version has a lower bound at or above 0, so "drop everything
	 * opened above -1" is "drop everything", and the same call clears the recorded
	 * blocks. The cursor is dropped alongside, because a cursor without the state
	 * it points at would have the core resume into an empty store.
	 *
	 * Two calls rather than one atomic unit, and here that is fine where it was
	 * not for `process`: `reset` is idempotent, so a crash between them is cleared
	 * by running it again, which is exactly what the caller does.
	 */
	async reset(): Promise<void> {
		logger.info(`resetting: wiping entity state and the sync cursor`);
		await this.ensureMigrated();
		await this.store.revertTo(-1);
		await this.store.clearCursor(SYNC_CURSOR_KEY);
	}

	/**
	 * Same as `reset`.
	 *
	 * The retired free-form path distinguished the two because it had two places
	 * to forget: `reset` dropped the object it held, `clear` also asked its
	 * persistence keeper to drop the saved copy. Here there is one place, the
	 * store, so collapsing them is the honest implementation rather than a
	 * shortcut. The
	 * core calls `clear` on a context mismatch and `reset` on a rebuild, and both
	 * mean the same thing to a processor whose state is never anywhere else.
	 */
	async clear(): Promise<void> {
		return this.reset();
	}

	// -- internals -----------------------------------------------------------

	/**
	 * Reconcile the two places the finality depth is stated.
	 *
	 * A retention window is validated by the STORE, at construction, against the
	 * depth the DEPLOYMENT declared, because that is the only number available
	 * before a stream exists. The number that decides how deep a reorg can
	 * actually reach is the stream's, and it arrives here. If the declared floor
	 * is shallower than the stream's finality, the window was validated against
	 * the wrong number: a reorg could reach past the versions retention promised
	 * to keep, and nothing would say so until a deep reorg found out.
	 *
	 * Raised rather than warned, and only ever for a deployment that opted into
	 * retention: the default (`unbounded`) states no floor and cannot disagree
	 * with one.
	 */
	private assertRetentionCoversReorgs(streamFinality: number): void {
		const declared = this.options.finalityDepth;
		if (declared === undefined || declared >= streamFinality) return;
		throw new Error(
			`retention was configured against a finality depth of ${declared}, but this stream runs with a finality of ` +
				`${streamFinality}: a reorg can reach ${streamFinality} blocks back, deeper than the floor the retention ` +
				`window was checked against. Set the processor's finalityDepth to ${streamFinality} or more (and the ` +
				`retention window at or above it).`,
		);
	}

	private async ensureMigrated(): Promise<void> {
		if (this.migrated) return;
		await this.store.migrate();
		this.migrated = true;
	}
}

/**
 * A factory, so each indexer gets its own instance.
 *
 * It takes the STORE, because that is the deployment's choice and the whole
 * point: the same left-hand side, a different store, and the processor is
 * untouched.
 */
export function fromEntityProcessor<ABI extends Abi, ProcessorConfig = undefined>(
	processor: EntityProcessor<ABI, ProcessorConfig> | (() => EntityProcessor<ABI, ProcessorConfig>),
	options: EntityEventProcessorOptions = {},
): (store: StateStore) => EntityEventProcessor<ABI, ProcessorConfig> {
	return (store) =>
		new EntityEventProcessor<ABI, ProcessorConfig>(
			store,
			typeof processor === 'function' ? processor() : processor,
			options,
		);
}
