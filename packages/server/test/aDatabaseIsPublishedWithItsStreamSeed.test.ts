import {createClient} from '@libsql/client';
import {
	generationDigestOf,
	parseStreamSeed,
	pinnedStreamSeedContentHash,
	resolveStreamConfig,
	streamConfigHashOf,
	streamDigestOfSourceHashes,
	streamSeedContentHash,
	type EmittedLog,
	type GenerationId,
	type LastSync,
	type SourceHashEntry,
	type StreamSeed,
} from '@etherfold/core';
import {serializeLastSync, SYNC_CURSOR_KEY, type EntityDeclaration} from '@etherfold/processor-entities';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {gunzipSync} from 'node:zlib';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {
	appendEmissions,
	applySchema,
	mergePublicationIndex,
	openGenerationRegistryOnSQL,
	parsePublicationIndex,
	producePublication,
	PublicationRefusedError,
	PUBLICATION_INDEX_FORMAT,
	type PublicationIndex,
	type PublishedStreamSeed,
} from '../src/index.js';
import {bundleBytes, identityOf} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------------------------------
// THE STREAM SEED HALF OF A PUBLICATION, ASKED DIRECTLY (ADR-0095)
// ---------------------------------------------------------------------------------------------------
// With `seed: true`, `producePublication` also answers the stream the canonical
// generation folds, as `_emissions` stores it, cut at the SAME block as the state
// snapshot, in core's seed envelope. Asserted here over a database built by hand,
// so every number is visible: the coverage, the events it carries and the ones it
// does not, the digest and content hash, the index entry keyed by STREAM, the
// reorg pairs it drops, and the refusal. That the body INSTALLS through
// `installStreamSeed` and re-folds to the snapshot's state is the CLI's suite,
// which has a real bundle whose source a client can hash.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'main';
const FINALITY = 5;
const STREAM_CONFIG = resolveStreamConfig({finality: FINALITY});
const CONFIG = streamConfigHashOf(STREAM_CONFIG);
const START = 90;
const SOURCE: SourceHashEntry[] = [{startBlock: START, hash: 'state-hash', streamHash: 'stream-hash'}];
/** The real digest of that source and config: the seed's identity is recomputed, never believed. */
const STREAM = streamDigestOfSourceHashes(SOURCE, STREAM_CONFIG);
const PROCESSOR = identityOf('published');
const TIP = 110;
const CUT = TIP - FINALITY;

const COUNTER: EntityDeclaration = {name: 'counter', id: ['name'], fields: {value: 'integer'}};

const hashOf = (number: number, branch = 'a') => `0x${branch}${number.toString(16)}` as `0x${string}`;
const log = (blockNumber: number, logIndex = 0, branch = 'a', removed = false): EmittedLog =>
	({
		blockNumber,
		blockHash: hashOf(blockNumber, branch),
		logIndex,
		transactionHash: `0xt${blockNumber}${branch}${logIndex}`,
		transactionIndex: 0,
		address: '0x0000000000000000000000000000000000000099',
		topics: ['0xdead'],
		data: '0x',
		removed,
	}) as EmittedLog;

/**
 * The 32-bit WIRE context a fold's cursor carries (`wireContextOf`): one
 * whole-source entry, with no per-event stream hash, so it digests to no stream.
 */
const WIRE_SOURCE: SourceHashEntry[] = [{startBlock: 0, hash: 'whole-source'}];

/** A cursor as a fold writes one, folded through `TIP`: its source is the wire context, never the seed's identity. */
function cursorAt(tip: number): LastSync<any> {
	return {
		context: {source: WIRE_SOURCE, config: CONFIG, processor: PROCESSOR},
		latestBlock: tip,
		lastFromBlock: tip - 10,
		lastToBlock: tip,
		unconfirmedBlocks: [],
	};
}

/**
 * A database `build` could have written: one canonical generation over `STREAM`,
 * its state folded through `TIP`, and the stream it folds stored in `_emissions`
 * in the batches the fold appended.
 */
