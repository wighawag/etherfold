import {expect, test} from '@playwright/test';
import {mountHarness} from './harness.js';

/**
 * A published state snapshot installs whether its host served the `.gz` body
 * opaque or with `Content-Encoding: gzip` (so the runtime inflated it), on every
 * engine: the reader sniffs the gzip magic off a stream it peeks and never
 * buffers, and pipes it through the engine's own `DecompressionStream` only when
 * the magic is there. Both land in real IndexedDB on identical rows and the same
 * resume position, also when the body arrives one byte at a time; a body gzipped
 * twice is refused; and cancelling a reader after its head still cancels the
 * download underneath, each way.
 */

const CUT = new URL('./snapshotDelivery.cut.ts', import.meta.url).pathname;

test('a snapshot body served opaque or already inflated installs, identically', async ({page}) => {
	const harness = await mountHarness(page, {cut: CUT, coi: false});
	try {
		const tag = `snapshot-delivery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const run = await harness.run({phase: 'once', params: {tag}});
		expect(run.errors).toEqual([]);
		const results = run.results as Record<string, {rows: unknown[]; cursor: unknown; origin: unknown}> &
			Record<string, unknown>;

		// the already-inflated body is the ndjson text, so its first byte is `{`
		expect(results.plainFirstByte).toBe('{'.charCodeAt(0));

		const reference = results.opaque;
		expect(reference.rows[0]).toMatchObject({owner: '0xcarol', transferCount: 99});
		expect(reference.rows[1]).toBeUndefined();
		expect(reference.rows[2]).toMatchObject({owner: '0x31', transferCount: 49});
		expect(reference.cursor).toBe('synced-through-1001');
		expect(reference.origin).toBe(1_000);
		expect(results.inflated).toEqual(reference);
		expect(results.opaqueOneByte).toEqual(reference);
		expect(results.inflatedOneByte).toEqual(reference);

		expect(results.twice).toBe('SnapshotFormatError');

		expect(results.opaqueCancel).toEqual({before: false, after: true});
		expect(results.inflatedCancel).toEqual({before: false, after: true});
	} finally {
		await harness.dispose();
	}
});
