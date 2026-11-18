import {beforeEach, describe, expect, it} from 'vitest';
import {
	canonicalFeed,
	createConsumer,
	listDeliveries,
	readJournal,
	type CanonicalFeed,
	type CanonicalPage,
	type Matcher,
} from '../src/index.js';
import {diskDB, failingNextBatch, memoryDB} from './utils/db.js';
import {
	ALICE,
	BASE_URL,
	BOB,
	CAROL,
	CHAIN_ID,
	INDEXER,
	posted,
	startEtherfold,
	type Etherfold,
} from './utils/etherfold.js';

// ---------------------------------------------------------------------------
// THE CONSUMER LOOP (etherfold ADR-0005, ADR-0007's safe lane)
// ---------------------------------------------------------------------------
// It follows `/{indexer}/canonical?gate=` from an in-process etherfold server,
// and its whole correctness claim is ONE sentence: the cursor a page hands back
// and the deliveries that page implies are committed together or not at all.
// The matcher here is the simplest one possible (one delivery per log), because
// what is under test is the loop, not the triggers.
// ---------------------------------------------------------------------------

/** One delivery per log, keyed by where the log is. */
const everyLog: Matcher = async (entry) => [
	{
		action: 'record',
		key: `${entry.blockHash}:${entry.logIndex}`,
		recipient: entry.topics[1] ?? 'nobody',
		payload: {block: entry.blockNumber},
		trigger: 'every-log',
	},
];

let etherfold: Etherfold;
beforeEach(async () => {
	etherfold = await startEtherfold();
});

function consumerOn(db: ReturnType<typeof memoryDB>, gate: {value: number}, match: Matcher = everyLog) {
	return createConsumer({
		db,
		name: INDEXER,
		chainId: CHAIN_ID,
		feed: canonicalFeed({url: BASE_URL, indexer: INDEXER, fetch: etherfold.fetch}),
		gate: async () => gate.value,
		match,
		limit: 2,
	});
}