async function aFoldedDatabase(
	batches: EmittedLog[][] = [[log(100), log(100, 1)], [log(103)], [log(106), log(109)]],
	recorded: SourceHashEntry[] = SOURCE,
): Promise<{db: RemoteSQL; id: GenerationId}> {
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	await applySchema(db);
	const id: GenerationId = {stream: STREAM, processor: PROCESSOR};
	const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: {maxGenerations: 4, maxStreams: 4}});
	await registry.create(id, {bundle: bundleBytes('published')});
	await registry.moveCanonicalTo(id);

	let from = START;
	for (const [position, emissions] of batches.entries()) {
		const to = position === batches.length - 1 ? TIP : Math.max(...emissions.map((e) => e.blockNumber), from);
		await appendEmissions(db, {
			indexer: INDEXER,
			stream: STREAM,
			coverage: {source: recorded, config: CONFIG, latestBlock: TIP, lastFromBlock: from, lastToBlock: to},
			emissions,
		});
		from = to + 1;
	}

	const store = new VersionedStateStore(db, [COUNTER], {tableNamespace: generationDigestOf(id)});
	await store.migrate();
	const block = (number: number) => ({number, hash: hashOf(number), timestamp: 1_000 + number});
	await store.applyBlock(block(100), [{type: 'upsert', entity: 'counter', id: {name: 'n'}, values: {value: 1}}]);
	await store.applyBlock(block(103), [{type: 'upsert', entity: 'counter', id: {name: 'n'}, values: {value: 2}}], {
		key: SYNC_CURSOR_KEY,
		value: serializeLastSync(cursorAt(TIP)),
	});
	return {db, id};
}

/** `seed: true` unless told otherwise; `{seed: undefined}` leaves the option out, as a caller that never heard of it does. */
const produce = (db: RemoteSQL, asked: {seed?: boolean} = {seed: true}) =>
	producePublication(db, {
		stream: {finality: FINALITY},
		declarationsOf: async () => [COUNTER],
		savedAt: '2026-09-27T00:00:00.000Z',
		...(asked.seed === undefined ? {} : {seed: asked.seed}),
	});

function seedIn(published: Awaited<ReturnType<typeof produce>>): {seed: StreamSeed; payload: Uint8Array} {
	const body = published.bodies.find((one) => one.name === published.seed!.body)!;
	const payload = gunzipSync(body.bytes);
	return {seed: parseStreamSeed(payload.toString('utf-8')), payload};
}

const at = (seed: StreamSeed) => seed.eventStream.map((event) => `${event.blockNumber}:${event.logIndex}`);

