import {
	MemoryStateStore,
	type BlockPointer,
	type CursorWrite,
	type EntityId,
	type EntityIdPrefix,
	type Listing,
	type Mutation,
	type NormalizedEntity,
	type PruneOptions,
	type PruneReport,
	type RetentionEnforcement,
	type SeamRecordKey,
	type StateStoreBackend,
	type StateStoreCapabilities,
} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {runStateStoreConformance, type StateStoreFactory} from '../src/index.js';

/**
 * The test that makes the suite worth running: backends that LIE go red.
 *
 * A conformance suite nobody has ever seen fail is decoration. Each backend
 * below is a working store with exactly one lie in it, and each lie is a real
 * failure mode rather than an invented one:
 *
 * - `LyingWindowStore` claims a retention window and answers outside it anyway.
 *   That is the capability report becoming fiction, which is the failure the
 *   report exists to prevent.
 * - `AmnesiacStore` claims full history and serves every historical read from
 *   the TIP. It is the worst shape a store can fail in, because every answer is
 *   a plausible number nothing downstream can tell apart from a true one.
 * - `StickyCounterStore` does not undo the state a reverted block wrote, so an
 *   accumulated counter does not come back DOWN. That is the canonical reorg bug
 *   this design exists to make impossible
 *   (`work/notes/findings/sqlite-in-the-browser.md` records the real instance: a
 *   `computedPoints` of 12 going back to 6 on revert), and it is why the reorg
 *   case runs on every backend rather than once.
 * - `PrematureCursorStore` writes the sync cursor and THEN applies the block,
 *   which is a store that leaves the cursor ahead of its own state whenever a
 *   block is refused. It is the shape every backend would drift into by writing
 *   the two halves in the convenient order, and its cost is silent: the next run
 *   resumes past a block nothing ever applied.
 * - `SilentPrunerStore` prunes for real and reports that it never has. It is the
 *   half a new backend forgets, because the read and the record are written in
 *   different places, and forgetting it makes a perfectly healthy deployment
 *   report the one state that is supposed to mean somebody should look.
 * - `EagerEnforcementStore` is the same mistake the other way round: a store
 *   with no floor claiming a pass at one. Nothing is deleted on such a store by
 *   contract, so the claim is about a pass that could not have happened.
 * - `AccommodatingStore` takes a block at any height by REWINDING to make room
 *   for it. It is what a store does when it treats a stale writer's offer as
 *   something to fit in rather than something to refuse, and it is the shape a
 *   backend reaches for the moment the tip rule is inconvenient: every read
 *   afterwards is served from a state assembled out of two positions.
 *
 * Each lie is written as a DECORATOR over the honest store rather than as a
 * subclass overriding one method, because the honest store's refusal is not a
 * method a subclass can forget: it guards `getAsOf` against `this.capabilities`.
 * Wrapping is the only way to build a store whose report and whose behaviour
 * genuinely disagree, which is exactly the backend this suite has to catch.
 *
 * The suite runs through `runStateStoreConformance`, a plain function over the
 * case list rather than a test runner, so a failure here is a value to assert on
 * instead of a red run to interpret.
 */

const honest: StateStoreFactory = (declarations) => new MemoryStateStore(declarations);

/** Names of the cases that failed, as `group > name`, for readable assertions. */
async function failedCases(factory: StateStoreFactory): Promise<string[]> {
	const result = await runStateStoreConformance(factory);
	return result.failures.map((failure) => `${failure.group} > ${failure.name}`);
}

/** An honest store with one lie bolted on; every verb but the lie is delegated. */
class Decorated implements StateStoreBackend {
	constructor(protected readonly inner: MemoryStateStore) {}

	get capabilities(): StateStoreCapabilities {
		return this.inner.capabilities;
	}

	get declarations(): ReadonlyMap<string, NormalizedEntity> {
		return this.inner.declarations;
	}

	migrate(): Promise<void> {
		return this.inner.migrate();
	}

	applyBlock(block: BlockPointer, mutations?: readonly Mutation[], cursor?: CursorWrite): Promise<void> {
		return this.inner.applyBlock(block, mutations, cursor);
	}

	readCursor(key: string): Promise<string | undefined> {
		return this.inner.readCursor(key);
	}

	writeCursor(key: string, value: string): Promise<void> {
		return this.inner.writeCursor(key, value);
	}

	clearCursor(key: string): Promise<void> {
		return this.inner.clearCursor(key);
	}

	readSeamRecord(key: SeamRecordKey): Promise<string | undefined> {
		return this.inner.readSeamRecord(key);
	}

	writeSeamRecord(key: SeamRecordKey, value: string): Promise<void> {
		return this.inner.writeSeamRecord(key, value);
	}

