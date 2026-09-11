import {ENTITY_SNAPSHOT_FORMAT, openSnapshotAware, SEAM_RECORD_KEYS, type SeamRecordKey} from '@etherfold/state-store';
import {expect} from 'vitest';
import {CONFORMANCE_ENTITIES, LADDER_BASE, block, cases, opened, owns} from '../fixtures.js';
import type {ConformanceCase, StateStoreConformanceOptions, StateStoreFactory} from '../types.js';

const GROUP = "the seam's own records";

/**
 * THE SEAM KEEPS THREE FACTS INSIDE EVERY STORE, AND A CALLER CANNOT REACH THEM.
 *
 * `snapshotOrigin` (where a bootstrapped store's rows came from),
 * `retentionEnforcement` (the floor the last prune ran at) and `writerClaim`
 * (the no-op mutation a claim is taken by) are the seam's, not the caller's, and
 * they live in a keyspace of their own on every backend (`records.ts`).
 *
 * ## Why these cases are here and not in `@etherfold/state-store`'s own tests
 *
 * Because "a separate keyspace" is a claim about STORAGE, and only a backend has
 * any. At the seam the reference store could satisfy it with two `Map`s and
 * prove nothing about a store whose substrate has one namespace it was tempting
 * to reuse: IndexedDB has one database and SQLite one set of tables, and on both
 * of them the cheap way to keep these three facts was reserved keys in the
 * caller's cursor table. That is exactly the implementation these cases refuse.
 *
 * ## The case that names the bug
 *
 * `a CURSOR of the same name disturbs nothing` is the whole reason the port was
 * built. While the seam's facts were reserved cursor keys, an app that stored
 * its position under `snapshotOrigin` overwrote the marker, and the store then
 * answered an as-of read below its snapshot -- about rows it does not have --
 * with `undefined`, which is an ordinary answer a caller acts on and which is
 * wrong. Neither that nor its sibling (an overwritten `retentionEnforcement`
 * makes a pruned store report it never pruned) looks like a failure from
 * outside, so the separation is asserted rather than assumed.
 */
export function seamRecordCases(factory: StateStoreFactory, options: StateStoreConformanceOptions): ConformanceCase[] {
	/** Something recognisable per key, so a mix-up between two records is visible. */
	const valueFor = (key: SeamRecordKey) => `{"record":"${key}"}`;

	const universal = cases(GROUP, {
		'are absent before anything writes one, rather than empty or thrown': async () => {
			const store = await opened(factory);
			for (const key of SEAM_RECORD_KEYS) {
				expect(await store.readSeamRecord(key)).toBeUndefined();
			}
		},

		'read back exactly the string that was written, and are overwritten in place': async () => {
			const store = await opened(factory);
			await store.writeSeamRecord('snapshotOrigin', '{"format":1,"block":100}');
			expect(await store.readSeamRecord('snapshotOrigin')).toBe('{"format":1,"block":100}');

			await store.writeSeamRecord('snapshotOrigin', '{"format":1,"block":200}');
			expect(await store.readSeamRecord('snapshotOrigin')).toBe('{"format":1,"block":200}');
		},

		'keep the three of them apart': async () => {
			const store = await opened(factory);
			for (const key of SEAM_RECORD_KEYS) await store.writeSeamRecord(key, valueFor(key));

			for (const key of SEAM_RECORD_KEYS) {
				expect(await store.readSeamRecord(key)).toBe(valueFor(key));
			}
		},

		'are forgotten by clear, and clearing an absent one is not an error': async () => {
			const store = await opened(factory);
			// the second half is what `openForWriting` does on every store it claims,
			// so a backend that took a short cut on it would skip the claim entirely.
			await store.clearSeamRecord('writerClaim');

			await store.writeSeamRecord('snapshotOrigin', '{"format":1,"block":100}');
			await store.clearSeamRecord('snapshotOrigin');
			expect(await store.readSeamRecord('snapshotOrigin')).toBeUndefined();
		},

		'a CURSOR of the same name disturbs nothing, in either direction': async () => {
			const store = await opened(factory);
			for (const key of SEAM_RECORD_KEYS) await store.writeSeamRecord(key, valueFor(key));

			// a caller writing a cursor called `snapshotOrigin` is doing nothing wrong:
			// the cursor port is entirely its own namespace, so this is a cursor with
			// an odd name and nothing more.
			for (const key of SEAM_RECORD_KEYS) await store.writeCursor(key, `a caller's ${key}`);

			for (const key of SEAM_RECORD_KEYS) {
				expect(await store.readSeamRecord(key)).toBe(valueFor(key));
				expect(await store.readCursor(key)).toBe(`a caller's ${key}`);
			}

			// and the reverse: clearing the seam's record must not take the caller's
			// cursor with it.
			await store.clearSeamRecord('snapshotOrigin');
			expect(await store.readCursor('snapshotOrigin')).toBe("a caller's snapshotOrigin");
		},

		'survive a revert, because none of them is entity state': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
			await store.writeSeamRecord('snapshotOrigin', '{"format":1,"block":100}');
			await store.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);

			await store.revertTo(LADDER_BASE);

			// a reorg does not move where a bootstrapped store's rows came from: that
			// is a fact about the INSTALL, and the floor it imposes is what refuses a
			// revert reaching under it in the first place.
			expect(await store.readSeamRecord('snapshotOrigin')).toBe('{"format":1,"block":100}');
		},

		'keep a bootstrapped floor honest after a caller writes a cursor of that name': async () => {
			// the regression in full, through the layer that owns the marker rather
			// than through the port directly: install a snapshot, let an app write its
			// own cursor under the marker's old name, and re-open as a later boot does.
			const inner = await factory(CONFORMANCE_ENTITIES);
			const store = await openSnapshotAware(inner);
			await store.bootstrap(
				{
					format: ENTITY_SNAPSHOT_FORMAT,
					processor: 'conformance-processor-v1',
					savedAt: '2026-08-24T00:00:00.000Z',
					takenAt: block(LADDER_BASE + 500),
					rows: [owns('1', '0xalice', 7)],
				},
				{processor: 'conformance-processor-v1'},
			);

			await store.writeCursor('snapshotOrigin', 'the position this app happens to call that');

			expect((await openSnapshotAware(inner)).snapshotOrigin).toBe(LADDER_BASE + 500);
		},
	});

	const twoWriters = options.twoWriters;
	if (!twoWriters) return universal;

	return [
		...universal,
		...cases(GROUP, {
			'are DURABLE: a second handle over the same storage reads what the first wrote': async () => {
				// the point of them being records rather than fields. A floor held in a
				// closure is gone the next time the tab opens, and the store goes back
				// to claiming history it never received; a second handle is the nearest
				// a suite can get to a reload.
				const [first, second] = await twoWriters.sharingStorage(CONFORMANCE_ENTITIES);
				await first.migrate();
				await first.writeSeamRecord('snapshotOrigin', '{"format":1,"block":100}');

				await second.migrate();
				expect(await second.readSeamRecord('snapshotOrigin')).toBe('{"format":1,"block":100}');
			},

			'are addressed APART on stores addressed apart, like everything else a store owns': async () => {
				// two generations of one indexer, or two unrelated indexers on one
				// origin. One of them bootstrapping from a snapshot must not impose a
				// history floor on the other, which indexed from the start block.
				const [left, right] = await twoWriters.addressedApart(CONFORMANCE_ENTITIES);
				await left.migrate();
				await right.migrate();

				await left.writeSeamRecord('snapshotOrigin', '{"format":1,"block":100}');

				expect(await right.readSeamRecord('snapshotOrigin')).toBeUndefined();
			},
		}),
	];
}
