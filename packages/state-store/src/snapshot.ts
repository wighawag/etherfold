import {forwardedQueryReads, type QueryReads} from './query-reads.js';
import {assertBlockNumber} from './blocks.js';
import type {Retention, StateStoreCapabilities} from './capabilities.js';
import {
	readSnapshot,
	SnapshotFormatError,
	type SnapshotBlock,
	type SnapshotDocument,
	type SnapshotReader,
} from './snapshot-document.js';
import type {CursorWrite} from './cursor.js';
import type {RetentionEnforcement} from './enforcement.js';
import type {EntityIdPrefix, Listing} from './listing.js';
import type {SeamRecordKey} from './records.js';
import {assertRetained, type PruneOptions, type PruneReport} from './retention.js';
import type {StateStoreBackend} from './store.js';
import type {BlockPointer, EntityId, Mutation, NormalizedEntity} from './types.js';

/**
 * ## Starting from state somebody else computed, without claiming their history
 *
 * A client that replays the chain from the start block pays for every log the
 * contract ever emitted. A client that BOOTSTRAPS downloads the rows another
 * indexer already computed, installs them with the cursor that belongs to them,
 * and carries on from there. The retired free-form path had this from the start
 * (`keepStateOnIndexedDB(name, remote)` plus the CLI's file envelope, both
 * deleted by ADR-0037); this is the same capability where the contents are
 * versioned rows rather than one blob.
 *
 * ## The trap, which is the whole reason this module is careful
 *
 * A snapshot of CURRENT rows carries **no history below the block it was taken
 * at**. Install it into a freshly migrated store and the store will happily go
 * on reporting `unbounded`, because that is true of a store that has been
 * indexing since genesis and it has no way to know it is not one. It would then
 * answer `getAsOf(entity, id, snapshotBlock - 1_000)` with `undefined` -- "the
 * entity was absent then" -- which is an ordinary answer a caller acts on
 * normally, and which is WRONG. That is the plausible-wrong-number failure the
 * retention capability exists to prevent, arriving through a door nobody was
 * watching.
 *
 * So a bootstrapped store's floor comes FROM the snapshot, and it is expressed
 * in the retention vocabulary that already exists rather than in a parallel one:
 * the honest report is a WINDOW whose oldest block is the snapshot's, the
 * refusal below it is `BlockNotRetainedError`, and a store that answers no
 * historical read at all (`revert-only`) is left saying exactly that.
 *
 * ## Why a wrapper and not a verb on every backend
 *
 * The obligation is identical on all of them -- refuse below the floor, report
 * the floor, refuse a revert that reaches under it -- and it is expressible
 * entirely through the seam a backend already implements: a snapshot's blocks
 * install as ordinary `applyBlock`s (the floor's live rows as ONE of them), and
 * the floor persists as one of the seam's own records. Writing it once here means a new backend inherits it rather than
 * rediscovering the trap, which is precisely what the conformance suite asks of
 * it (`snapshot-bootstrap.ts` there runs these properties against every
 * backend).
 *
 * ## What a snapshot contains: rows at a FLOOR, then the blocks above it
 *
 * The document is format 2 (`snapshot-document.ts`, ADR-0095): the rows LIVE at
 * a floor, then the changes of every later block up to the cut. How much history
 * it carries is the producer's option, and the default (`none`) puts the floor at
 * the cut, which is the current-rows snapshot ADR-0028 decided on. The short of it is that history is roughly seven times the
 * current state on the real measured workload (4,072 live rows against 29,393
 * versions, `work/notes/findings/sqlite-in-the-browser.md`) while the whole
 * gzipped event stream is 0.6 MB, so a snapshot carrying full history
 * approaches the cost of just replaying the stream -- and, decisively, a
 * version range is not something the seam can install: a version is what
 * applying a block PRODUCES, and a write surface that could set `_lower` and
 * `_upper` directly could manufacture states no sequence of blocks could reach.
 * Current rows install as one ordinary block, through the verb every backend
 * already has, and so does every block of history above them: replayed, never
 * written as ranges.
 */

