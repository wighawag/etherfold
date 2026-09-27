import {createClient} from '@libsql/client';
import {generationDigestOf, streamConfigHashOf, type GenerationId, type LastSync} from '@etherfold/core';
import {
	deserializeLastSync,
	openSnapshotAware,
	readSnapshot,
	serializeLastSync,
	SYNC_CURSOR_KEY,
	type BlockPointer,
	type EntityDeclaration,
	type Mutation,
} from '@etherfold/processor-entities';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {
	applySchema,
	mergePublicationIndex,
	openGenerationRegistryOnSQL,
	parsePublicationIndex,
	producePublication,
	PublicationRefusedError,
	PUBLICATION_INDEX_FORMAT,
	type PublicationIndex,
} from '../src/index.js';
import {bundleBytes, identityOf} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------------------------------
// THE PUBLICATION PRODUCER, ASKED DIRECTLY (ADR-0095)
// ---------------------------------------------------------------------------------------------------
// `producePublication` is the library function `etherfold publish` wraps and a
// serving host can answer over HTTP. What is asserted HERE is what only the
// producer decides, over a database built by hand so every number is visible:
// which generation it publishes, WHERE it cuts, WHICH block the rows point at,
// the resume position it writes for the cut, the body's content-addressed name,
// the index entry's key, and every refusal. The end-to-end property (a consumer
// installs the body and indexes forward over a chain with no skip and no double
// apply) is the CLI's suite, which has a chain.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'main';
const STREAM = 'a'.repeat(32);
const PROCESSOR = identityOf('published');
const OTHER = identityOf('another');
const FINALITY = 5;
const CONFIG = streamConfigHashOf({finality: FINALITY});

const TOKEN: EntityDeclaration = {name: 'token', id: ['id'], fields: {owner: 'text'}};
const COUNTER: EntityDeclaration = {name: 'counter', id: ['name'], fields: {value: 'integer'}};
const ENTITIES = [TOKEN, COUNTER];

const block = (number: number): BlockPointer => ({number, hash: `0xb${number.toString(16)}`, timestamp: number * 12});
const owns = (id: string, owner: string): Mutation => ({type: 'upsert', entity: 'token', id: {id}, values: {owner}});
const count = (value: number): Mutation => ({
	type: 'upsert',
	entity: 'counter',
	id: {name: 'transfers'},
	values: {value},
});

/** A cursor as a fold writes one: the window holds the event-bearing blocks within `finality` of the tip. */
function cursorAt(tip: number, window: number[]): LastSync<any> {
	return {
		context: {source: [{startBlock: 0, hash: 'source'}], config: CONFIG, processor: PROCESSOR},
		latestBlock: tip,
		lastFromBlock: tip - 10,
		lastToBlock: tip,
		unconfirmedBlocks: window.map((number) => ({number, hash: block(number).hash, events: []})),
	};
}

/**
 * A database a folding command could have written: the fixed schema, one canonical
 * generation (with its bundle stored beside it), and its state folded through
 * blocks 100, 103, 106 and 109, with the cursor at `tip`.
 */
async function aFoldedDatabase(tip = 110): Promise<{db: RemoteSQL; id: GenerationId; store: VersionedStateStore}> {
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	await applySchema(db);
	const id: GenerationId = {stream: STREAM, processor: PROCESSOR};
	const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: {maxGenerations: 4, maxStreams: 4}});
	await registry.create(id, {bundle: bundleBytes('published')});
	await registry.moveCanonicalTo(id);

	const store = new VersionedStateStore(db, ENTITIES, {tableNamespace: generationDigestOf(id)});
	await store.migrate();
	await store.applyBlock(block(100), [owns('1', '0xalice'), count(1)]);
	await store.applyBlock(block(103), [owns('2', '0xbob'), count(2)]);
	await store.applyBlock(block(106), [owns('1', '0xcarol'), count(3)]);
	await store.applyBlock(block(109), [owns('3', '0xdave'), count(4)], {
		key: SYNC_CURSOR_KEY,
		value: serializeLastSync(
			cursorAt(
				tip,
				[106, 109].filter((n) => tip - n <= FINALITY),
			),
		),
	});
	return {db, id, store};
}

