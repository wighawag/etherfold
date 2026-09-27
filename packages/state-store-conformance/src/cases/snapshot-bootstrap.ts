import {
	BlockNotRetainedError,
	encodeSnapshot,
	openSnapshotAware,
	RevertBeyondSnapshotError,
	SnapshotFormatError,
	SnapshotProcessorMismatchError,
	type EntityDeclaration,
	type SnapshotAwareStateStore,
	type StateStoreCapabilities,
} from '@etherfold/state-store';
import {expect} from 'vitest';
import {
	CONFORMANCE_ENTITIES,
	LADDER_BASE,
	block,
	burn,
	cases,
	declaredColumns,
	owns,
	snapshotDocument,
} from '../fixtures.js';
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
	/** The minimal producer: the rows a test knows it wants, as a format-2 document (ADR-0095). */
	function snapshot(at: number, overrides: {processor?: string} = {}): Promise<Uint8Array> {
		return snapshotDocument(at, {
			processor: overrides.processor,
			cursor: {key: 'lastSync', value: `snapshot-at-${at}`},
			rows: [owns('1', '0xalice', 7), owns('2', '0xbob', 2)],
		});
	}

	/** A store from the factory, opened snapshot-aware and bootstrapped. The INNER one comes back too. */
	async function bootstrapped(at = SNAPSHOT_BLOCK) {
		const inner = await factory(CONFORMANCE_ENTITIES);
		const store = await openSnapshotAware(inner);
		await store.migrate();
		await store.bootstrap(await snapshot(at), {processor: 'conformance-processor-v1'});
		return {inner, store};
	}

	/** The block the self-indexed store below stopped at: its own recorded tip. */
	const SELF_TIP = LADDER_BASE + 200;

	/**
	 * A store that INDEXED ITSELF, with no snapshot origin: token `9` is live here and
	 * the chain deleted it before any snapshot below was taken, so no floor carries it.
	 * It is pruned the way a long-running deployment is, which on a store that keeps
	 * history as reverse patches drops the lowest block's, so a wipe has to work
	 * without them.
	 */
	async function selfIndexed() {
		const store = await openSnapshotAware(await factory(CONFORMANCE_ENTITIES));
		await store.migrate();
		await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1), owns('9', '0xzed', 1)], {
			key: 'lastSync',
			value: `self-at-${LADDER_BASE}`,
		});
		await store.applyBlock(block(SELF_TIP), [owns('1', '0xbob', 2)], {key: 'lastSync', value: `self-at-${SELF_TIP}`});
		await store.prune();
		return store;
	}

	/** A store from the factory with nothing in it, to install the same document into. */
	async function empty() {
		const store = await openSnapshotAware(await factory(CONFORMANCE_ENTITIES));
		await store.migrate();
		return store;
	}

	/** A row as the seam defines it: the store's own `_` columns are its business (`declaredColumns`). */
	function declaredOf(row: Record<string, unknown> | undefined) {
		return row && Object.fromEntries(declaredColumns(row).map((column) => [column, row[column]]));
	}

	/**
	 * Every read this group can ask, as data, so two stores are compared whole: the
	 * tip rows, an as-of read of each at each block (or the refusal, which is an
	 * answer too), the cursor, the floor and the claim.
	 */
	async function readsOf(store: SnapshotAwareStateStore, at: readonly number[]) {
		const ids = ['1', '2', '3', '9'];
		const current = [];
		for (const id of ids) current.push(declaredOf(await store.getCurrent('token', {id})));
		const asOf = [];
		for (const number of at) {
			for (const id of ids) {
				asOf.push(
					await store.getAsOf('token', {id}, number).then(
						(row) => ({number, id, row: declaredOf(row)}),
						(error: unknown) => ({
							number,
							id,
							refused: error instanceof BlockNotRetainedError ? 'not-retained' : String(error),
						}),
					),
				);
			}
		}
		return {
			current,
			asOf,
			cursor: await store.readCursor('lastSync'),
			origin: store.snapshotOrigin,
			capabilities: store.capabilities,
		};
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
				.bootstrap(await snapshot(SNAPSHOT_BLOCK, {processor: 'some-other-version'}), {
					processor: 'conformance-processor-v1',
				})
				.catch((error: unknown) => error);

			expect(refusal).toBeInstanceOf(SnapshotProcessorMismatchError);
			expect((refusal as Error).message).toContain('some-other-version');
			expect((refusal as Error).message).toContain('conformance-processor-v1');
			expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
		},

		'refuses a document of another format, installing nothing': async () => {
			const store = await openSnapshotAware(await factory(CONFORMANCE_ENTITIES));
			await store.migrate();
			// format 1, as it was served: a JSON object, not a gzipped format-2 document
			const formatOne = new TextEncoder().encode(
				JSON.stringify({format: 1, processor: 'conformance-processor-v1', takenAt: block(SNAPSHOT_BLOCK), rows: []}),
			);

			await expect(store.bootstrap(formatOne)).rejects.toBeInstanceOf(SnapshotFormatError);
			expect(store.snapshotOrigin).toBeUndefined();
		},

		'replays the blocks a snapshot carries above its floor, the cursor riding the last': async () => {
			// what format 2 adds over the rows at one block (ADR-0095): installing is
			// replaying blocks through `applyBlock`, so a backend needs nothing new for it
			// and ends in the state AT THE CUT, whatever history it keeps.
			const store = await openSnapshotAware(await factory(CONFORMANCE_ENTITIES));
			await store.migrate();
			const document = await snapshotDocument(SNAPSHOT_BLOCK, {
				rows: [owns('1', '0xalice', 7), owns('2', '0xbob', 2)],
				cursor: {key: 'lastSync', value: `snapshot-at-${SNAPSHOT_BLOCK + 9}`},
				later: [
					{block: block(SNAPSHOT_BLOCK + 4), mutations: [owns('1', '0xcarol', 8)]},
					{block: block(SNAPSHOT_BLOCK + 9), mutations: [burn('2'), owns('3', '0xdave', 1)]},
				],
			});

			await store.bootstrap(document, {processor: 'conformance-processor-v1'});

			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xcarol', transferCount: 8});
			expect(await store.getCurrent('token', {id: '2'})).toBeUndefined();
			expect(await store.getCurrent('token', {id: '3'})).toMatchObject({owner: '0xdave'});
			expect(await store.readCursor('lastSync')).toBe(`snapshot-at-${SNAPSHOT_BLOCK + 9}`);
			// the FLOOR is the store's floor, not the cut: the history above it was replayed
			expect(store.snapshotOrigin).toBe(SNAPSHOT_BLOCK);
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

		'REPLACES a store that indexed itself, rather than laying the floor over it': async () => {
			// the floor carries only live rows, so a row the chain deleted between this
			// store's tip and the snapshot is simply not in it: laid on top, it would
			// survive as a stale row nothing ever reports.
			const store = await selfIndexed();
			const document = await snapshot(SNAPSHOT_BLOCK);

			await store.bootstrap(document, {processor: 'conformance-processor-v1'});

			const fresh = await empty();
			await fresh.bootstrap(document, {processor: 'conformance-processor-v1'});
			expect(await store.getCurrent('token', {id: '9'})).toBeUndefined();
			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice', transferCount: 7});
			expect(await store.readCursor('lastSync')).toBe(`snapshot-at-${SNAPSHOT_BLOCK}`);
			const at = [LADDER_BASE, SELF_TIP, SNAPSHOT_BLOCK - 1, SNAPSHOT_BLOCK];
			expect(await readsOf(store, at)).toEqual(await readsOf(fresh, at));
		},

		'installs a history snapshot whose floor is at or below the tip the store indexed itself to': async () => {
			const store = await selfIndexed();
			const floor = SELF_TIP - 50;
			const document = await snapshotDocument(floor, {
				rows: [owns('1', '0xalice', 7), owns('2', '0xbob', 2)],
				cursor: {key: 'lastSync', value: `snapshot-at-${SELF_TIP + 60}`},
				later: [
					// the very block this store recorded itself, carrying the chain's version of it
					{block: block(SELF_TIP), mutations: [owns('1', '0xcarol', 8)]},
					{block: block(SELF_TIP + 60), mutations: [burn('2'), owns('3', '0xdave', 1)]},
				],
			});

			await store.bootstrap(document, {processor: 'conformance-processor-v1'});

			const fresh = await empty();
			await fresh.bootstrap(document, {processor: 'conformance-processor-v1'});
			expect(store.snapshotOrigin).toBe(floor);
			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xcarol', transferCount: 8});
			expect(await store.getCurrent('token', {id: '9'})).toBeUndefined();
			const at = [floor - 1, floor, SELF_TIP - 1, SELF_TIP, SELF_TIP + 59, SELF_TIP + 60];
			expect(await readsOf(store, at)).toEqual(await readsOf(fresh, at));
			// and it goes on indexing from the cut, as the fresh install does
			await store.applyBlock(block(SELF_TIP + 61), [owns('2', '0xerin', 1)]);
			expect(await store.getCurrent('token', {id: '2'})).toMatchObject({owner: '0xerin'});
		},

		'leaves a store that indexed itself exactly as it was, when a snapshot is refused before a write': async () => {
			const elsewhere: EntityDeclaration = {name: 'token', id: ['id'], fields: {owner: 'text', colour: 'text'}};
			const mismatched = new Uint8Array(
				await new Response(
					encodeSnapshot(
						{
							processor: 'conformance-processor-v1',
							savedAt: '2026-08-24T00:00:00.000Z',
							takenAt: block(SNAPSHOT_BLOCK),
							floor: SNAPSHOT_BLOCK,
							cursor: {key: 'lastSync', value: `snapshot-at-${SNAPSHOT_BLOCK}`},
						},
						[elsewhere],
						[
							{
								block: block(SNAPSHOT_BLOCK),
								mutations: [
									{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xalice', colour: 'red'}},
								],
							},
						],
					),
				).arrayBuffer(),
			);
			const formatOne = new TextEncoder().encode(
				JSON.stringify({format: 1, processor: 'conformance-processor-v1', takenAt: block(SNAPSHOT_BLOCK), rows: []}),
			);
			const refused = [
				{
					document: await snapshot(SNAPSHOT_BLOCK, {processor: 'some-other-version'}),
					error: SnapshotProcessorMismatchError,
				},
				{document: formatOne, error: SnapshotFormatError},
				{document: mismatched, error: Error},
			];
			const at = [LADDER_BASE, SELF_TIP];

			for (const {document, error} of refused) {
				const store = await selfIndexed();
				const before = await readsOf(store, at);

				await expect(store.bootstrap(document, {processor: 'conformance-processor-v1'})).rejects.toBeInstanceOf(error);

				expect(await readsOf(store, at)).toEqual(before);
				expect(before.current[3]).toMatchObject({owner: '0xzed'});
				expect(before.cursor).toBe(`self-at-${SELF_TIP}`);
				// its recorded tip is still its own: the next block goes on above it
				await expect(store.applyBlock(block(SELF_TIP))).rejects.toThrow();
				await store.applyBlock(block(SELF_TIP + 1), [owns('9', '0xzed', 2)]);
				expect(await store.getCurrent('token', {id: '9'})).toMatchObject({transferCount: 2});
			}
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
