import {beforeEach, describe, expect, it} from 'vitest';
import {
	StateReadError,
	canonicalFeed,
	createConsumer,
	createTriggerService,
	createTriggerRegistry,
	defineTriggers,
	listDeliveries,
	readJournal,
	stateReader,
	type DecodedLog,
	type StateReader,
} from '../src/index.js';
import {memoryDB} from './utils/db.js';
import {
	ALICE,
	BASE_URL,
	BOARD,
	BOB,
	CHAIN_ID,
	INDEXER,
	blockHash,
	boardAbi,
	posted,
	startEtherfold,
	type Etherfold,
} from './utils/etherfold.js';

// ---------------------------------------------------------------------------
// THE STATE READ (step S2b): a predicate asks the indexer's state AS OF the
// log's block, by its HASH (etherfold ADR-0011's "state as of its block"),
// through the same `/graphql` an app reads. A log's event often carries less
// than the rule needs (GreetingsRegistry's `MessageChanged` has no count), and
// the state at the log's block is what the fold made of everything up to it.
// A read that cannot answer is an error, never a `false`: the page is then not
// committed, and the consumer tries it again.
// ---------------------------------------------------------------------------

const POSTS = `query Posts($block: BlockAddress!, $address: String!) {
	author(where: {address: {eq: $address}}, first: 1, block: $block) { posts }
}`;

async function postsOf(state: StateReader, at: {blockHash: string} | DecodedLog, address: string) {
	const data = await state.query<{author: {posts: number}[]}>(POSTS, at, {address: address.toLowerCase()});
	return data.author[0]?.posts ?? 0;
}

let etherfold: Etherfold;
let state: StateReader;

beforeEach(async () => {
	etherfold = await startEtherfold();
	state = stateReader({url: BASE_URL, fetch: etherfold.fetch});
	await etherfold.ingest(100, 110, [
		posted({block: 101, hash: blockHash(101), author: ALICE, count: 1n}),
		posted({block: 102, hash: blockHash(102), author: ALICE, count: 2n}),
		posted({block: 103, hash: blockHash(103), author: BOB, count: 1n}),
		posted({block: 104, hash: blockHash(104), author: ALICE, count: 3n}),
	]);
});

describe('stateReader', () => {
	it('answers the state as of a block, by its hash: what the fold made of every log up to it', async () => {
		expect(await postsOf(state, {blockHash: blockHash(101)}, ALICE)).toBe(1);
		expect(await postsOf(state, {blockHash: blockHash(102)}, ALICE)).toBe(2);
		expect(await postsOf(state, {blockHash: blockHash(103)}, ALICE)).toBe(2);
		expect(await postsOf(state, {blockHash: blockHash(103)}, BOB)).toBe(1);
		expect(await postsOf(state, {blockHash: blockHash(104)}, ALICE)).toBe(3);
	});

	it('refuses a block the indexer has no record of, with its code, rather than answering', async () => {
		const error = await postsOf(state, {blockHash: blockHash(101, 'b')}, ALICE).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(StateReadError);
		expect((error as StateReadError).code).toBe('block-not-recorded');
	});

	it('refuses when the indexer does not answer GraphQL, naming the status', async () => {
		const down = stateReader({
			url: BASE_URL,
			fetch: async () => new Response('{"error":"no-canonical-generation"}', {status: 503}),
		});
		const error = await postsOf(down, {blockHash: blockHash(101)}, ALICE).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(StateReadError);
		expect((error as StateReadError).code).toBe('http-503');
		const unreachable = stateReader({url: BASE_URL, fetch: () => Promise.reject(new TypeError('fetch failed'))});
		expect(await postsOf(unreachable, {blockHash: blockHash(101)}, ALICE).catch((e: unknown) => e)).toBeInstanceOf(
			StateReadError,
		);
	});
});

describe('a predicate reading the state', () => {
	it("fires a rule from the state as of the log's block, and commits nothing while the read fails", async () => {
		let failing = true;
		const reads = stateReader({
			url: BASE_URL,
			fetch: async (input, init) =>
				failing ? new Response('unavailable', {status: 503}) : etherfold.fetch(input, init),
		});
		const definitions = defineTriggers({
			events: {posted: {address: BOARD, abi: boardAbi[0]}},
			rules: {
				// the event's own count is not read: the state's is
				'third-post': {
					event: 'posted',
					recipients: (log) => log.args['author'] as string,
					predicate: async (log, recipient) => (await postsOf(reads, log, recipient)) >= 3,
					action: 'reward',
					key: (_log, recipient) => `third-post:${recipient}`,
					render: () => ({}),
				},
			},
		});
		const db = memoryDB();
		const registry = createTriggerRegistry({db, definitions});
		const consumer = createConsumer({
			db,
			name: INDEXER,
			chainId: CHAIN_ID,
			feed: canonicalFeed({url: BASE_URL, indexer: INDEXER, fetch: etherfold.fetch}),
			gate: async () => 1000,
			match: registry.matcher(),
		});
		await consumer.setup();

		await expect(consumer.step()).rejects.toBeInstanceOf(StateReadError);
		expect(await listDeliveries(db)).toEqual([]);
		expect((await consumer.status()).cursor).toBeUndefined();

		failing = false;
		await consumer.catchUp();
		const deliveries = await listDeliveries(db);
		expect(deliveries.map((d) => [d.key, d.blockNumber])).toEqual([[`third-post:${ALICE.toLowerCase()}`, 104]]);
	});
});

describe('a consumer held at a page by a read that keeps failing', () => {
	it('journals that it is stalled, once per distinct failure, so the halt is visible after the fact', async () => {
		let answer: 'down' | 'broken' | 'up' = 'down';
		const reads = stateReader({
			url: BASE_URL,
			fetch: async (input, init) =>
				answer === 'down'
					? new Response('unavailable', {status: 503})
					: answer === 'broken'
						? new Response('{"errors":[{"message":"no","extensions":{"code":"invalid-query"}}]}', {status: 200})
						: etherfold.fetch(input, init),
		});
		const db = memoryDB();
		const service = createTriggerService({
			db,
			name: INDEXER,
			chainId: CHAIN_ID,
			feed: canonicalFeed({url: BASE_URL, indexer: INDEXER, fetch: etherfold.fetch}),
			gate: async () => 1000,
			definitions: defineTriggers({
				events: {posted: {address: BOARD, abi: boardAbi[0]}},
				rules: {
					'third-post': {
						event: 'posted',
						recipients: (log) => log.args['author'] as string,
						predicate: async (log, recipient) => (await postsOf(reads, log, recipient)) >= 3,
						action: 'reward',
						render: () => ({}),
					},
				},
			}),
			actions: {
				reward: {
					lanes: ['safe'],
					policy: {maxAttempts: 1, backoff: {initialMs: 1, maxMs: 1}},
					deliver: async () => ({kind: 'delivered'}),
				},
			},
		});
		await service.setup();

		await expect(service.tick()).rejects.toBeInstanceOf(StateReadError);
		await expect(service.tick()).rejects.toBeInstanceOf(StateReadError);
		answer = 'broken';
		await expect(service.tick()).rejects.toBeInstanceOf(StateReadError);
		const stalled = await readJournal(db, {kind: 'stalled'});
		expect(stalled.map((e) => e.detail['code'])).toEqual(['http-503', 'invalid-query']);
		expect(stalled[0]?.detail).toMatchObject({consumer: INDEXER, error: expect.stringMatching(/503/)});

		answer = 'up';
		expect((await service.tick()).consumed).toBe(4);
		expect(await readJournal(db, {kind: 'recovered'})).toHaveLength(1);
	});
});
