import {StoreWriterChangedError, type StateStore, type StateStoreCapabilities} from '@etherfold/state-store';
import {expect} from 'vitest';
import {CONFORMANCE_ENTITIES, LADDER_BASE, block, cases, opened, owns} from '../fixtures.js';
import type {
	ConformanceCase,
	StateStoreConformanceOptions,
	StorePair,
	StateStoreFactory,
	TwoWriters,
} from '../types.js';

const GROUP = 'a second writer writes nothing';

const CURSOR = 'lastSync';

/**
 * The contention chapter: what happens when TWO writers reach one store.
 *
 * Two instances of one indexer writing to one store is not an exotic
 * deployment. A user with the app open in two tabs has it, a backgrounded tab
 * resuming with a stale cursor has it, and an app following the documented
 * `createState` example puts two generations of one indexer into one database
 * inside a single tab. Until the writer token existed, only `applyBlock` would
 * have noticed, and the failure that matters is the quiet one: a cursor moved
 * BACKWARDS produces a state that is internally consistent, reproducible on
 * reload, and wrong.
 *
 * So these cases assert the caller-visible half of the guarantee, on every path
 * that mutates: the loser's call RAISES `StoreWriterChangedError`, and the store
 * is exactly what the winner left. They are gated on the store's own CLAIM
 * (`capabilities.singleWriter`), because a backend whose storage is an instance
 * field cannot be beaten by a second writer and a token there could only ever be
 * compared with itself -- green, tested and meaningless.
 *
 * The other half is asserted just as hard, because a guard that over-refuses is
 * a different way to break the same deployments: two stores ADDRESSED APART both
 * write concurrently and neither is refused, which is what keeps two unrelated
 * indexers on one origin, and two generations of one indexer, working.
 *
 * What is NOT here is the exact-window race, where a rival's write lands between
 * a writer's read and its write. It needs the handle to be wrapped, which is
 * backend-specific, so it lives in each backend's own tests (ADR-0054 set the
 * shape; ADR-0075 applies it here).
 */