	clearSeamRecord(key: SeamRecordKey): Promise<void> {
		return this.inner.clearSeamRecord(key);
	}

	prune(options?: PruneOptions): Promise<PruneReport> {
		return this.inner.prune(options);
	}

	readRetentionEnforcement(): Promise<RetentionEnforcement> {
		return this.inner.readRetentionEnforcement();
	}

	getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		return this.inner.getCurrent<T>(entity, id);
	}

	getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: number): Promise<T | undefined> {
		return this.inner.getAsOf<T>(entity, id, at);
	}

	listCurrent<T = Record<string, unknown>>(entity: string, prefix: EntityIdPrefix, limit: number): Promise<Listing<T>> {
		return this.inner.listCurrent<T>(entity, prefix, limit);
	}

	listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		at: number,
		limit: number,
	): Promise<Listing<T>> {
		return this.inner.listAsOf<T>(entity, prefix, at, limit);
	}

	revertTo(keepUpTo: number): Promise<void> {
		return this.inner.revertTo(keepUpTo);
	}
}

/** Claims a 60-block window, and cheerfully answers a read from long before it. */
class LyingWindowStore extends Decorated {
	override get capabilities(): StateStoreCapabilities {
		return {retention: {kind: 'window', blocks: 60}, asOf: true, singleWriter: false};
	}
}

/**
 * Claims it enforces a SINGLE WRITER, and lets any handle write over any other.
 *
 * The honest in-memory store reports `singleWriter: false`, so it is asked no
 * contention case at all -- which is what makes this decorator necessary: a
 * chapter that only ever runs against backends that pass it is decoration. Two
 * of these over ONE `MemoryStateStore` is genuinely two writers on one storage,
 * with nothing between them.
 */
class LyingSingleWriterStore extends Decorated {
	override get capabilities(): StateStoreCapabilities {
		return {...this.inner.capabilities, singleWriter: true};
	}
}

/** Claims full history, and answers every as-of read with the tip value. */
class AmnesiacStore extends Decorated {
	override getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		return this.inner.getCurrent<T>(entity, id);
	}

	// including the SET read: a collection derived from the tip and presented as
	// a historical one is the same lie, one row at a time.
	override listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		_at: number,
		limit: number,
	): Promise<Listing<T>> {
		return this.inner.listCurrent<T>(entity, prefix, limit);
	}
}

/** Accepts the revert and keeps the state: a counter that will not go back down. */
class StickyCounterStore extends Decorated {
	override async revertTo(): Promise<void> {}
}

/**
 * Prunes for real and says it never has.
 *
 * The shape a backend that implemented the READ and forgot the RECORD arrives
 * at, which is easy to reach because the two live in different methods. Its cost
 * is the opposite of loud: a host pruning correctly on every cycle reports the
 * one state that is meant to send somebody looking, so the report stops meaning
 * anything long before anyone notices.
 */
class SilentPrunerStore extends Decorated {
	override async readRetentionEnforcement(): Promise<RetentionEnforcement> {
		return {kind: 'never-pruned', floor: undefined};
	}
}

/** Claims a pass at a floor it does not have: an `unbounded` store reporting `pruned`. */
class EagerEnforcementStore extends Decorated {
	override async readRetentionEnforcement(): Promise<RetentionEnforcement> {
		return {kind: 'pruned', floor: 0, prunedTo: 0};
	}
}

/**
 * Moves the cursor FIRST and applies the block after: honest while everything
 * works, and ahead of its own state the moment a block is refused.
 */
class PrematureCursorStore extends Decorated {
	override async applyBlock(block: BlockPointer, mutations?: readonly Mutation[], cursor?: CursorWrite): Promise<void> {
		if (cursor) await this.inner.writeCursor(cursor.key, cursor.value);
		await this.inner.applyBlock(block, mutations);
	}
}

/**
 * Accepts any height by reverting to just below it first: a store that
 * ACCOMMODATES a writer the tip has passed instead of refusing it.
 *
 * The honest store refuses, and it refuses inside the same atomic unit as the
 * write, so the lie has to be a decorator here as everywhere else in this file.
 * An ascending sequence is untouched by it (the revert is a no-op above the
 * tip), which is exactly why it is a plausible thing to write and why the case
 * that catches it has to exist.
 */
class AccommodatingStore extends Decorated {
	override async applyBlock(block: BlockPointer, mutations?: readonly Mutation[], cursor?: CursorWrite): Promise<void> {
		await this.inner.revertTo(block.number - 1);
		await this.inner.applyBlock(block, mutations, cursor);
	}
}