/**
 * What is written under the seam's `snapshotOrigin` record: small, versioned,
 * self-describing.
 *
 * It lives in the seam's OWN keyspace (`records.ts`) rather than at the cursor
 * port, and that is not filing. The cursor port is the CALLER's namespace, so a
 * marker kept there was one an app could overwrite by picking the same name for
 * its own cursor -- after which this store goes straight back to claiming
 * history it never received, which is the exact failure this module exists to
 * prevent, arriving through the door the fix opened.
 *
 * It has to be durable at all because the trap comes back on RELOAD otherwise:
 * a floor held only in a JS closure is gone the next time the tab opens.
 *
 * Its `format` is the MARKER's own (`SNAPSHOT_ORIGIN_FORMAT`), not the document's
 * (`ENTITY_SNAPSHOT_FORMAT`). The two used to share one number, which meant a new
 * document format made every store bootstrapped under the previous one refuse to
 * OPEN, though the marker (a block number) had not changed at all.
 */
type SnapshotOrigin = {readonly format: number; readonly block: number};

/** The version of the `snapshotOrigin` marker's own shape. Unrelated to the document format. */
const SNAPSHOT_ORIGIN_FORMAT = 1;

/**
 * A snapshot computed by different logic than the processor about to use it.
 *
 * Refused, never loaded. The rows are a FUNCTION of the processor that produced
 * them, so adopting them under another processor is adopting another
 * program's conclusions: the handlers may have changed what a field means, and
 * the entity declarations may have changed what a row IS. Nothing downstream
 * could tell the resulting state apart from a correct one.
 */
export class SnapshotProcessorMismatchError extends Error {
	readonly name = 'SnapshotProcessorMismatchError';

	constructor(
		/** The identity of the fold that is about to index, as its arrival derived it. */
		readonly expected: string,
		/** The identity the snapshot says computed it. */
		readonly found: string,
		/** The block the snapshot was taken at, so a message can say which one. */
		readonly takenAt: number,
	) {
		super(
			`this snapshot (block ${takenAt}) was computed by processor \`${found}\`, and this deployment runs ` +
				`\`${expected}\`. It is refused rather than loaded: entity rows are the output of the processor that wrote ` +
				`them, so state from another fold is another program's conclusions, and nothing downstream could tell ` +
				`the result apart from a correct state. Publish a snapshot from \`${expected}\`, or index from the start ` +
				`block.`,
		);
	}
}

/**
 * A reorg that reaches below where a bootstrapped store's history begins.
 *
 * **Deliberately NOT a `BlockUnavailableError`**, for the reason
 * `RevertBeyondPatchHistoryError` records at the patch store: that family is
 * about a READ this store cannot answer, and every member of it leaves the
 * caller free to carry on with the tip. This is the write path -- the reorg was
 * NOT undone, so the state is now known to be ahead of the canonical chain and
 * there is nothing to carry on with.
 *
 * ## Why this is a refusal and not something cleverer
 *
 * There is nothing cleverer available. The snapshot IS the oldest state this
 * store has; there are no superseded versions under it to reopen, so a revert
 * below it cannot be performed at any cost. Reverting as far as the rows reach
 * and reporting how far it got would leave a partly-undone reorg, which is a
 * plausible state nothing downstream can tell apart from a correct one.
 *
 * ## And why it should not happen to a well-behaved deployment
 *
 * A snapshot taken at least the finality depth behind the chain tip cannot be
 * reached by a reorg, which is what the finality depth is for. That is the
 * PRODUCER's obligation and a consumer cannot verify it after the fact, so the
 * consumer refuses: `bootstrapFromSnapshot` in `@etherfold/processor-entities`
 * declines a candidate taken inside the reorg-eligible window when it is told
 * the depth, and this error is what catches the case anyway.
 *
 * What a host does with it is re-bootstrap from a newer snapshot, or index from
 * the start block.
 */
export class RevertBeyondSnapshotError extends Error {
	readonly name = 'RevertBeyondSnapshotError';

