import {
	BlockNotRetainedError,
	ENTITY_SNAPSHOT_FORMAT,
	openSnapshotAware,
	RevertBeyondSnapshotError,
	SnapshotProcessorMismatchError,
	type StateSnapshot,
	type StateStoreCapabilities,
} from '@etherfold/state-store';
import {expect} from 'vitest';
import {CONFORMANCE_ENTITIES, LADDER_BASE, block, cases, owns} from '../fixtures.js';
import type {ConformanceCase, StateStoreFactory} from '../types.js';

const GROUP = 'bootstrapping from a snapshot';

/** Far enough above the ladder that "below the floor" is an ordinary block, not block -1. */
const SNAPSHOT_BLOCK = LADDER_BASE + 500;

/**
 * A store that started from state somebody else computed, and what it may then
 * claim about history it never received.
 *
 * ## Why this is a conformance case and not one backend's test
 *
 * The trap is inherited. A snapshot of CURRENT rows carries nothing below its
 * own block, so a store loaded from one cannot answer an as-of read below it --
 * and a freshly migrated store of any backend reports `unbounded`, because that
 * is true of a store that has been indexing since genesis and it has no way to
 * know it is not one. Every backend that ever exists behind this seam walks into
 * that the first time somebody bootstraps it, so the obligation belongs where a
 * new backend inherits it rather than where it would be rediscovered.
 *
 * The mechanism is at the seam (`openSnapshotAware`, one decorator over any
 * store), so what these cases really assert is that a backend supports the two
 * seam properties a bootstrap is built out of: rows and their cursor installing
 * as ONE unit (`applyBlock`'s third argument, for its other purpose), and a
 * cursor key that survives being written, read back by a fresh handle, and left
 * alone by a revert. A backend that breaks either one breaks bootstrapping,
 * and it fails here rather than in someone's browser tab.
 *
 * ## What is selected on the claim
 *
 * The same rule as every other case group: a store is tested against what it
 * SAYS. A backend that answers historical reads must refuse below the floor and
 * answer at and above it; a backend that answers none must go on refusing all of
 * them, because a floor is strictly weaker than "no history at all" and must not
 * be allowed to look like an upgrade.
 */
