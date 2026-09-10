import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import type {
	BlockPointer,
	CursorWrite,
	EntityId,
	EntityIdPrefix,
	Listing,
	Mutation,
	NormalizedEntity,
	PruneOptions,
	PruneReport,
	RetentionEnforcement,
	StateStore,
	StateStoreCapabilities,
} from '@etherfold/state-store';
import type {EntityStateView} from '@etherfold/processor-entities';
import {createBrowserStateStore, createIndexerState} from '../src/index.js';
import {
	BRANCH_A_LATER,
	BRANCH_A_LATER_TIP,
	EXPECTED_A_LATER,
	entityProcessorOver,
	fakeChain,
	FINALITY,
	indexToTip,
	processor,
	readState,
	runWorkload,
	SOURCE,
	type TestABI,
	versionCount,
} from '../browser/workload.js';

/**
 * A tab that states a retention floor actually RECLAIMS what falls below it.
 *
 * The half of retention that was missing: a window has always bounded what a
 * read may ASK about (`assertRetained`, on every backend), and `prune` is what
 * bounds the BYTES -- but ADR-0022 makes it an explicit call the HOST schedules,
 * and no host in this repository scheduled one. A browser deployment therefore
 * got the refusals of a bounded store and the footprint of an unbounded one, on
 * a device under a quota, for as long as the tab stayed open.
 *
 * Every assertion here is about what is STORED or what is ANSWERED, never about
 * what the store CLAIMS: the two coming apart is the defect, so a test that
 * asked the capability report would be asking the wrong half.
 *
 * The IndexedDB evidence that matters runs in a real engine
 * (`browser/indexing.spec.ts`, the `prune` case): `fake-indexeddb` is a shim
 * whose write path is not the engine's. These are the same claims on every
 * commit, plus the ones that need a spy and belong nowhere else.
 */