describe('following the canonical view', () => {
	it('writes the deliveries of every log at or below the gate, and nothing above it until the gate rises', async () => {
		await etherfold.ingest(100, 110, [
			posted({block: 101, hash: '0xa101', author: ALICE, count: 1n}),
			posted({block: 103, hash: '0xa103', author: BOB, count: 1n}),
			posted({block: 104, hash: '0xa104', author: CAROL, count: 1n}),
			posted({block: 108, hash: '0xa108', author: ALICE, count: 2n}),
		]);
		const db = memoryDB();
		const gate = {value: 104};
		const consumer = consumerOn(db, gate);
		await consumer.setup();

		await consumer.catchUp();
		expect((await listDeliveries(db)).map((d) => d.blockNumber)).toEqual([101, 103, 104]);

		// caught up: another pass at the same gate changes nothing
		const again = await consumer.catchUp();
		expect(again.deliveries).toBe(0);
		expect(await listDeliveries(db)).toHaveLength(3);

		gate.value = 110;
		await consumer.catchUp();
		expect((await listDeliveries(db)).map((d) => d.blockNumber)).toEqual([101, 103, 104, 108]);
	});

	it('records each delivery pending, with the log it came from', async () => {
		await etherfold.ingest(100, 105, [posted({block: 102, hash: '0xa102', author: ALICE, count: 1n})]);
		const db = memoryDB();
		const consumer = consumerOn(db, {value: 105});
		await consumer.setup();
		await consumer.catchUp();
		const [delivery] = await listDeliveries(db);
		expect(delivery).toMatchObject({
			consumer: INDEXER,
			action: 'record',
			key: '0xa102:0',
			status: 'pending',
			attempts: 0,
			blockNumber: 102,
			blockHash: '0xa102',
			logIndex: 0,
			trigger: 'every-log',
			payload: {block: 102},
		});
		expect(delivery?.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
	});
});

describe('the cursor and the outbox move together', () => {
	it('a commit that fails moves neither, and the page is matched again rather than lost or doubled', async () => {
		await etherfold.ingest(100, 105, [
			posted({block: 101, hash: '0xa101', author: ALICE, count: 1n}),
			posted({block: 102, hash: '0xa102', author: BOB, count: 1n}),
			posted({block: 103, hash: '0xa103', author: CAROL, count: 1n}),
		]);
		const failing = failingNextBatch(memoryDB());
		const consumer = consumerOn(failing.db, {value: 105});
		await consumer.setup();

		failing.failNext();
		await expect(consumer.step()).rejects.toThrow(/went away/);
		expect(await listDeliveries(failing.db)).toEqual([]);

		await consumer.catchUp();
		expect((await listDeliveries(failing.db)).map((d) => d.blockNumber)).toEqual([101, 102, 103]);
	});

	it('survives a restart: a new process on the same database resumes where the last commit left it', async () => {
		await etherfold.ingest(100, 110, [
			posted({block: 101, hash: '0xa101', author: ALICE, count: 1n}),
			posted({block: 102, hash: '0xa102', author: BOB, count: 1n}),
			posted({block: 103, hash: '0xa103', author: CAROL, count: 1n}),
			posted({block: 104, hash: '0xa104', author: ALICE, count: 2n}),
		]);
		const disk = diskDB();
		try {
			const first = consumerOn(disk.open(), {value: 110});
			await first.setup();
			await first.step(); // one page of two
			disk.close();

			const db = disk.open();
			const second = consumerOn(db, {value: 110});
			await second.setup();
			await second.catchUp();
			expect((await listDeliveries(db)).map((d) => d.blockNumber)).toEqual([101, 102, 103, 104]);
		} finally {
			disk.remove();
		}
	});

	it('a match the outbox already holds is not written twice', async () => {
		await etherfold.ingest(100, 105, [posted({block: 101, hash: '0xa101', author: ALICE, count: 1n})]);
		const db = memoryDB();
		const sameKey: Matcher = async () => [
			{action: 'record', key: 'always-the-same', recipient: ALICE, payload: {}, trigger: 't'},
			{action: 'record', key: 'always-the-same', recipient: ALICE, payload: {}, trigger: 't'},
		];
		const consumer = consumerOn(db, {value: 105}, sameKey);
		await consumer.setup();
		await consumer.catchUp();
		expect(await listDeliveries(db)).toHaveLength(1);
	});
});

describe('a rewind answered by the canonical view', () => {
	it('retracts what was not sent from the fork block on, records it, and follows the new branch', async () => {
		await etherfold.ingest(100, 105, [
			posted({block: 101, hash: '0xa101', author: ALICE, count: 1n}),
			posted({block: 103, hash: '0xa103', author: BOB, count: 1n}),
			posted({block: 104, hash: '0xa104', author: CAROL, count: 1n}),
			posted({block: 105, hash: '0xa105', author: ALICE, count: 2n}),
		]);
		const db = memoryDB();
		// a gate ABOVE the reorg: the safe lane misconfigured, which is exactly when a rewind arrives
		const consumer = consumerOn(db, {value: 200});
		await consumer.setup();
		await consumer.catchUp();
		expect(await listDeliveries(db)).toHaveLength(4);

		// block 103 comes back with another hash: 103, 104 and 105 are reorged out
		await etherfold.ingest(102, 106, [
			posted({block: 103, hash: '0xb103', author: CAROL, count: 1n}),
			posted({block: 106, hash: '0xb106', author: BOB, count: 1n}),
		]);
		const rewound = await consumer.step();
		expect(rewound).toMatchObject({kind: 'rewound', forkBlock: 103, retracted: 3});

		const retracted = await listDeliveries(db, {status: 'retracted'});
		expect(retracted.map((d) => d.blockHash)).toEqual(['0xa103', '0xa104', '0xa105']);
		expect(await readJournal(db)).toContainEqual(
			expect.objectContaining({kind: 'rewind', detail: expect.objectContaining({forkBlock: 103, retracted: 3})}),
		);

		await consumer.catchUp();
		expect((await listDeliveries(db, {status: 'pending'})).map((d) => d.blockHash)).toEqual([
			'0xa101',
			'0xb103',
			'0xb106',
		]);
	});
});

// ---------------------------------------------------------------------------
// What the feed says that the loop must not act through: a scripted feed, the
// second adapter of the CanonicalFeed seam, because an in-process server cannot
// be made to change its fold or its stream under one consumer cheaply.
// ---------------------------------------------------------------------------

function scripted(pages: CanonicalPage[]): CanonicalFeed {
	return {
		async read() {
			const page = pages.shift();
			if (!page) throw new Error('the script ran out');
			return page;
		},
	};
}

const entry = {
	blockNumber: 101,
	blockHash: '0xa101',
	logIndex: 0,
	transactionHash: '0x01',
	transactionIndex: 0,
	address: '0x00',
	topics: ['0x00'],
	data: '0x',
};

describe('the consumer pauses for an operator', () => {
	let db: ReturnType<typeof memoryDB>;
	it('when the generation answering the feed changes, and resumes on the new one only when told to', async () => {
		db = memoryDB();
		const feed = scripted([
			{kind: 'page', stream: 's', generation: 'g1', entries: [entry], cursor: 'c1', hasMore: false},
			{
				kind: 'page',
				stream: 's',
				generation: 'g2',
				entries: [{...entry, blockNumber: 102, blockHash: '0xa102'}],
				cursor: 'c2',
				hasMore: false,
			},
			{
				kind: 'page',
				stream: 's',
				generation: 'g2',
				entries: [{...entry, blockNumber: 102, blockHash: '0xa102'}],
				cursor: 'c2',
				hasMore: false,
			},
		]);
		const consumer = createConsumer({db, name: 'x', chainId: '1', feed, gate: async () => 200, match: everyLog});
		await consumer.setup();
		await consumer.step();

		const paused = await consumer.step();
		expect(paused).toMatchObject({kind: 'paused', reason: {kind: 'generation-changed', from: 'g1', to: 'g2'}});
		// nothing from the new fold was acted on, and the next step stays paused without reading
		expect(await listDeliveries(db)).toHaveLength(1);
		expect(await consumer.step()).toMatchObject({kind: 'paused'});

		await consumer.resume();
		await consumer.step();
		expect((await listDeliveries(db)).map((d) => d.blockNumber)).toEqual([101, 102]);
		expect((await readJournal(db)).map((j) => j.kind)).toEqual(['paused', 'resumed']);
	});

	it('when the stream it followed is no longer the one served', async () => {
		db = memoryDB();
		const feed = scripted([{kind: 'refused', status: 400, error: 'stream-mismatch', body: {startCursor: 'start'}}]);
		const consumer = createConsumer({db, name: 'x', chainId: '1', feed, gate: async () => 200, match: everyLog});
		await consumer.setup();
		expect(await consumer.step()).toMatchObject({kind: 'paused', reason: {kind: 'refused', error: 'stream-mismatch'}});
		expect((await consumer.status()).paused).toMatchObject({kind: 'refused', error: 'stream-mismatch'});
	});
});