describe('a publication asked for a seed', () => {
	it('carries the stored stream from its start block up to the SAME cut as the snapshot, and nothing above it', async () => {
		const {db} = await aFoldedDatabase();

		const published = await produce(db);
		const {seed} = seedIn(published);

		expect(published.cut).toBe(CUT);
		expect(seed.coverage).toEqual({fromBlock: START, toBlock: CUT});
		// 106 and 109 are inside the reorg window above the cut: the chain's, not the seed's
		expect(at(seed)).toEqual(['100:0', '100:1', '103:0']);
		expect(published.seed).toMatchObject({coverage: {fromBlock: START, toBlock: CUT}, events: 3});
	});

	it("is core's envelope: the stream's own context, its digest, a stored-stream producer, a head finality above the cut", async () => {
		const {db} = await aFoldedDatabase();

		const {seed} = seedIn(await produce(db));

		expect(seed.format).toBe(1);
		expect(seed.streamDigest).toBe(STREAM);
		expect(seed.streamConfig).toEqual(STREAM_CONFIG);
		expect(seed.context).toEqual({source: SOURCE, config: CONFIG, processor: ''});
		expect(seed.producer.kind).toBe('stored-stream');
		// the install's capture-depth check holds by construction
		expect(seed.chainHeadAtCapture - seed.coverage.toBlock).toBe(FINALITY);
		// stripped to what the node said (ADR-0060): nothing decoded, no bookkeeping of ours
		for (const event of seed.eventStream) {
			expect(Object.keys(event).sort()).toEqual(
				[
					'address',
					'blockHash',
					'blockNumber',
					'data',
					'logIndex',
					'removed',
					'topics',
					'transactionHash',
					'transactionIndex',
				].sort(),
			);
		}
	});

	it('names its body by the content hash a pin accepts, and keys its index entry by STREAM', async () => {
		const {db, id} = await aFoldedDatabase();

		const published = await produce(db);
		const {payload} = seedIn(published);
		const printed = published.seed!.contentHash;

		expect(printed).toBe(streamSeedContentHash(payload));
		expect(pinnedStreamSeedContentHash(printed)).toBe(printed);
		expect(published.seed!.body).toBe(`seed-${printed.slice('sha256:'.length)}.json.gz`);
		expect(published.bodies.map((body) => body.name)).toContain(published.seed!.body);
		expect(published.entries.seeds).toEqual({
			[STREAM]: {
				stream: STREAM,
				body: published.seed!.body,
				contentHash: printed,
				coverage: {fromBlock: START, toBlock: CUT},
				events: 3,
				savedAt: '2026-09-27T00:00:00.000Z',
			},
		});
		// the snapshot is still keyed by GENERATION: the two maps are keyed apart
		expect(Object.keys(published.entries.snapshots)).toEqual([generationDigestOf(id)]);
	});

	it('is the same bytes when the same cut is published again', async () => {
		const {db} = await aFoldedDatabase();

		const first = await produce(db);
		const again = await producePublication(db, {
			stream: {finality: FINALITY},
			declarationsOf: async () => [COUNTER],
			savedAt: '2027-01-01T00:00:00.000Z',
			seed: true,
		});

		expect(again.seed!.contentHash).toBe(first.seed!.contentHash);
	});

	it('drops a reorg below the cut as its apply/retract pairs, keeping the branch that won', async () => {
		// block 103 applied on branch a, retracted, and replaced on branch b: what the
		// append-only stream keeps until pair-compaction reclaims it (ADR-0006)
		const {db} = await aFoldedDatabase([
			[log(100)],
			[log(103, 0, 'a')],
			[log(103, 0, 'a', true), log(103, 0, 'b'), log(104, 0, 'b')],
			[log(109)],
		]);

		const {seed} = seedIn(await produce(db));

		expect(seed.eventStream.map((event) => `${event.blockNumber}:${event.blockHash}`)).toEqual([
			`100:${hashOf(100)}`,
			`103:${hashOf(103, 'b')}`,
			`104:${hashOf(104, 'b')}`,
		]);
		expect(seed.eventStream.some((event) => event.removed)).toBe(false);
	});

	it('reads a stream longer than one replay chunk whole', async () => {
		const many = Array.from({length: 30}, (_, n) => log(91 + (n % 14), Math.floor(n / 14)));
		const byBlock = [...many].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
		// one batch per block, so the stream is appended the way a fold appends it
		const batches: EmittedLog[][] = [];
		for (const event of byBlock) {
			const last = batches.at(-1);
			if (last && last[0]!.blockNumber === event.blockNumber) last.push(event);
			else batches.push([event]);
		}
		batches.push([]);
		const {db} = await aFoldedDatabase(batches);

		const whole = seedIn(await produce(db)).seed;
		const chunked = seedIn(
			await producePublication(db, {
				stream: {finality: FINALITY},
				declarationsOf: async () => [COUNTER],
				savedAt: '2026-09-27T00:00:00.000Z',
				seed: true,
				// several reads of the replay source, each cut on a block boundary
				seedReadBudget: 4,
			}),
		).seed;

		expect(at(whole)).toEqual(byBlock.map((event) => `${event.blockNumber}:${event.logIndex}`));
		expect(chunked).toEqual(whole);
	});
});

describe('a publication NOT asked for a seed', () => {
	it('produces no seed body and no seed entry', async () => {
		for (const seed of [undefined, false]) {
			const {db} = await aFoldedDatabase();

			const published = await produce(db, {seed});

			expect(published.seed).toBeUndefined();
			expect(published.bodies).toHaveLength(1);
			expect(published.entries.seeds).toBeUndefined();
		}
	});
});