	constructor(
		/** The block the caller asked to keep up to. */
		readonly keepUpTo: number,
		/** The block this store's contents came from: its oldest state. */
		readonly snapshotOrigin: number,
	) {
		super(
			`cannot revert to block ${keepUpTo}: this store was bootstrapped from a snapshot taken at block ` +
				`${snapshotOrigin} and holds no state below it, so a reorg reaching ${snapshotOrigin - keepUpTo} block` +
				`${snapshotOrigin - keepUpTo === 1 ? '' : 's'} further back cannot be undone. Nothing was changed. ` +
				`Re-bootstrap from a newer snapshot or index from the start block, rather than accept a partly reverted ` +
				`state: a snapshot should be taken at least the finality depth behind the tip precisely so that this ` +
				`cannot arise.`,
		);
	}
}

/**
 * The store handle a deployment that MAY start from a snapshot uses -- on every
 * boot, not only on the one that installs it.
 *
 * It is a thin decorator over any `StateStoreBackend`, and it does exactly three
 * things: it installs a snapshot as one unit, it remembers (durably) which block
 * the contents came from, and it makes every read and every revert respect that
 * floor. A store that was never bootstrapped is a pass-through, reporting
 * whatever the store underneath reports.
 *
 * ```ts
 * const store = await openSnapshotAware(await createBrowserStateStore(processor.entities));
 * // the identity this deployment's ARRIVAL handed its fold (ADR-0086), never a
 * // value the processor was asked for: it is compared for equality and never parsed
 * await store.bootstrap(snapshot, {processor: processorIdentity});
 * ```
 *
 * A host that fetches its snapshot from published mirrors, and that wants "only
 * if this store has never synced" decided for it, uses `openAndBootstrap` in
 * `@etherfold/processor-entities` instead: knowing how far the local store has
 * got means reading `lastToBlock` out of a cursor, and the cursor is an opaque
 * string here on purpose (ADR-0027).
 *
 * ## The tip it measures a window from
 *
 * A window is a distance from the tip, and the seam has no verb that reports
 * one, so this handle tracks the highest block it has seen: the snapshot's when
 * it opens, and each applied block after that. The FLOOR -- the number a caller
 * acts on, and the one a read is refused at -- is exact either way, because it
 * is the snapshot's block and not a distance. What is approximate is the width
 * REPORTED between a reload and the first block applied in that session: a store
 * that indexed a thousand blocks past its snapshot, was reloaded, and has not
 * yet applied a block reports a narrower window than it can actually answer.
 * That is the safe direction (it claims LESS than it holds, never more) and it
 * corrects itself on the first `applyBlock`.
 */
export class SnapshotAwareStateStore implements StateStoreBackend {
	private origin: number | undefined;
	/** The highest block this handle knows about. See the note on the class. */
	private knownTip: number | undefined;
	/**
	 * THE QUERY LAYER'S TWO READS (ADR-0099), present only when the store underneath
	 * has them, detected as `ClaimedStateStore` detects them (`typeof ... ===
	 * 'function'`), so a store without them still gets the query handler's clear
	 * refusal rather than a failure at call time. Neither is part of the seam, and
	 * both are typed loosely for the reason the claimed handle's are: the
	 * accessor's type lives in `@etherfold/accessor`, which depends on this package.
	 *
	 * `accessor` keeps THIS handle's as-of rule, which is the whole reason it is not
	 * a plain forward: every accessor read that carries a block (`at`) is checked
	 * against the NARROWED claim first, with the same `assertReadable` `getAsOf` and
	 * `listAsOf` use, so a block below the snapshot's floor is refused with
	 * `BlockNotRetainedError` and never answered from rows that have no history
	 * below it (ADR-0095, ADR-0028). A tip read (no `at`) goes straight through, and
	 * a store that was never bootstrapped is a pass-through, as its other reads are.
	 * See `floored`.
	 *
	 * `tip` is the store underneath's, unchanged.
	 */
	readonly accessor?: (options?: never) => unknown;
	readonly tip?: QueryReads['tip'];
	/**
	 * The query layer's block reads and revert sequence (`query-reads.ts`), the
	 * store underneath's, unchanged. A hash below the floor needs no refusal here:
	 * an install records no block below it, so none resolves.
	 */
	readonly blockAt?: QueryReads['blockAt'];
	readonly blockOf?: QueryReads['blockOf'];
	readonly revertSequence?: QueryReads['revertSequence'];

