import {describe, expect, it} from 'vitest';
import {
	decodeFieldValues,
	encodeFieldValues,
	encodeSnapshot,
	MemoryStateStore,
	normalizeEntity,
	readSnapshot,
	u256,
	type EntityDeclaration,
} from '../src/index.js';
import {block} from './utils/fixtures.js';

/**
 * A declared `u256` (ADR-0098) at the seam: the one write-side conversion
 * (`encodeFieldValues`) and the one read-side conversion (`decodeFieldValues`)
 * every backend makes, and the snapshot document's wire form. The every-backend
 * half is the `a declared u256 is a bigint at the seam` group of
 * `@etherfold/state-store-conformance`.
 */

const POOL = {
	name: 'pool',
	id: 'id',
	fields: {amount: {storage: 'blob', type: 'u256'}, owner: 'text'},
} as const satisfies EntityDeclaration;

const MAX = 2n ** 256n - 1n;

describe('the seam converts a u256 once each way', () => {
	const entity = normalizeEntity(POOL);

	it('encodes a bigint to its 32 bytes on the way in, leaving the caller object and other fields alone', () => {
		const values = {amount: 10n, owner: '0xalice'};
		const stored = encodeFieldValues(entity, values);
		expect(stored).toEqual({amount: u256.encode(10n), owner: '0xalice'});
		expect(values.amount).toBe(10n);
		expect(encodeFieldValues(entity, {amount: null})).toEqual({amount: null});
	});

	it('decodes the stored bytes, whatever wrapper holds them, and passes every other column through', () => {
		const bytes = u256.encode(MAX);
		expect(decodeFieldValues(entity, {id: '1', amount: bytes, owner: null, _lower: 1})).toEqual({
			id: '1',
			amount: MAX,
			owner: null,
			_lower: 1,
		});
		expect(decodeFieldValues(entity, {amount: bytes.buffer})).toEqual({amount: MAX});
		expect(decodeFieldValues(entity, {amount: new DataView(bytes.buffer)})).toEqual({amount: MAX});
		expect(() => decodeFieldValues(entity, {amount: new Uint8Array(31)})).toThrow(/32 bytes/);
	});

	it('costs an entity with no semantic field nothing: the same object comes back', () => {
		const plain = normalizeEntity({name: 'token', id: 'id', fields: {owner: 'text'}});
		const values = {owner: '0xalice'};
		expect(encodeFieldValues(plain, values)).toBe(values);
		expect(decodeFieldValues(plain, values)).toBe(values);
	});

	it('refuses, naming the entity, the field and why', () => {
		expect(() => encodeFieldValues(entity, {amount: -1n})).toThrow(
			/pool field amount is declared as a u256 \(blob u256\).*negative.*refused rather than stored/,
		);
		expect(() => encodeFieldValues(entity, {amount: '1'})).toThrow(/not a bigint/);
	});
});

describe('a declared u256 in a snapshot document', () => {
	async function documentOf(amount: unknown, declarations: EntityDeclaration[] = [POOL]): Promise<Uint8Array> {
		const stream = encodeSnapshot(
			{processor: 'proc-v1', savedAt: '2026-09-28T00:00:00.000Z', takenAt: block(10), floor: 10},
			declarations,
			[{block: block(10), mutations: [{type: 'upsert', entity: 'pool', id: {id: '1'}, values: {amount}}]}],
		);
		return new Uint8Array(await new Response(stream).arrayBuffer());
	}

	async function linesOf(bytes: Uint8Array): Promise<string[]> {
		const text = await new Response(
			new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')),
		).text();
		return text.split('\n');
	}

	async function mutationsOf(bytes: Uint8Array) {
		const reader = await readSnapshot(bytes);
		const mutations = [];
		for await (const one of reader.blocks()) mutations.push(...one.mutations);
		return mutations;
	}

	it('travels in its canonical encoding, 32 bytes as hex, and reads back as the bigint', async () => {
		const bytes = await documentOf(9n);
		const lines = await linesOf(bytes);
		expect(lines).toContain(
			JSON.stringify({
				declare: 'pool',
				id: ['id'],
				fields: [
					['amount', {storage: 'blob', type: 'u256'}],
					['owner', 'text'],
				],
			}),
		);
		expect(lines).toContain(JSON.stringify(['1', `0x${'00'.repeat(31)}09`, null]));
		expect(await mutationsOf(bytes)).toEqual([
			{type: 'upsert', entity: 'pool', id: {id: '1'}, values: {amount: 9n, owner: null}},
		]);
	});

	it('refuses to write a value the type does not admit', async () => {
		await expect(documentOf(-1n)).rejects.toThrow(/negative/);
		await expect(documentOf('9')).rejects.toThrow(/not a bigint/);
	});

	it('refuses to read a stored form that is not canonical, or a semantic type this build does not know', async () => {
		// the same entity written as a bare blob of the wrong width, then relabelled a u256
		const shortRow = await documentOf(new Uint8Array([9]), [{...POOL, fields: {amount: 'blob', owner: 'text'}}]);
		const relabelled = (await linesOf(shortRow))
			.map((line) => line.replace(`[["amount","blob"]`, `[["amount",{"storage":"blob","type":"u256"}]`))
			.join('\n');
		const gzip = (text: string) =>
			new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
		await expect(mutationsOf(new Uint8Array(await gzip(relabelled)))).rejects.toThrow(/32 bytes/);

		const unknown = (await linesOf(await documentOf(9n))).map((line) => line.replace('"u256"', '"u512"')).join('\n');
		await expect(mutationsOf(new Uint8Array(await gzip(unknown)))).rejects.toThrow(/malformed/);
	});

	it('installs into the reference store as the bigint, held as its encoding', async () => {
		const store = new MemoryStateStore([POOL]);
		await store.applyBlock(block(10), [{type: 'upsert', entity: 'pool', id: {id: '1'}, values: {amount: MAX}}]);
		expect(await store.getCurrent('pool', {id: '1'})).toMatchObject({amount: MAX});
		expect(await store.storedCurrent('pool', {id: '1'})).toEqual({id: '1', amount: u256.encode(MAX), owner: null});
	});
});