let counter = 0;
const freshName = () => `scheduled-prune-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** The window a browser deployment writes, next to the depth it must not go under. */
const WINDOW = {retention: {blocks: 64}, finalityDepth: 64} as const;

/**
 * The versions `BRANCH_A_LATER` leaves behind with nothing pruned.
 *
 * Ten: two for each of the three tokens that were written twice, and four for
 * the counter, which every event rewrites.
 */
const UNPRUNED = 10;

/**
 * The versions that survive a prune at a floor of `200 - 64`.
 *
 * The four CLOSED at block 102 and 104 are gone; the two closed at 200 are still
 * inside the window, and the four LIVE ones are the current state and are never
 * in scope however old they are.
 */
const RETAINED = 6;

/** One run of the late-branch workload against a store the test configured. */
async function indexLateBranch(store: StateStore) {
	return runWorkload(store, fakeChain(BRANCH_A_LATER, BRANCH_A_LATER_TIP));
}

describe('the indexing loop schedules the prune its retention implies', () => {
	it('drops the versions a window no longer covers, and answers exactly as an unbounded store', async () => {
		const unboundedName = freshName();
		const windowedName = freshName();

		const unbounded = await indexLateBranch(
			await createBrowserStateStore(processor.entities, {databaseName: unboundedName}),
		);
		const windowed = await indexLateBranch(
			await createBrowserStateStore(processor.entities, {databaseName: windowedName, ...WINDOW}),
		);

		expect(await versionCount(unboundedName)).toBe(UNPRUNED);
		expect(await versionCount(windowedName)).toBe(RETAINED);
		// the count fell and the answers did not: the state a windowed tab reads is
		// the state an unbounded one reads, which is what makes the reclamation free
		expect(unbounded.state).toEqual(EXPECTED_A_LATER);
		expect(windowed.state).toEqual(EXPECTED_A_LATER);
	});

	/**
	 * The case a binary window-or-not implementation gets wrong.
	 *
	 * `retentionFloor` returns a floor for `revert-only` too, wherever a
	 * `finalityDepth` is stated: that kind keeps superseded versions only as long
	 * as reorg revert needs them, and the depth is how long that is (ADR-0022).
	 * Reading the trigger as "a window is set" leaves the setting a browser app is
	 * told to prefer refusing every historical read while retaining every version
	 * for ever -- which is the exact worst-of-both this whole thing exists to kill.
	 */
	it('prunes a revert-only store that states a finality depth, because that is a floor', async () => {
		const databaseName = freshName();

		const {state} = await indexLateBranch(
			await createBrowserStateStore(processor.entities, {
				databaseName,
				retention: 'revert-only',
				finalityDepth: 64,
			}),
		);

		expect(await versionCount(databaseName)).toBe(RETAINED);
		expect(state).toEqual(EXPECTED_A_LATER);
	});

	/**
	 * No floor, nothing deleted -- and the host still calls unconditionally.
	 *
	 * ADR-0022: a prune "is a no-op wherever there is no floor, so a host may
	 * schedule it unconditionally". It is not an optimisation to skip it, either:
	 * the capability report carries no finality depth, so a host holding the seam
	 * cannot tell a `revert-only` store WITH a floor from one without.
	 */
	it.each([
		['unbounded, which is the default', {} as const],
		['revert-only with no depth, which states no floor', {retention: 'revert-only'} as const],
	])('deletes nothing where there is no floor (%s)', async (_name, config) => {
		const databaseName = freshName();

		const {state} = await indexLateBranch(await createBrowserStateStore(processor.entities, {databaseName, ...config}));

		expect(await versionCount(databaseName)).toBe(UNPRUNED);
		expect(state).toEqual(EXPECTED_A_LATER);
	});

	/**
	 * The property a naive "drop everything below the floor" destroys.
	 *
	 * Token 1 was last written at block 102 and token 2 at block 104, both far
	 * below a floor of 136, and both are the CURRENT state. A live version has no
	 * upper bound at all, so no legal read can be answered without it however old
	 * it is.
	 */
	it('keeps the live version of a row last written far below the floor', async () => {
		const databaseName = freshName();
		const store = await createBrowserStateStore(processor.entities, {databaseName, ...WINDOW});

		const {state} = await indexLateBranch(store);

		expect(state.owners['1']).toBe(EXPECTED_A_LATER.owners['1']);
		expect(state.owners['2']).toBe(EXPECTED_A_LATER.owners['2']);
		// read back through the store itself, and not only through the hook's handle
		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: EXPECTED_A_LATER.owners['1']});
		expect(await store.getCurrent('token', {id: '2'})).toMatchObject({owner: EXPECTED_A_LATER.owners['2']});
	});

	/**
	 * A cycle spends a BUDGET, and the next cycle comes back for the rest.
	 *
	 * The reason the budget exists at all: a prune costs time proportional to what
	 * it drops (6.3 s at 62,553 versions on the IndexedDB prototype), and a tab
	 * that had run unbounded for a month before a window was configured would
	 * otherwise pay for all of it inside one cycle. A budget of one version per
	 * pass is the smallest the seam accepts, which is what makes the passes
	 * countable here.
	 */
	it('spends a bounded budget per cycle and comes back for the rest', async () => {
		const databaseName = freshName();
		const store = await createBrowserStateStore(processor.entities, {databaseName, ...WINDOW});
		const chain = fakeChain(BRANCH_A_LATER, BRANCH_A_LATER_TIP);
		const indexer = createIndexerState<TestABI, EntityStateView>(
			{createState: () => store, createProcessor: (state) => entityProcessorOver(state, processor)},
			{pruneBudget: 1},
		);
		await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});

		await indexToTip(indexer);

		// the cycles that reached the tip each dropped at most one version, so the
		// backlog cannot have been paid for in one of them
		const counts = [await versionCount(databaseName)];
		expect(counts[0]).toBeGreaterThan(RETAINED);

		// and the loop comes back: each further cycle spends its budget until there
		// is nothing left below the floor
		for (let cycle = 0; cycle < UNPRUNED; cycle++) {
			await indexer.indexMore();
			counts.push(await versionCount(databaseName));
		}
		for (const [index, count] of counts.entries()) {
			if (index === 0) continue;
			expect(count).toBeGreaterThanOrEqual(counts[index - 1] - 1);
			expect(count).toBeLessThanOrEqual(counts[index - 1]);
		}
		expect(counts[counts.length - 1]).toBe(RETAINED);
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A_LATER);

		indexer.dispose();
	});

	/**
	 * A budget that cannot be spent is refused WHERE IT WAS WRITTEN.
	 *
	 * The seam refuses `maxVersions: 0` rather than reading it as "do nothing",
	 * because a caller that computed a budget wrongly would otherwise watch a
	 * prune run on schedule while the store grew. Surfaced at construction so the
	 * app learns it from the line it configured, and not as a failure logged once
	 * per cycle for ever.
	 */
	it('refuses a budget no pass could spend, at the line that configured it', async () => {
		const store = await createBrowserStateStore(processor.entities, {databaseName: freshName(), ...WINDOW});

		expect(() =>
			createIndexerState<TestABI, EntityStateView>(
				{createState: () => store, createProcessor: (state) => entityProcessorOver(state, processor)},
				{pruneBudget: 0},
			),
		).toThrow(/invalid prune budget/);
	});

	/**
	 * ADR-0022's guarantee, asserted rather than trusted: an indexing cycle's cost
	 * does not silently include a delete proportional to history.
	 *
	 * A prune inside `applyBlock` would stall whichever block happened to cross a
	 * threshold for work that block did not cause. The spy answers it exactly: no
	 * `prune` call is ever in flight while an `applyBlock` is.
	 */
	it('never reaches a prune from the path that applies a block', async () => {
		const inner = await createBrowserStateStore(processor.entities, {databaseName: freshName(), ...WINDOW});
		const watched = new Watched(inner);

		await indexLateBranch(watched);

		// it did prune -- otherwise the claim below is vacuous
		expect(watched.pruneCalls).toBeGreaterThan(0);
		expect(watched.blocksApplied).toBeGreaterThan(0);
		expect(watched.prunesDuringAnApply).toBe(0);
	});
});

/**
 * A store that records WHEN it was asked to delete, relative to applying a block.
 *
 * A decorator rather than a mock: everything it is asked runs against a real
 * IndexedDB store, so what it observes is the calls the hook actually makes on
 * the path it actually takes.
 */
class Watched implements StateStore {
	pruneCalls = 0;
	blocksApplied = 0;
	prunesDuringAnApply = 0;
	private applying = 0;

	constructor(private readonly inner: StateStore) {}

	get capabilities(): StateStoreCapabilities {
		return this.inner.capabilities;
	}

	get declarations(): ReadonlyMap<string, NormalizedEntity> {
		return this.inner.declarations;
	}

	migrate(): Promise<void> {
		return this.inner.migrate();
	}

	async applyBlock(block: BlockPointer, mutations?: readonly Mutation[], cursor?: CursorWrite): Promise<void> {
		this.blocksApplied++;
		this.applying++;
		try {
			await this.inner.applyBlock(block, mutations, cursor);
		} finally {
			this.applying--;
		}
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

	prune(options?: PruneOptions): Promise<PruneReport> {
		this.pruneCalls++;
		if (this.applying > 0) {
			this.prunesDuringAnApply++;
		}
		return this.inner.prune(options);
	}

	readRetentionEnforcement(): Promise<RetentionEnforcement> {
		return this.inner.readRetentionEnforcement();
	}

	getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		return this.inner.getCurrent<T>(entity, id);
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

	getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: number): Promise<T | undefined> {
		return this.inner.getAsOf<T>(entity, id, at);
	}

	revertTo(keepUpTo: number): Promise<void> {
		return this.inner.revertTo(keepUpTo);
	}
}