	/** Use `openSnapshotAware`, which recovers a previously recorded origin. */
	constructor(
		private readonly inner: StateStoreBackend,
		origin?: number,
	) {
		this.origin = origin;
		this.knownTip = origin;
		const queryable = inner as {accessor?: (options?: never) => unknown};
		if (typeof queryable.accessor === 'function') {
			const accessor = queryable.accessor;
			this.accessor = (options) => this.floored(accessor.call(inner, options));
		}
		Object.assign(this, forwardedQueryReads(inner));
	}

	/** The block this store's contents came from, or `undefined` if it computed them itself. */
	get snapshotOrigin(): number | undefined {
		return this.origin;
	}

	get declarations(): ReadonlyMap<string, NormalizedEntity> {
		return this.inner.declarations;
	}

	/**
	 * What the store underneath claims, narrowed by the history this one never
	 * received.
	 *
	 * Three cases, and the two that pass through are as important as the one that
	 * does not:
	 *
	 * - **Not bootstrapped**: the inner report, untouched. There is no floor to
	 *   impose and imposing one would refuse reads the store can answer.
	 * - **`revert-only`, or no as-of reads at all**: also untouched. A store that
	 *   answers no historical read refuses everywhere already, which is strictly
	 *   stronger than a floor.
	 * - **Otherwise**: a window from the snapshot's block to the tip, intersected
	 *   with whatever the deployment configured. Both are floors on the same
	 *   answer, so the report is the tighter one -- and because both are
	 *   expressed as a distance behind the tip, the intersection is expressible in
	 *   the same vocabulary rather than needing a new retention kind.
	 *
	 * Any extra fields a backend puts on its report (`durability` on the patch
	 * store, for instance) are preserved: this narrows a claim, it does not
	 * replace one.
	 */
	get capabilities(): StateStoreCapabilities {
		const inner = this.inner.capabilities;
		if (this.origin === undefined) return inner;
		if (!inner.asOf || inner.retention.kind === 'revert-only') return inner;

		const tip = this.knownTip ?? this.origin;
		const fromSnapshot = Math.max(0, tip - this.origin);
		const blocks = inner.retention.kind === 'window' ? Math.min(inner.retention.blocks, fromSnapshot) : fromSnapshot;
		const retention: Retention = {kind: 'window', blocks};
		return {...inner, retention};
	}

	async migrate(): Promise<void> {
		return this.inner.migrate();
	}