const produce = (db: RemoteSQL, extra: {expectedProcessor?: string; finality?: number} = {}) =>
	producePublication(db, {
		stream: {finality: extra.finality ?? FINALITY},
		...(extra.expectedProcessor === undefined ? {} : {expectedProcessor: extra.expectedProcessor}),
		declarationsOf: async () => ENTITIES,
		savedAt: '2026-09-27T00:00:00.000Z',
	});

/** A row's DOMAIN values: the version bookkeeping (`_lower`, `_upper`, `_rowid`) is the store's own. */
function valuesOf(row: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	return row && Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('_')));
}

async function rowsOf(
	read: (entity: string, id: Record<string, string>) => Promise<Record<string, unknown> | undefined>,
) {
	return {
		one: valuesOf(await read('token', {id: '1'})),
		two: valuesOf(await read('token', {id: '2'})),
		three: valuesOf(await read('token', {id: '3'})),
		counter: valuesOf(await read('counter', {name: 'transfers'})),
	};
}

describe('the publication of a database', () => {
	it('cuts at tip - finality, points the rows at the highest recorded block at or below it', async () => {
		const {db, id} = await aFoldedDatabase(110);

		const published = await produce(db);

		expect(published.generation).toEqual(id);
		expect(published.indexer).toBe(INDEXER);
		expect(published.tip).toBe(110);
		expect(published.cut).toBe(105);
		// 105 carries no logs, so the pointer is 103: identical rows, a known hash
		expect(published.head.takenAt).toEqual(block(103));
		expect(published.head.floor).toBe(103);
		expect(published.head.processor).toBe(PROCESSOR);
	});

	it('writes the resume position AT THE CUT: the stored cursor narrowed to it, the observed tip kept', async () => {
		const {db} = await aFoldedDatabase(110);

		const published = await produce(db);
		const resume = deserializeLastSync(published.head.cursor!.value);

		expect(published.head.cursor!.key).toBe(SYNC_CURSOR_KEY);
		expect(resume.lastToBlock).toBe(105);
		expect(resume.latestBlock).toBe(110);
		// the window keeps what is at or below the cut, and 106 and 109 are above it
		expect(resume.unconfirmedBlocks).toEqual([]);
	});

	it('keeps the cut block in the window when the cut falls on a block that carries logs', async () => {
		const {db} = await aFoldedDatabase(111);

		const published = await produce(db);
		const resume = deserializeLastSync(published.head.cursor!.value);

		expect(published.cut).toBe(106);
		expect(published.head.takenAt).toEqual(block(106));
		expect(resume.lastToBlock).toBe(106);
		// a consumer resumes AT 106 (`latestBlock - finality`) and recognises it as applied
		expect(resume.unconfirmedBlocks.map((b) => b.number)).toEqual([106]);
	});

	it('is a body a fresh store installs, answering every read as the database does AS OF the cut', async () => {
		const {db, store} = await aFoldedDatabase(110);
		const published = await produce(db);

		const fresh = await openSnapshotAware(
			new VersionedStateStore(new RemoteLibSQL(createClient({url: ':memory:'})), ENTITIES),
		);
		await fresh.bootstrap(published.bodies[0]!.bytes, {processor: PROCESSOR});

		const asOfCut = await rowsOf((entity, id) => store.getAsOf(entity, id, 105));
		expect(await rowsOf((entity, id) => fresh.getCurrent(entity, id))).toEqual(asOfCut);
		expect(asOfCut.three).toBeUndefined();
		expect(asOfCut.counter).toMatchObject({value: 2});
		expect(fresh.snapshotOrigin).toBe(103);
	});

	it('names its body by the content hash of the decompressed document, and keys its entry by generation', async () => {
		const {db, id} = await aFoldedDatabase(110);

		const published = await produce(db);
		const [body] = published.bodies;
		const hex = createHash('sha256').update(gunzipSync(body!.bytes)).digest('hex');

		expect(body!.contentHash).toBe(`sha256:${hex}`);
		expect(body!.name).toBe(`state-${hex}.ndjson.gz`);
		expect((await readSnapshot(body!.bytes)).head).toEqual(published.head);
		expect(published.entries.snapshots).toEqual({
			[generationDigestOf(id)]: {
				stream: STREAM,
				processor: PROCESSOR,
				body: body!.name,
				contentHash: body!.contentHash,
				takenAt: block(103),
				floor: 103,
				cut: 105,
				savedAt: '2026-09-27T00:00:00.000Z',
			},
		});
	});

	it('publishes the expected processor when it IS the canonical generation', async () => {
		const {db} = await aFoldedDatabase(110);

		await expect(produce(db, {expectedProcessor: PROCESSOR})).resolves.toMatchObject({cut: 105});
	});
});

