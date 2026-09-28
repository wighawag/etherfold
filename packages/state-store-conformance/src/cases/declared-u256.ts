import {
	assertFieldValues,
	encodeSnapshot,
	normalizeEntities,
	normalizeEntity,
	openSnapshotAware,
	readSnapshot,
	u256,
	type EntityDeclaration,
	type Mutation,
	type StateStoreCapabilities,
} from '@etherfold/state-store';
import {expect} from 'vitest';
import {answersHistoryOverLadder, block, cases} from '../fixtures.js';
import type {ConformanceCase, StateStoreConformanceOptions, StateStoreFactory} from '../types.js';

const GROUP = 'a declared u256 is a bigint at the seam';

/**
 * An entity with one `u256` field, beside a bare `blob` that means what it always
 * meant. `pool` has a two-column id so a listing has a prefix to scan.
 */
const POOL: EntityDeclaration = {
	name: 'pool',
	id: ['chain', 'id'],
	fields: {amount: {storage: 'blob', type: 'u256'}, note: 'blob'},
};

const DECLARED: readonly EntityDeclaration[] = [POOL];

const MAX = 2n ** 256n - 1n;

/** The boundaries a 32-byte big-endian encoding has to get right, and one ordinary value. */
const BOUNDARIES: readonly bigint[] = [0n, 1n, 2n ** 64n, 10n ** 18n, MAX];

function pool(id: string, values: Record<string, unknown>, chain = '1'): Mutation {
	return {type: 'upsert', entity: 'pool', id: {chain, id}, values};
}