describe('a seed is refused, naming why', () => {
	it('when the database stores no stream for the canonical generation', async () => {
		const {db} = await aFoldedDatabase();
		await db.prepare(`DELETE FROM _stream_coverage`).all();

		const error = await produce(db).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(PublicationRefusedError);
		expect((error as PublicationRefusedError).reason).toBe('no-stored-stream');
		expect((error as PublicationRefusedError).message).toMatch(/without --seed/);
		// ...and the same database publishes its snapshot when no seed is asked for
		await expect(produce(db, {seed: false})).resolves.toMatchObject({cut: CUT});
	});
});

describe('a seed is refused for a database that does not record its stream identity', () => {
	const DEFAULT_BATCHES = [[log(100), log(100, 1)], [log(103)], [log(106), log(109)]];

	async function refusalOf(db: RemoteSQL): Promise<PublicationRefusedError> {
		const error = await produce(db).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(PublicationRefusedError);
		return error as PublicationRefusedError;
	}

	it('when its coverage claim holds only the wire context a database folded before the identity was recorded holds', async () => {
		const {db} = await aFoldedDatabase(DEFAULT_BATCHES, WIRE_SOURCE);

		const error = await refusalOf(db);

		expect(error.reason).toBe('no-stream-identity');
		expect(error.message).toMatch(/does not record the full source identity/);
		expect(error.message).toMatch(/without --seed/);
		// the state snapshot is unaffected
		await expect(produce(db, {seed: false})).resolves.toMatchObject({cut: CUT});
	});

	it('when the identity it records does not digest to the canonical generation stream', async () => {
		const {db} = await aFoldedDatabase(DEFAULT_BATCHES, [{...SOURCE[0]!, streamHash: 'another-filter'}]);

		const error = await refusalOf(db);

		expect(error.reason).toBe('no-stream-identity');
		expect(error.message).toContain(STREAM);
	});
});

describe('the publication index, with seeds', () => {
	const seedEntry = (stream: string, body: string): PublishedStreamSeed => ({
		stream,
		body,
		contentHash: `sha256:${body}`,
		coverage: {fromBlock: 1, toBlock: 2},
		events: 0,
		savedAt: 'now',
	});

	it("replaces only its own stream's seed, and keeps every other stream's", () => {
		const existing: PublicationIndex = {
			format: PUBLICATION_INDEX_FORMAT,
			snapshots: {},
			seeds: {mine: seedEntry('mine', 'first'), theirs: seedEntry('theirs', 'old')},
		};

		const merged = mergePublicationIndex(existing, {snapshots: {}, seeds: {mine: seedEntry('mine', 'second')}});

		expect(merged.seeds).toEqual({mine: seedEntry('mine', 'second'), theirs: seedEntry('theirs', 'old')});
	});

	it("keeps another stream's seed when this publication carries none, and adds no seed map of its own", () => {
		const existing: PublicationIndex = {
			format: PUBLICATION_INDEX_FORMAT,
			snapshots: {},
			seeds: {theirs: seedEntry('theirs', 'old')},
		};

		expect(mergePublicationIndex(existing, {snapshots: {}}).seeds).toEqual({theirs: seedEntry('theirs', 'old')});
		expect(mergePublicationIndex(undefined, {snapshots: {}})).not.toHaveProperty('seeds');
	});

	it('refuses an index whose seeds are not a map, rather than forgetting them', () => {
		for (const text of ['{"format": 1, "snapshots": {}, "seeds": []}', '{"format": 1, "snapshots": {}, "seeds": 3}']) {
			expect(() => parsePublicationIndex(text)).toThrow(PublicationRefusedError);
		}
		expect(parsePublicationIndex('{"format": 1, "snapshots": {}, "seeds": {}}')).toEqual({
			format: 1,
			snapshots: {},
			seeds: {},
		});
	});
});