describe('a publication is refused, naming why', () => {
	async function refusal(promise: Promise<unknown>): Promise<PublicationRefusedError> {
		const error = await promise.then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(PublicationRefusedError);
		return error as PublicationRefusedError;
	}

	it('when the canonical generation is ANOTHER processor, naming both', async () => {
		const {db} = await aFoldedDatabase(110);

		const refused = await refusal(produce(db, {expectedProcessor: OTHER}));

		expect(refused.reason).toBe('processor-mismatch');
		expect(refused.message).toContain(PROCESSOR);
		expect(refused.message).toContain(OTHER);
	});

	it('when the database carries no generation registry', async () => {
		const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));

		expect((await refusal(produce(db))).reason).toBe('no-canonical-generation');
	});

	it('when no generation is registered, so none is canonical', async () => {
		const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
		await applySchema(db);

		expect((await refusal(produce(db))).reason).toBe('no-canonical-generation');
	});

	it('when the canonical generation has folded nothing up to the cut', async () => {
		// folded through 103 only: the cut is 98, below every recorded block
		const {db} = await aFoldedDatabase(103);

		const refused = await refusal(produce(db));

		expect(refused.reason).toBe('folded-nothing');
		expect(refused.message).toMatch(/folded nothing/);
	});

	it('when the stream config is not the one the generation was folded under', async () => {
		const {db} = await aFoldedDatabase(110);

		const refused = await refusal(produce(db, {finality: 2}));

		expect(refused.reason).toBe('stream-config-mismatch');
		expect(refused.message).toMatch(/STREAM_FINALITY/);
	});
});

describe('the publication index', () => {
	const entry = (processor: string, body: string) => ({
		stream: STREAM,
		processor,
		body,
		contentHash: `sha256:${body}`,
		takenAt: block(1),
		floor: 1,
		cut: 1,
		savedAt: 'now',
	});

	it("replaces only its own generation's entry, and keeps every other key it does not know", () => {
		const existing = {
			format: PUBLICATION_INDEX_FORMAT,
			snapshots: {mine: entry(PROCESSOR, 'first'), theirs: entry(OTHER, 'old')},
			later: {kept: true},
		} as PublicationIndex;

		const merged = mergePublicationIndex(existing, {snapshots: {mine: entry(PROCESSOR, 'second')}});

		expect(merged).toEqual({
			format: PUBLICATION_INDEX_FORMAT,
			snapshots: {mine: entry(PROCESSOR, 'second'), theirs: entry(OTHER, 'old')},
			later: {kept: true},
		});
	});

	it('refuses to read a document that is not an index of this format, rather than forgetting it', () => {
		for (const text of ['not json', '[]', '{"format": 2, "snapshots": {}}', '{"format": 1}']) {
			expect(() => parsePublicationIndex(text)).toThrow(PublicationRefusedError);
		}
		expect(parsePublicationIndex('{"format": 1, "snapshots": {}}')).toEqual({format: 1, snapshots: {}});
	});
});