	/**
	 * Install a snapshot document: check its head, record where its contents came
	 * from, then replay its blocks through `applyBlock`, the cursor riding the LAST.
	 *
	 * ## Streaming, one block at a time
	 *
	 * The document is inflated and parsed as it arrives (`readSnapshot`), and each
	 * block is applied the moment the next one's opening line proves it complete, so
	 * the install holds at most ONE block's mutations and never the document. A
	 * block is one `applyBlock`, which is one atomic unit on every backend, so a
	 * snapshot without history (`none`, the floor at the cut) holds its live rows
	 * once, while they are written: that is intended (ADR-0095), and it is what keeps
	 * installing a replay rather than a new verb on every backend.
	 *
	 * Everything checkable before a write is checked before one: the format and the
	 * processor from the head, and the entity declarations and the floor block from
	 * the first block, which is read in full before the marker goes down. A document
	 * that goes wrong LATER (a download cut short) leaves the marker and whatever
	 * blocks had landed; for a `none` snapshot that is the marker over an empty store,
	 * the recoverable case below, and with history it is the marker over the floor and
	 * some later blocks, which the next install replaces (below).
	 *
	 * ## The order, which is the interesting part
	 *
	 * The origin marker is written BEFORE the rows, and it is a separate write
	 * because the seam carries exactly one cursor slot per `applyBlock` and the
	 * sync cursor has it. So there is a window, and the ordering decides which
	 * way a crash inside it falls:
	 *
	 * - **Marker first** (this): a crash leaves a floor recorded over an EMPTY
	 *   store. The store then claims less history than it has (it will index from
	 *   the start block and refuse as-of reads below the floor anyway), which is
	 *   over-cautious rather than wrong, and running the bootstrap again clears it
	 *   because `applyBlock` never happened.
	 * - **Marker last**: a crash leaves rows and a cursor with NO floor, and the
	 *   store answers historical reads about blocks it has nothing for. That is
	 *   the exact failure this module exists to prevent.
	 *
	 * Same reasoning as the cursor being written last in a store with no
	 * transaction to join: where atomicity is unavailable, the ORDER has to be
	 * the safe one.
	 *
	 * ## Whatever the store held is replaced, never built on
	 *
	 * An install REPLACES the store: once the new document's head and floor have
	 * been checked (so a refused document still changes nothing), the store is
	 * WIPED (`revertTo(-1)`, which drops the rows, the recorded blocks and any
	 * origin marker) and the document's cursor key is cleared, and only then is the
	 * marker written. It is unconditional, because this handle has no verb that says
	 * whether the store holds anything, and a wipe of an empty store is a no-op.
	 * Three stores reach it holding state, and each is wrong to build on:
	 *
	 * - **An interrupted install.** A snapshot that carries history is SEVERAL
	 *   `applyBlock`s, so a download cut short part-way leaves the marker, the floor
	 *   and some later blocks, and no cursor (it rides the last block). That is not
	 *   a complete install and is not treated as one (`openAndBootstrap` finds no
	 *   cursor and bootstraps again), and replaying a document over it would offer
	 *   blocks the store already holds, which every backend refuses.
	 * - **A complete earlier install** a caller chose to replace with a more
	 *   advanced one: laying a floor's live rows over it would keep every row the
	 *   newer snapshot no longer has.
	 * - **A store that computed its own state** and is behind the snapshot
	 *   (`bootstrapFromSnapshot` installs whenever the local cursor is below the
	 *   best candidate). The floor carries only LIVE rows, so a row the chain deleted
	 *   between this store's tip and the floor would survive as a stale row nobody
	 *   reports, and a floor at or below the store's own tip would be refused by
	 *   `applyBlock`. A tab that is behind starts from the snapshot rather than
	 *   catching up from its cursor, because the gap after a long absence is the
	 *   historical `eth_getLogs` range a public node may refuse, which is what a
	 *   snapshot exists to avoid.
	 *
	 * The cursor is cleared BEFORE the rows, for the reason the marker goes down
	 * first: a revert leaves cursors alone (how far the caller got is not entity
	 * state), so without this a replaced store's old cursor would sit over a
	 * partly installed snapshot, and a download cut short would leave a store that
	 * claims to have synced to a block its rows are not the state of. Cleared, an
	 * interrupted install is cursor-less whatever the store held before, which is
	 * the case the next boot already bootstraps again.
	 */
	async bootstrap(
		snapshot: SnapshotDocument | SnapshotReader,
		options: {readonly processor?: string} = {},
	): Promise<void> {
		const reader = isReader(snapshot) ? snapshot : await readSnapshot(snapshot);
		const {head} = reader;
		if (options.processor !== undefined && options.processor !== head.processor) {
			await reader.cancel();
			throw new SnapshotProcessorMismatchError(options.processor, head.processor, head.takenAt.number);
		}
		assertBlockNumber(head.takenAt.number);
		assertBlockNumber(head.floor);

		const blocks = reader.blocks({declarations: this.inner.declarations})[Symbol.asyncIterator]();
		try {
			// the FLOOR, read in full before anything is written: it is where a
			// declaration this store does not have, or a malformed floor, is refused.
			let next = await blocks.next();
			if (next.done) throw new Error(`a snapshot document ended before its floor block`);

			// whatever the store held (a previous install, or state it computed itself)
			// is replaced whole, never built on (see "Whatever the store held" above):
			// the cursor first, so no step leaves an old cursor over new rows
			if (head.cursor) await this.inner.clearCursor(head.cursor.key);
			await this.revertTo(-1);

			const marker: SnapshotOrigin = {format: SNAPSHOT_ORIGIN_FORMAT, block: head.floor};
			await this.inner.writeSeamRecord('snapshotOrigin', JSON.stringify(marker));
			this.origin = head.floor;
			this.knownTip = head.floor;

			while (!next.done) {
				const block: SnapshotBlock = next.value;
				await this.inner.applyBlock(block.block, block.mutations, block.last ? head.cursor : undefined);
				this.knownTip = block.block.number;
				if (block.last) return;
				next = await blocks.next();
			}
		} finally {
			await blocks.return?.();
		}
	}