describe('the conformance suite', () => {
	it('passes an honest backend, so a failure below means something', async () => {
		expect(await failedCases(honest)).toEqual([]);
	});

	it('fails a backend that claims a window it does not honour', async () => {
		const failures = await failedCases((declarations) => new LyingWindowStore(new MemoryStateStore(declarations)));

		expect(failures.length).toBeGreaterThan(0);
		expect(failures.join('\n')).toMatch(/refuses/i);
	});

	it('fails a backend that answers a historical read from the tip', async () => {
		const failures = await failedCases((declarations) => new AmnesiacStore(new MemoryStateStore(declarations)));

		expect(failures.length).toBeGreaterThan(0);
		expect(failures.join('\n')).toMatch(/as of/i);
	});

	it('fails a backend whose revert leaves an accumulated counter where it was', async () => {
		const failures = await failedCases((declarations) => new StickyCounterStore(new MemoryStateStore(declarations)));

		expect(failures.join('\n')).toMatch(/DOWN/);
	});

	it('fails a backend that prunes and reports that it never has', async () => {
		const failures = await failedCases(
			(declarations) =>
				new SilentPrunerStore(new MemoryStateStore(declarations, {retention: {blocks: 64}, finalityDepth: 64})),
		);

		// the cross-check is what catches it: the pass itself reported a floor, so a
		// store saying it has never been pruned is contradicting its own prune.
		expect(failures.join('\n')).toMatch(/agrees with the pass it just ran/);
	});

	it('fails a backend with no floor that claims a pass at one', async () => {
		const failures = await failedCases((declarations) => new EagerEnforcementStore(new MemoryStateStore(declarations)));

		// `unbounded` deletes nothing by contract, so `pruned` there is a claim about
		// a pass that could not have happened.
		expect(failures.join('\n')).toMatch(/never reports a prune that has not happened/);
		expect(failures.join('\n')).toMatch(/keeping everything is not something to enforce/);
	});

	it('fails a backend that rewinds to make room for a block the tip has passed', async () => {
		const failures = await failedCases((declarations) => new AccommodatingStore(new MemoryStateStore(declarations)));

		expect(failures.join('\n')).toMatch(/not above the recorded tip/);
		// and NOT the two halves the same rule has to leave alone: an empty store
		// takes any height, and a revert makes a height applicable again.
		expect(failures.join('\n')).not.toMatch(/EMPTY store admits any height/);
		expect(failures.join('\n')).not.toMatch(/admits a height again once a revert/);
	});

	it('fails a backend whose cursor can end up ahead of the block it describes', async () => {
		const failures = await failedCases((declarations) => new PrematureCursorStore(new MemoryStateStore(declarations)));

		expect(failures.join('\n')).toMatch(/never ahead of the last applied block/);
	});

	it('fails a backend that claims a single writer and lets a second one write', async () => {
		const result = await runStateStoreConformance(
			(declarations) => new LyingSingleWriterStore(new MemoryStateStore(declarations)),
			{
				twoWriters: {
					sharingStorage: (declarations) => {
						// ONE store behind two handles: the shape two tabs of one app have
						const inner = new MemoryStateStore(declarations);
						return [new LyingSingleWriterStore(inner), new LyingSingleWriterStore(inner)];
					},
					addressedApart: (declarations) => [
						new LyingSingleWriterStore(new MemoryStateStore(declarations)),
						new LyingSingleWriterStore(new MemoryStateStore(declarations)),
					],
				},
			},
		);
		const failures = result.failures.map((failure) => `${failure.group} > ${failure.name}`);

		// every refusal case, and NOT the do-not-over-refuse one: a store that
		// refuses nothing passes that half by accident, which is why the chapter
		// asserts both halves.
		expect(failures.join('\n')).toMatch(/refuses the block of a writer whose claim was taken/);
		expect(failures.join('\n')).toMatch(/refuses a cursor write/);
		expect(failures.join('\n')).toMatch(/refuses a revert/);
		expect(failures.join('\n')).toMatch(/refuses a prune/);
		expect(failures.join('\n')).not.toMatch(/ADDRESSED APART/);
	});

	it('fails a backend that claims a single writer and gives the suite no way to test it', async () => {
		// skipping the chapter would be the comfortable thing to do here, and it is
		// exactly how a claim becomes fiction: the cases are selected on the CLAIM,
		// so the missing affordance is the backend author's problem to fix.
		const failures = await failedCases(
			(declarations) => new LyingSingleWriterStore(new MemoryStateStore(declarations)),
		);

		expect(failures.join('\n')).toMatch(/way to open a second handle/);
	});

	it('reports WHY a case failed, and not merely that it did', async () => {
		const result = await runStateStoreConformance(
			(declarations) => new AmnesiacStore(new MemoryStateStore(declarations)),
		);

		expect(result.passed).toBeGreaterThan(0);
		expect(String(result.failures[0]?.error)).toMatch(/expected/i);
	});
});