/** What the seam says about a write, as the message a backend must repeat. */
function seamRefusal(values: Record<string, unknown>): string {
	try {
		assertFieldValues(normalizeEntity(POOL), values);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error('the seam accepted a value this case expects it to refuse');
}

/** Any byte wrapper a storage engine hands back, as plain bytes, so two forms compare as bytes. */
function bytesOf(value: unknown): number[] | unknown {
	if (value instanceof Uint8Array) return [...value];
	if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
	if (ArrayBuffer.isView(value)) return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
	return value;
}

/**
 * A `u256` is a SEMANTIC TYPE beside the `blob` storage class (ADR-0098): at the
 * seam it is a `bigint` (a handler writes one, and every read answers one), and
 * every backend holds it in its canonical encoding, 32 big-endian bytes. Every
 * backend must agree, in ONE change, because a declaration that means a `bigint`
 * on a server and bytes (or a string) in a browser fails silently. So: what is
 * written is what is read, at the tip, as of a block and in a listing; equal
 * values are equal; a value the type does not admit is refused at WRITE time in
 * the seam's own words and leaves the store as it was; the stored form is the
 * canonical encoding; and an entity declaring one travels through a snapshot
 * document and installs.
 *
 * The seam still orders only ids (ADR-0021), so nothing here asks for an order
 * over the field: that is the accessor's promise, not this chapter's.
 */
export function declaredU256Cases(
	factory: StateStoreFactory,
	capabilities: StateStoreCapabilities,
	options: StateStoreConformanceOptions,
): ConformanceCase[] {
	async function opened() {
		const store = await factory(DECLARED);
		await store.migrate();
		return store;
	}

	const storedCurrent = options.storedCurrent;

	return [
		...cases(GROUP, {
			'a bigint written is the bigint read, at the tip and in a listing, NULL included': async () => {
				const store = await opened();
				await store.applyBlock(block(100), [
					...BOUNDARIES.map((value, index) => pool(String(index), {amount: value, note: new Uint8Array([index])})),
					pool('9', {amount: null}),
					pool('8', {note: new Uint8Array([8])}),
				]);

				for (const [index, value] of BOUNDARIES.entries()) {
					const row = await store.getCurrent<Record<string, unknown>>('pool', {chain: '1', id: String(index)});
					expect(typeof row?.amount, `the value at ${value}`).toBe('bigint');
					expect(row?.amount).toBe(value);
					// the bare blob beside it is untouched: still bytes
					expect(bytesOf(row?.note)).toEqual([index]);
				}
				expect(await store.getCurrent('pool', {chain: '1', id: '9'})).toMatchObject({amount: null});
				expect(await store.getCurrent('pool', {chain: '1', id: '8'})).toMatchObject({amount: null});

				const listing = await store.listCurrent<Record<string, unknown>>('pool', {chain: '1'}, 16);
				expect(listing.truncated).toBe(false);
				const amounts = Object.fromEntries(listing.rows.map((row) => [row.id, row.amount]));
				expect(amounts).toEqual({
					...Object.fromEntries(BOUNDARIES.map((value, index) => [String(index), value])),
					'8': null,
					'9': null,
				});
			},

			'equal values are equal, whichever row and block wrote them, and a changed value is read changed': async () => {
				const store = await opened();
				const value = 2n ** 200n + 12345n;
				await store.applyBlock(block(100), [pool('a', {amount: value})]);
				await store.applyBlock(block(101), [pool('b', {amount: 2n ** 200n + 12345n})]);
				const a = await store.getCurrent<{amount: bigint}>('pool', {chain: '1', id: 'a'});
				const b = await store.getCurrent<{amount: bigint}>('pool', {chain: '1', id: 'b'});
				expect(a?.amount).toBe(b?.amount);
				expect(u256.equals(a!.amount, b!.amount)).toBe(true);

				await store.applyBlock(block(102), [pool('a', {amount: value + 1n})]);
				expect((await store.getCurrent<{amount: bigint}>('pool', {chain: '1', id: 'a'}))?.amount).toBe(value + 1n);
			},

			...Object.fromEntries(
				(
					[
						['a negative bigint', -1n],
						['a bigint wider than 256 bits', 2n ** 256n],
						['a number', 1],
						['a decimal string', '1'],
						['its own encoding, as bytes', new Uint8Array(32)],
					] as const
				).map(([shape, value]) => [
					`${shape} is refused at WRITE time, in the seam's own words, and the block writes nothing`,
					async () => {
						const store = await opened();
						await store.applyBlock(block(100), [pool('1', {amount: 7n})], {key: 'lastSync', value: 'at-100'});

						const expected = seamRefusal({amount: value});
						expect(expected).toMatch(/pool field amount is declared as a u256/);
						const error = await store
							.applyBlock(block(101), [pool('1', {amount: 8n}), pool('2', {amount: value})], {
								key: 'lastSync',
								value: 'at-101',
							})
							.then(
								() => undefined,
								(thrown: unknown) => thrown,
							);
						expect(error, `the backend stored ${shape}`).toBeInstanceOf(Error);
						expect((error as Error).message).toBe(expected);

						expect(await store.getCurrent('pool', {chain: '1', id: '1'})).toMatchObject({amount: 7n});
						expect(await store.getCurrent('pool', {chain: '1', id: '2'})).toBeUndefined();
						expect(await store.readCursor('lastSync')).toBe('at-100');
						// the height was not recorded either: the same block, corrected, lands
						await store.applyBlock(block(101), [pool('2', {amount: 8n})]);
						expect(await store.getCurrent('pool', {chain: '1', id: '2'})).toMatchObject({amount: 8n});
					},
				]),
			),

			'an entity declaring a u256 survives a snapshot-document round trip and install': async () => {
				const rows = [pool('1', {amount: MAX, note: new Uint8Array([1, 2])}), pool('2', {amount: 0n})];
				const document = encodeSnapshot(
					{
						processor: 'conformance-processor-v1',
						savedAt: '2026-09-28T00:00:00.000Z',
						takenAt: block(101),
						floor: 100,
						cursor: {key: 'lastSync', value: 'at-101'},
					},
					DECLARED,
					[
						{block: block(100), mutations: rows},
						{block: block(101), mutations: [pool('2', {amount: 10n ** 18n})]},
					],
				);
				const bytes = new Uint8Array(await new Response(document).arrayBuffer());

				const reader = await readSnapshot(bytes);
				const decoded: Mutation[] = [];
				for await (const one of reader.blocks({declarations: normalizeEntities(DECLARED)})) {
					decoded.push(...one.mutations);
				}
				expect(decoded).toEqual([
					pool('1', {amount: MAX, note: new Uint8Array([1, 2])}),
					pool('2', {amount: 0n, note: null}),
					pool('2', {amount: 10n ** 18n, note: null}),
				]);

				const store = await openSnapshotAware(await factory(DECLARED));
				await store.migrate();
				await store.bootstrap(bytes, {processor: 'conformance-processor-v1'});
				expect(await store.getCurrent('pool', {chain: '1', id: '1'})).toMatchObject({amount: MAX});
				expect(await store.getCurrent('pool', {chain: '1', id: '2'})).toMatchObject({amount: 10n ** 18n});
				expect(await store.readCursor('lastSync')).toBe('at-101');
			},

			'a snapshot declaring the field as a bare blob is refused by a store that declares it a u256': async () => {
				const bare: EntityDeclaration = {...POOL, fields: {amount: 'blob', note: 'blob'}};
				const document = encodeSnapshot(
					{
						processor: 'conformance-processor-v1',
						savedAt: '2026-09-28T00:00:00.000Z',
						takenAt: block(100),
						floor: 100,
					},
					[bare],
					[{block: block(100), mutations: [pool('1', {amount: u256.encode(5n)})]}],
				);
				const bytes = new Uint8Array(await new Response(document).arrayBuffer());

				const store = await openSnapshotAware(await factory(DECLARED));
				await store.migrate();
				const error = await store.bootstrap(bytes, {processor: 'conformance-processor-v1'}).then(
					() => undefined,
					(thrown: unknown) => thrown,
				);
				expect(error, 'the store installed bytes under a u256 column').toBeInstanceOf(Error);
				expect((error as Error).message).toMatch(/amount: blob\b.*amount: blob u256/);
				expect(await store.getCurrent('pool', {chain: '1', id: '1'})).toBeUndefined();
			},
		}),

		...(answersHistoryOverLadder(capabilities)
			? cases(GROUP, {
					'a bigint written is the bigint read AS OF a block, one by one and in a listing': async () => {
						const store = await opened();
						await store.applyBlock(block(100), [pool('1', {amount: 1n}), pool('2', {amount: MAX})]);
						await store.applyBlock(block(101), [pool('1', {amount: 2n ** 64n}), pool('2', {amount: 0n})]);

						expect(await store.getAsOf('pool', {chain: '1', id: '1'}, 100)).toMatchObject({amount: 1n});
						expect(await store.getAsOf('pool', {chain: '1', id: '1'}, 101)).toMatchObject({amount: 2n ** 64n});
						expect(await store.getAsOf('pool', {chain: '1', id: '2'}, 100)).toMatchObject({amount: MAX});

						const listing = await store.listAsOf<Record<string, unknown>>('pool', {chain: '1'}, 100, 4);
						expect(listing.rows.map((row) => row.amount)).toEqual([1n, MAX]);
					},
				})
			: []),

		...(storedCurrent
			? cases(GROUP, {
					'the stored form is the canonical encoding: 32 big-endian bytes, the same for equal values': async () => {
						const store = await opened();
						await store.applyBlock(
							block(100),
							BOUNDARIES.map((value, index) => pool(String(index), {amount: value})),
						);
						await store.applyBlock(block(101), [pool('again', {amount: 10n ** 18n})]);

						for (const [index, value] of BOUNDARIES.entries()) {
							const stored = await storedCurrent(store, 'pool', {chain: '1', id: String(index)});
							expect(stored, `nothing stored for ${value}`).toBeDefined();
							expect(bytesOf(stored?.amount), `the stored form of ${value}`).toEqual([...u256.encode(value)]);
						}
						const again = await storedCurrent(store, 'pool', {chain: '1', id: 'again'});
						const first = await storedCurrent(store, 'pool', {chain: '1', id: String(BOUNDARIES.indexOf(10n ** 18n))});
						expect(bytesOf(again?.amount)).toEqual(bytesOf(first?.amount));
					},
				})
			: []),
	];
}