export function snapshotBootstrapCases(
	factory: StateStoreFactory,
	capabilities: StateStoreCapabilities,
): ConformanceCase[] {
	/** The minimal producer: the rows a test knows it wants, in the published shape. */
	function snapshot(at: number, overrides: Partial<StateSnapshot> = {}): StateSnapshot {
		return {
			format: ENTITY_SNAPSHOT_FORMAT,
			processor: 'conformance-processor-v1',
			savedAt: '2026-08-24T00:00:00.000Z',
			takenAt: block(at),
			cursor: {key: 'lastSync', value: `snapshot-at-${at}`},
			rows: [owns('1', '0xalice', 7), owns('2', '0xbob', 2)],
			...overrides,
		};
	}

	/** A store from the factory, opened snapshot-aware and bootstrapped. The INNER one comes back too. */
	async function bootstrapped(at = SNAPSHOT_BLOCK) {
		const inner = await factory(CONFORMANCE_ENTITIES);
		const store = await openSnapshotAware(inner);
		await store.migrate();
		await store.bootstrap(snapshot(at), {processor: 'conformance-processor-v1'});
		return {inner, store};
	}

	const shared = cases(GROUP, {
		'installs the rows of a snapshot and its cursor as one unit, and reads them back at the tip': async () => {
			const {store} = await bootstrapped();

			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice', transferCount: 7});
			expect(await store.getCurrent('token', {id: '2'})).toMatchObject({owner: '0xbob'});
			// the cursor is what makes it a bootstrap rather than a pile of rows: the
			// indexer resumes from HERE instead of from the start block.
			expect(await store.readCursor('lastSync')).toBe(`snapshot-at-${SNAPSHOT_BLOCK}`);
		},

		'refuses a snapshot computed by another processor version, naming both': async () => {
			const store = await openSnapshotAware(await factory(CONFORMANCE_ENTITIES));
			await store.migrate();

			const refusal = await store
				.bootstrap(snapshot(SNAPSHOT_BLOCK, {processor: 'some-other-version'}), {
					processor: 'conformance-processor-v1',
				})
				.catch((error: unknown) => error);

			expect(refusal).toBeInstanceOf(SnapshotProcessorMismatchError);
			expect((refusal as Error).message).toContain('some-other-version');
			expect((refusal as Error).message).toContain('conformance-processor-v1');
			expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
		},

		'goes on indexing from the snapshot block, so the rows and the new blocks are one state': async () => {
			const {store} = await bootstrapped();
			await store.applyBlock(block(SNAPSHOT_BLOCK + 1), [owns('1', '0xcarol', 8)], {
				key: 'lastSync',
				value: `at-${SNAPSHOT_BLOCK + 1}`,
			});

			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xcarol'});
			expect(await store.getCurrent('token', {id: '2'})).toMatchObject({owner: '0xbob'});
			expect(await store.readCursor('lastSync')).toBe(`at-${SNAPSHOT_BLOCK + 1}`);
		},

		'remembers where its contents came from, so a RELOAD is as honest as the first run': async () => {
			// The floor cannot live in a closure: a tab is closed and reopened, and a
			// handle that forgot would go back to claiming the history of a store that
			// has been indexing since genesis.
			const {inner} = await bootstrapped();

			const reopened = await openSnapshotAware(inner);

			expect(reopened.snapshotOrigin).toBe(SNAPSHOT_BLOCK);
		},

		'refuses a revert that reaches below the snapshot, and changes nothing': async () => {
			const {store} = await bootstrapped();
			await store.applyBlock(block(SNAPSHOT_BLOCK + 1), [owns('1', '0xcarol', 8)]);

			const refusal = await store.revertTo(SNAPSHOT_BLOCK - 1).catch((error: unknown) => error);

			expect(refusal).toBeInstanceOf(RevertBeyondSnapshotError);
			// nothing half-done: a partly reverted state is a plausible state nothing
			// downstream can tell apart from a correct one.
			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xcarol'});
		},

		'still reverts down to the snapshot block itself, which is a block it holds': async () => {
			const {store} = await bootstrapped();
			await store.applyBlock(block(SNAPSHOT_BLOCK + 1), [owns('1', '0xcarol', 8)]);

			await store.revertTo(SNAPSHOT_BLOCK);

			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
		},

		'lets a WIPE through, and drops the floor with the rows it was about': async () => {
			const {inner, store} = await bootstrapped();

			await store.revertTo(-1);

			expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
			expect((await openSnapshotAware(inner)).snapshotOrigin).toBeUndefined();
		},
	});

	if (!capabilities.asOf || capabilities.retention.kind === 'revert-only') {
		return [
			...shared,
			...cases(GROUP, {
				'answers no historical read after a bootstrap either, because a floor is not an upgrade': async () => {
					const {store} = await bootstrapped();

					expect(store.capabilities.asOf).toBe(false);
					await expect(store.getAsOf('token', {id: '1'}, SNAPSHOT_BLOCK)).rejects.toBeInstanceOf(BlockNotRetainedError);
				},
			}),
		];
	}

	return [
		...shared,
		...cases(GROUP, {
			'refuses an as-of read below the snapshot block, rather than reporting the entity as absent': async () => {
				const {store} = await bootstrapped();

				// `undefined` would be the ordinary "it was not there then", which is a
				// wrong answer a caller acts on normally. This block is one the store
				// has NOTHING for, and it says so.
				const refusal = await store.getAsOf('token', {id: '1'}, SNAPSHOT_BLOCK - 1).catch((error: unknown) => error);
				expect(refusal).toBeInstanceOf(BlockNotRetainedError);
				expect((refusal as BlockNotRetainedError).requested).toBe(SNAPSHOT_BLOCK - 1);
			},

			'answers as of the snapshot block, which is what the rows are the state AS OF': async () => {
				const {store} = await bootstrapped();

				expect(await store.getAsOf('token', {id: '1'}, SNAPSHOT_BLOCK)).toMatchObject({owner: '0xalice'});
				expect((await store.listAsOf('token', {id: '1'}, SNAPSHOT_BLOCK, 10)).rows).toHaveLength(1);
			},

			'answers as of the history it computed ITSELF, above the floor': async () => {
				const {store} = await bootstrapped();
				await store.applyBlock(block(SNAPSHOT_BLOCK + 1), [owns('1', '0xcarol', 8)]);

				expect(await store.getAsOf('token', {id: '1'}, SNAPSHOT_BLOCK)).toMatchObject({owner: '0xalice'});
				expect(await store.getAsOf('token', {id: '1'}, SNAPSHOT_BLOCK + 1)).toMatchObject({owner: '0xcarol'});
			},

			'never reports `unbounded` over rows whose history it never received': async () => {
				const {store} = await bootstrapped();

				expect(store.capabilities.retention.kind).toBe('window');
			},
		}),
	];
}