export function singleWriterCases(
	factory: StateStoreFactory,
	capabilities: StateStoreCapabilities,
	options: StateStoreConformanceOptions,
): ConformanceCase[] {
	if (!capabilities.singleWriter) return [];

	const twoWriters = options.twoWriters;
	if (!twoWriters) {
		return cases(GROUP, {
			'claims to enforce a single writer, so the suite must be given a way to open a second handle': async () => {
				throw new Error(
					`this backend reports \`singleWriter: true\` and the suite was given no \`twoWriters\` option, so the ` +
						`claim cannot be tested. \`StateStoreFactory\` is a fresh database per call and cannot express two ` +
						`handles on one storage; pass \`{twoWriters: {sharingStorage, addressedApart}}\` to ` +
						`describeStateStoreConformance. Skipping the contention cases instead would let the claim be fiction, ` +
						`which is the one thing the capability report exists to prevent.`,
				);
			},
		});
	}

	/** Two handles on one storage, both migrated, with the FIRST one holding the store. */
	const contending = async (): Promise<{first: StateStore; second: StateStore}> => {
		const [first, second] = await bothOpened(twoWriters.sharingStorage);
		// the first writer claims by WRITING, which is the only way to claim
		await first.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
		return {first, second};
	};

	/** The same, after the second writer has taken the store: `first` has lost. */
	const taken = async (): Promise<{lost: StateStore; holder: StateStore}> => {
		const {first, second} = await contending();
		await second.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);
		return {lost: first, holder: second};
	};

	return cases(GROUP, {
		'refuses the block of a writer whose claim was taken, and applies none of it': async () => {
			const {lost, holder} = await taken();

			await expect(lost.applyBlock(block(LADDER_BASE + 2), [owns('1', '0xmallory', 3)])).rejects.toBeInstanceOf(
				StoreWriterChangedError,
			);

			// nothing of the refused block landed, not even the block itself: the
			// holder applies that very height afterwards.
			expect(await holder.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
			await holder.applyBlock(block(LADDER_BASE + 2), [owns('1', '0xcarol', 3)]);
			expect(await holder.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xcarol'});
		},

		'refuses a cursor write from a writer whose claim was taken': async () => {
			const {lost, holder} = await taken();
			await holder.writeCursor(CURSOR, 'the holder got here');

			// the no-block path, and the one the guard exists for most: no block
			// record incidentally protects it, so this is how a position goes
			// BACKWARDS silently.
			await expect(lost.writeCursor(CURSOR, 'a position that stopped being true')).rejects.toBeInstanceOf(
				StoreWriterChangedError,
			);
			expect(await holder.readCursor(CURSOR)).toBe('the holder got here');
		},

		'refuses a cursor clear from a writer whose claim was taken': async () => {
			const {lost, holder} = await taken();
			await holder.writeCursor(CURSOR, 'the holder got here');

			await expect(lost.clearCursor(CURSOR)).rejects.toBeInstanceOf(StoreWriterChangedError);
			expect(await holder.readCursor(CURSOR)).toBe('the holder got here');
		},

		'refuses a revert from a writer whose claim was taken, so no state is rolled back under it': async () => {
			const {lost, holder} = await taken();

			// the destructive path: the only one that can leave a WRONG state rather
			// than an exception, which is why it is asserted on the STATE and not
			// only on the throw.
			await expect(lost.revertTo(LADDER_BASE)).rejects.toBeInstanceOf(StoreWriterChangedError);
			expect(await holder.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
		},

		'refuses a prune from a writer whose claim was taken': async () => {
			const {lost} = await taken();

			// whatever this store's retention is: a prune computes a floor from a tip
			// another writer has been moving, so a writer that lost the store has no
			// business deleting against it -- even when the floor turns out to be
			// nothing to delete.
			await expect(lost.prune()).rejects.toBeInstanceOf(StoreWriterChangedError);
		},

		'tells a lost race apart from the caller bug that re-applies a block': async () => {
			const {first} = await contending();

			// the two refusals on this path mean OPPOSITE things: this one says the
			// caller is wrong, and `StoreWriterChangedError` says the caller lost a
			// race it could not have avoided and should demote itself to a reader.
			const error = await first.applyBlock(block(LADDER_BASE), [owns('1', '0xbob', 2)]).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(StoreWriterChangedError);
		},

		'refuses a lost writer BEFORE the block checks, so it learns the right thing': async () => {
			const {lost, holder} = await taken();

			// the height the holder just used. A lost writer re-applying it is not a
			// caller re-applying a block: it is a writer working from a state that
			// stopped being true, and the error it gets has to say so or the demotion
			// never happens.
			await expect(lost.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xmallory', 9)])).rejects.toBeInstanceOf(
				StoreWriterChangedError,
			);
			expect(await holder.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
		},

		'moves a cursor BACKWARDS for the writer that holds the store, because the guard is on the TOKEN': async () => {
			const store = await opened(factory);
			await store.writeCursor(CURSOR, '{"lastToBlock":200}');

			// the store stays ignorant of what a cursor string means (ADR-0027): the
			// guard asks WHO is writing and never WHAT, so a rewind by the holder --
			// which is what a reorg is -- writes exactly what it was given.
			await store.writeCursor(CURSOR, '{"lastToBlock":100}');
			expect(await store.readCursor(CURSOR)).toBe('{"lastToBlock":100}');
		},

		'lets a refused writer keep READING, which is what demoting to a reader needs': async () => {
			const {lost, holder} = await taken();
			await holder.writeCursor(CURSOR, 'the holder got here');
			await expect(lost.writeCursor(CURSOR, 'nope')).rejects.toBeInstanceOf(StoreWriterChangedError);

			// a losing tab keeps showing correct data rather than erroring or going
			// blank: reads are not guarded, and they see the winner's writes.
			expect(await lost.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
			expect(await lost.readCursor(CURSOR)).toBe('the holder got here');
			expect((await lost.listCurrent('token', {id: '1'}, 10)).rows.length).toBe(1);
		},

		'takes over a store its writer abandoned mid-flight, with no clear and no waiting': async () => {
			const [abandoned, next] = await bothOpened(twoWriters.sharingStorage);
			await abandoned.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
			// and now that writer is simply gone -- a killed tab, a crashed process.
			// There is no lease to expire and nothing to release, so the next writer
			// claims by writing, on its first attempt.
			await next.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);

			expect(await next.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
		},

		'does not claim the store merely because a second handle was OPENED': async () => {
			const [writer, opener] = await twoWriters.sharingStorage(CONFORMANCE_ENTITIES);
			await writer.migrate();
			await writer.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);

			// several tabs of one app all open the store; opening is not writing, and
			// migrating must never take the store from the writer that has it.
			await opener.migrate();

			await writer.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);
			expect(await writer.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
		},

		'never refuses a single writer, on any mutating path': async () => {
			const store = await opened(factory);

			// the whole mutating surface, in one sequence, through one handle: this is
			// the case that would go red if the guard were checking anything other
			// than WHO is writing.
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)], {key: CURSOR, value: 'at 100'});
			await store.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);
			await store.writeCursor(CURSOR, 'at 101');
			await store.prune();
			await store.revertTo(LADDER_BASE);
			await store.clearCursor(CURSOR);
			await store.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xcarol', 3)]);

			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xcarol'});
			expect(await store.readCursor(CURSOR)).toBeUndefined();
		},

		'lets two stores ADDRESSED APART write concurrently, and refuses neither': async () => {
			const [left, right] = await bothOpened(twoWriters.addressedApart);

			// two generations of one indexer, or two unrelated indexers on one origin.
			// They interleave deliberately: if the claim were scoped to anything
			// outside the storage -- an origin, a tab, a connection, a lock name --
			// the second write of each pair would be refused here.
			await left.applyBlock(block(LADDER_BASE), [owns('1', '0xleft', 1)]);
			await right.applyBlock(block(LADDER_BASE), [owns('1', '0xright', 1)]);
			await left.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xleft', 2)]);
			await right.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xright', 2)]);
			await left.writeCursor(CURSOR, 'left');
			await right.writeCursor(CURSOR, 'right');

			// and they hold their OWN answers, which is the other half of being
			// separately addressed
			expect(await left.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xleft'});
			expect(await right.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xright'});
			expect(await left.readCursor(CURSOR)).toBe('left');
			expect(await right.readCursor(CURSOR)).toBe('right');
		},
	});
}

/** A pair from one of the affordances, both migrated, exactly as two tabs would. */
async function bothOpened(pair: TwoWriters['sharingStorage']): Promise<StorePair> {
	const [first, second] = await pair(CONFORMANCE_ENTITIES);
	await first.migrate();
	await second.migrate();
	return [first, second];
}