	async applyBlock(block: BlockPointer, mutations?: readonly Mutation[], cursor?: CursorWrite): Promise<void> {
		await this.inner.applyBlock(block, mutations, cursor);
		if (this.knownTip === undefined || block.number > this.knownTip) this.knownTip = block.number;
	}

	async readCursor(key: string): Promise<string | undefined> {
		return this.inner.readCursor(key);
	}

	async writeCursor(key: string, value: string): Promise<void> {
		return this.inner.writeCursor(key, value);
	}

	async clearCursor(key: string): Promise<void> {
		return this.inner.clearCursor(key);
	}

	async readSeamRecord(key: SeamRecordKey): Promise<string | undefined> {
		return this.inner.readSeamRecord(key);
	}

	async writeSeamRecord(key: SeamRecordKey, value: string): Promise<void> {
		return this.inner.writeSeamRecord(key, value);
	}

	async clearSeamRecord(key: SeamRecordKey): Promise<void> {
		return this.inner.clearSeamRecord(key);
	}

	async prune(options?: PruneOptions): Promise<PruneReport> {
		// Deliberately delegated whole. The floor this handle imposes is never
		// LOWER than the store's own (`retentionFloor` of the narrowed report is
		// the max of the two), so the store can only ever keep more than the
		// report promises, which is the safe direction for a deletion.
		return this.inner.prune(options);
	}

	/**
	 * Delegated whole, and NOT narrowed the way `capabilities` is.
	 *
	 * The two questions are about different things, which is why the same handle
	 * answers them differently. `capabilities` is narrowed because a bootstrapped
	 * store must not CLAIM history it never received. This one is about whether
	 * versions are physically dropped, and the snapshot floor drops nothing: there
	 * is nothing below it to delete, because the snapshot IS the oldest state this
	 * store has. So an `unbounded` store bootstrapped from a snapshot reports a
	 * window here and `no-floor` there, and both are true of it.
	 */
	async readRetentionEnforcement(): Promise<RetentionEnforcement> {
		return this.inner.readRetentionEnforcement();
	}

	async getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		return this.inner.getCurrent<T>(entity, id);
	}

	async listCurrent<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		limit: number,
	): Promise<Listing<T>> {
		return this.inner.listCurrent<T>(entity, prefix, limit);
	}

	async getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: number): Promise<T | undefined> {
		await this.assertReadable(at);
		return this.inner.getAsOf<T>(entity, id, at);
	}

	async listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		at: number,
		limit: number,
	): Promise<Listing<T>> {
		await this.assertReadable(at);
		return this.inner.listAsOf<T>(entity, prefix, at, limit);
	}

	/**
	 * Roll back, unless that would reach under the snapshot.
	 *
	 * A WIPE (`keepUpTo < 0`, which is what `EntityEventProcessor.reset()` calls)
	 * is not a reorg and is not refused: it drops the rows, so there is no
	 * snapshot-derived state left to be honest about, and the floor goes with
	 * them. The store then reports what it was configured to keep, which is true
	 * of it again the moment it is empty.
	 */
	async revertTo(keepUpTo: number): Promise<void> {
		if (keepUpTo < 0) {
			await this.inner.revertTo(keepUpTo);
			await this.inner.clearSeamRecord('snapshotOrigin');
			this.origin = undefined;
			this.knownTip = undefined;
			return;
		}
		if (this.origin !== undefined && keepUpTo < this.origin) {
			throw new RevertBeyondSnapshotError(keepUpTo, this.origin);
		}
		await this.inner.revertTo(keepUpTo);
		if (this.knownTip !== undefined && keepUpTo < this.knownTip) this.knownTip = keepUpTo;
	}

	/**
	 * Refuse a historical read below the floor, in the seam's own words.
	 *
	 * It is `assertRetained` and not a second copy of the comparison, run against
	 * the NARROWED report, so the refusal a caller gets and the claim a caller
	 * reads at startup are computed from one number. A store with no floor is not
	 * asserted here at all: the inner store's own reads already refuse against
	 * its own claim, and asserting the inner claim against THIS handle's idea of
	 * the tip could refuse a read the store can answer.
	 */
	private async assertReadable(at: number): Promise<void> {
		if (this.origin === undefined) return;
		await assertRetained(this.capabilities, at, () => this.knownTip);
	}

	/**
	 * The accessor the store underneath returned, with this handle's floor in front
	 * of every read that carries a block.
	 *
	 * ## How it finds the reads that take a block
	 *
	 * By the SEAM'S CONVENTION rather than by a list of names: every accessor read
	 * takes one query object, and a read as of a block carries it as that object's
	 * `at` (`ReadAt` in `@etherfold/accessor`, shared by `find` and `children`). So
	 * the wrapper is a `Proxy` that, for ANY method, checks the first argument's
	 * `at` when it is present and delegates unchanged when it is not. A method the
	 * accessor gains later is floored the moment it takes a `ReadAt`, with nothing
	 * here to update; a list of names would have answered a new method's historical
	 * reads below the floor, silently, until somebody remembered this file.
	 *
	 * Everything else about the accessor (a property such as the IndexedDB one's
	 * `rowsExaminedBound`) reads through unchanged. The check runs on every call,
	 * not once when the accessor is built, because the floor moves: a wipe clears it
	 * and a later `bootstrap` sets it, and the query handler builds its accessor
	 * once per store.
	 */
	private floored(accessor: unknown): unknown {
		if (typeof accessor !== 'object' || accessor === null) return accessor;
		const assertReadable = (at: number) => this.assertReadable(at);
		return new Proxy(accessor, {
			get(target, key) {
				const value: unknown = Reflect.get(target, key, target);
				if (typeof value !== 'function') return value;
				return (...args: unknown[]): unknown => {
					const query = args[0];
					const at = typeof query === 'object' && query !== null ? (query as {at?: unknown}).at : undefined;
					if (at === undefined) return Reflect.apply(value, target, args);
					return assertReadable(at as number).then(() => Reflect.apply(value, target, args));
				};
			},
		});
	}
}

