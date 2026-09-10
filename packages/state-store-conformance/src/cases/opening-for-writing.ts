import {
	openForWriting,
	StoreWriterChangedError,
	WRITER_CLAIM_KEY,
	type StateStoreCapabilities,
} from '@etherfold/state-store';
import {expect} from 'vitest';
import {CONFORMANCE_ENTITIES, LADDER_BASE, block, cases, opened, owns} from '../fixtures.js';
import type {ConformanceCase, StateStoreConformanceOptions, StateStoreFactory} from '../types.js';

const GROUP = 'a writer claims by opening';

const CURSOR = 'lastSync';

/**
 * OPENING FOR WRITING IS ITSELF THE CLAIM.
 *
 * The chapter beside this one (`a second writer writes nothing`) asserts what a
 * writer meets on its next MUTATION once somebody else has written. This one
 * asserts the earlier moment: `openForWriting` takes the store there and then,
 * so a writer that has opened and not yet applied a block already holds it, and
 * the writer it displaced is refused from that instant rather than from whenever
 * the new one gets round to writing (ADR-0077).
 *
 * It is asked of BACKENDS rather than only of the seam because the mechanism
 * runs through one: the claim is taken by clearing `WRITER_CLAIM_KEY`, a key
 * nothing ever writes, which is a mutation that changes no byte. A backend whose
 * `clearCursor` took a short cut when there was nothing to delete would skip the
 * claim, and every case here would go red -- which is the whole reason these
 * cases are in the conformance suite and not in `@etherfold/state-store`'s own
 * tests, where the only store available reports `singleWriter: false`.
 *
 * The gating is the suite's usual claim-driven selection: a backend whose
 * storage is an instance field cannot be beaten by a second writer, so the
 * contention cases below are asked only of a backend that says it enforces one.
 * The first case is asked of everybody, because "opening for writing changes
 * nothing a caller can observe" is a promise every backend makes.
 */
export function openingForWritingCases(
	factory: StateStoreFactory,
	capabilities: StateStoreCapabilities,
	options: StateStoreConformanceOptions,
): ConformanceCase[] {
	const universal = cases(GROUP, {
		'leaves the cursor port exactly as it found it': async () => {
			const store = await opened(factory);
			await store.writeCursor(CURSOR, '{"lastToBlock":100}');

			const writable = await openForWriting(store);

			// the claim is a WRITE with no content: it moves the token a backend keeps
			// for itself and touches nothing a caller put there.
			expect(await writable.readCursor(CURSOR)).toBe('{"lastToBlock":100}');
			expect(await writable.readCursor(WRITER_CLAIM_KEY)).toBeUndefined();
		},

		'hands back a store that can drive the whole mutating surface': async () => {
			const store = await openForWriting(await factory(CONFORMANCE_ENTITIES));

			// `openForWriting` migrates, so this is the whole of what a host does.
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)], {key: CURSOR, value: 'at 100'});
			await store.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);
			await store.writeCursor(CURSOR, 'at 101');
			await store.prune();
			await store.revertTo(LADDER_BASE);
			await store.clearCursor(CURSOR);

			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
			expect(await store.readCursor(CURSOR)).toBeUndefined();
		},

		'is one claim per store instance, so a second open does not displace the first': async () => {
			const store = await opened(factory);
			const first = await openForWriting(store);
			const second = await openForWriting(store);

			// the shipped generation pattern hands ONE store instance to EVERY
			// generation, so both of these are the canonical writer and its successor.
			// If the second open claimed afresh, the process would refuse itself.
			expect(second).toBe(first);
			await first.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
			await second.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);
			await first.applyBlock(block(LADDER_BASE + 2), [owns('1', '0xcarol', 3)]);

			expect(await second.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xcarol'});
		},
	});

	const twoWriters = options.twoWriters;
	if (!capabilities.singleWriter || !twoWriters) return universal;

	return [
		...universal,
		...cases(GROUP, {
			'takes the store the moment it is OPENED, before it has written anything': async () => {
				const [holder, arriving] = await twoWriters.sharingStorage(CONFORMANCE_ENTITIES);
				await holder.migrate();
				await holder.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);

				// no block, no cursor, no mutation of any kind: the open IS the claim,
				// and it neither blocks nor waits for the writer that had the store.
				await openForWriting(arriving);

				await expect(holder.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)])).rejects.toBeInstanceOf(
					StoreWriterChangedError,
				);
				expect(await holder.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
			},

			'refuses the displaced writer on every mutating path, not only on blocks': async () => {
				const [holder, arriving] = await twoWriters.sharingStorage(CONFORMANCE_ENTITIES);
				await holder.migrate();
				await holder.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
				await holder.writeCursor(CURSOR, 'the holder got here');

				await openForWriting(arriving);

				// the no-block paths are the ones the guard exists for most: nothing
				// incidentally protects them, so this is how a position goes BACKWARDS.
				await expect(holder.writeCursor(CURSOR, 'a position that stopped being true')).rejects.toBeInstanceOf(
					StoreWriterChangedError,
				);
				await expect(holder.clearCursor(CURSOR)).rejects.toBeInstanceOf(StoreWriterChangedError);
				await expect(holder.revertTo(LADDER_BASE)).rejects.toBeInstanceOf(StoreWriterChangedError);
				await expect(holder.prune()).rejects.toBeInstanceOf(StoreWriterChangedError);
				expect(await holder.readCursor(CURSOR)).toBe('the holder got here');
			},

			'lets the writer it displaced go on READING, which is what demoting needs': async () => {
				const [holder, arriving] = await twoWriters.sharingStorage(CONFORMANCE_ENTITIES);
				await holder.migrate();
				await holder.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);

				const taken = await openForWriting(arriving);
				await taken.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);

				// a losing tab keeps showing correct data rather than erroring or going
				// blank, and what it shows is the winner's writes.
				expect(await holder.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
			},

			'claims a store nobody has written to, so the first writer is a writer like any other': async () => {
				const [first, second] = await twoWriters.sharingStorage(CONFORMANCE_ENTITIES);
				const writable = await openForWriting(first);
				await second.migrate();

				await writable.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);

				// the other handle merely OPENED (which is what every tab of one app
				// does) and took nothing, so the writer that claimed still holds it.
				await writable.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);
				expect(await writable.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
			},

			'refuses neither of two writers ADDRESSED APART, however they were opened': async () => {
				const [left, right] = await twoWriters.addressedApart(CONFORMANCE_ENTITIES);
				const leftWriter = await openForWriting(left);
				const rightWriter = await openForWriting(right);

				// two generations of one indexer, or two unrelated indexers on one
				// origin. Claiming at OPEN time must not widen the scope of a claim that
				// belongs to one unit of storage.
				await leftWriter.applyBlock(block(LADDER_BASE), [owns('1', '0xleft', 1)]);
				await rightWriter.applyBlock(block(LADDER_BASE), [owns('1', '0xright', 1)]);
				await leftWriter.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xleft', 2)]);
				await rightWriter.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xright', 2)]);

				expect(await leftWriter.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xleft'});
				expect(await rightWriter.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xright'});
			},
		}),
	];
}