/**
 * Open a store as one that may have been bootstrapped, recovering its floor.
 *
 * This is the call that has to be on the boot path rather than only on the
 * install path: the snapshot origin is persisted (see `SnapshotOrigin`)
 * precisely so that the SECOND run of an app is as honest as the first, and a
 * handle constructed without reading it back would report `unbounded` over rows
 * whose history begins a million blocks up.
 *
 * It MIGRATES the store on the way, because it has to read from it and a store
 * that has not been migrated has nothing to read from (`migrate` is idempotent
 * on every backend and is meant to be safe on every boot). That also means this
 * is a complete replacement for the `migrate()` a host would otherwise call
 * itself, rather than one more step to remember.
 *
 * A corrupt marker throws rather than being treated as "never bootstrapped".
 * The recovery from a corrupt sync cursor is a fresh sync, which is why THAT one
 * is swallowed; the recovery from a corrupt origin is unknowable, because the
 * rows in the store might have come from anywhere, and the safe reading of "I
 * cannot tell whether this state has history" is not "assume it does".
 */
export async function openSnapshotAware(store: StateStoreBackend): Promise<SnapshotAwareStateStore> {
	await store.migrate();
	const recorded = await store.readSeamRecord('snapshotOrigin');
	if (recorded === undefined) return new SnapshotAwareStateStore(store);

	let origin: SnapshotOrigin;
	try {
		origin = JSON.parse(recorded) as SnapshotOrigin;
	} catch (error) {
		throw new Error(
			`the snapshot origin this store recorded is not readable (${String(error)}). This ` +
				`store's rows may have come from a snapshot, in which case they have no history below it, and treating ` +
				`the marker as absent would have the store claim history it never received. Clear the state and ` +
				`re-bootstrap.`,
		);
	}
	if (origin?.format !== SNAPSHOT_ORIGIN_FORMAT || typeof origin.block !== 'number') {
		throw new SnapshotFormatError(origin?.format, SNAPSHOT_ORIGIN_FORMAT);
	}
	return new SnapshotAwareStateStore(store, origin.block);
}

function isReader(value: SnapshotDocument | SnapshotReader): value is SnapshotReader {
	return typeof (value as SnapshotReader).blocks === 'function' && 'head' in value;
}
