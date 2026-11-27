import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
	CallTimeoutError,
	DEFAULT_CALL_TIMEOUT_MS,
	canonicalFeed,
	createConsumer,
	createDeliverer,
	createTriggerService,
	defineTriggers,
	listDeliveries,
	readJournal,
	rewardAction,
	rpcGate,
	setupDatabase,
	stateReader,
	type ActionAdapter,
	type CanonicalFeed,
	type GlobalRule,
} from '../src/index.js';
import {insertDeliveryStatement} from '../src/outbox.js';
import {memoryDB} from './utils/db.js';
import {
	ALICE,
	BASE_URL,
	BOARD,
	CHAIN_ID,
	INDEXER,
	blockHash,
	boardAbi,
	posted,
	startEtherfold,
	type Etherfold,
} from './utils/etherfold.js';

// ---------------------------------------------------------------------------
// EVERY OUTBOUND CALL TIMES OUT (etherfold ADR-0101): the gate, a feed read, a
// predicate (with the state reads it makes) and a delivery each get an
// `AbortSignal` that fires after the per-call timeout, and the core gives up
// at the timeout whether or not the callee honours it, so one hung endpoint
// holds one round for at most that long. The tests use a short timeout.
// ---------------------------------------------------------------------------

const TIMEOUT = 40;

/**
 * A `fetch` that accepts the request and never answers: its promise settles
 * only when its signal aborts, so it records that the abort reached it.
 */
function hangingFetch() {
	const seen = {calls: 0, aborted: 0};
	const doFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
		seen.calls++;
		return new Promise<Response>((_, reject) => {
			const signal = init?.signal;
			signal?.addEventListener(
				'abort',
				() => {
					seen.aborted++;
					reject(signal.reason);
				},
				{once: true},
			);
		});
	}) as typeof fetch;
	return {fetch: doFetch, seen};
}

/** A promise that never settles: a callee that ignores its signal. */
const never = <T>() => new Promise<T>(() => {});

const rule = (predicate?: GlobalRule['predicate']): GlobalRule => ({
	event: 'posted',
	recipients: (log) => log.args['author'] as string,
	...(predicate ? {predicate} : {}),
	action: 'reward',
	render: () => ({}),
});

const delivered: ActionAdapter = {
	lanes: ['safe'],
	policy: {maxAttempts: 3, backoff: {initialMs: 1000, maxMs: 1000}},
	deliver: async () => ({kind: 'delivered'}),
};

let etherfold: Etherfold;
beforeEach(async () => {
	etherfold = await startEtherfold();
	await etherfold.ingest(100, 110, [posted({block: 101, hash: blockHash(101), author: ALICE, count: 1n})]);
});

function service(options: {
	db?: ReturnType<typeof memoryDB>;
	feed?: CanonicalFeed;
	gate?: (context: {signal: AbortSignal}) => Promise<number>;
	predicate?: GlobalRule['predicate'];
	reward?: ActionAdapter;
}) {
	return createTriggerService({
		db: options.db ?? memoryDB(),
		app: INDEXER,
		chainId: CHAIN_ID,
		feed: options.feed ?? canonicalFeed({url: BASE_URL, indexer: INDEXER, fetch: etherfold.fetch}),
		gate: options.gate ?? (async () => 1000),
		definitions: defineTriggers({
			events: {posted: {address: BOARD, abi: boardAbi[0]}},
			rules: {'every-post': rule(options.predicate)},
		}),
		actions: {reward: options.reward ?? delivered},
		callTimeoutMs: TIMEOUT,
	});
}

describe('a feed or a gate that never answers', () => {
	it('a feed that accepts the connection and never answers fails the round at the timeout, as a stall, and is read again next round', async () => {
		const db = memoryDB();
		const hanging = hangingFetch();
		let up = false;
		const triggers = service({
			db,
			feed: canonicalFeed({
				url: BASE_URL,
				indexer: INDEXER,
				fetch: (input, init) => (up ? etherfold.fetch(input, init) : hanging.fetch(input, init)),
			}),
		});
		await triggers.setup();

		const error = await triggers.tick().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CallTimeoutError);
		expect((error as CallTimeoutError).code).toBe('feed-timeout');
		// the built-in feed handed its signal to fetch
		expect(hanging.seen).toEqual({calls: 1, aborted: 1});
		expect(await listDeliveries(db, INDEXER)).toEqual([]);
		const stalled = await readJournal(db, INDEXER, {kind: 'stalled'});
		expect(stalled.map((e) => e.detail['code'])).toEqual(['feed-timeout']);
		expect(stalled[0]?.detail['error']).toMatch(/did not answer within 40 ms/);

		await expect(triggers.tick()).rejects.toBeInstanceOf(CallTimeoutError);
		expect(hanging.seen.calls).toBe(2);
		// the same failure is journalled once
		expect(await readJournal(db, INDEXER, {kind: 'stalled'})).toHaveLength(1);

		up = true;
		expect((await triggers.tick()).consumed).toBe(1);
		expect(await readJournal(db, INDEXER, {kind: 'recovered'})).toHaveLength(1);
	});

	it('a gate that never answers does the same', async () => {
		const db = memoryDB();
		const hanging = hangingFetch();
		let up = false;
		const gate = rpcGate({url: 'https://rpc.test', fetch: hanging.fetch});
		const triggers = service({db, gate: async (context) => (up ? 1000 : gate(context))});
		await triggers.setup();

		const error = await triggers.tick().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CallTimeoutError);
		expect((error as CallTimeoutError).code).toBe('gate-timeout');
		expect(hanging.seen).toEqual({calls: 1, aborted: 1});
		expect((await readJournal(db, INDEXER, {kind: 'stalled'})).map((e) => e.detail['code'])).toEqual(['gate-timeout']);
		expect((await triggers.consumer.status()).cursor).toBeUndefined();

		up = true;
		expect((await triggers.tick()).consumed).toBe(1);
		expect(await readJournal(db, INDEXER, {kind: 'recovered'})).toHaveLength(1);
	});
});

describe('a predicate whose state read never answers', () => {
	it('fails its page (not committed, read again next round), journalled as a stall; the read saw the abort', async () => {
		const db = memoryDB();
		const hanging = hangingFetch();
		let up = false;
		const reads = stateReader({
			url: BASE_URL,
			fetch: (input, init) => (up ? etherfold.fetch(input, init) : hanging.fetch(input, init)),
		});
		const POSTS = `query Posts($block: BlockAddress!, $address: String!) {
			author(where: {address: {eq: $address}}, first: 1, block: $block) { posts }
		}`;
		const triggers = service({
			db,
			predicate: async (log, recipient, {signal}) => {
				const data = await reads.query<{author: {posts: number}[]}>(POSTS, log, {address: recipient}, {signal});
				return (data.author[0]?.posts ?? 0) >= 1;
			},
		});
		await triggers.setup();

		const error = await triggers.tick().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CallTimeoutError);
		expect((error as CallTimeoutError).code).toBe('predicate-timeout');
		expect(hanging.seen).toEqual({calls: 1, aborted: 1});
		expect(await listDeliveries(db, INDEXER)).toEqual([]);
		expect((await triggers.consumer.status()).cursor).toBeUndefined();
		expect((await readJournal(db, INDEXER, {kind: 'stalled'})).map((e) => e.detail['code'])).toEqual([
			'predicate-timeout',
		]);

		up = true;
		const report = await triggers.tick();
		expect(report).toMatchObject({consumed: 1, matched: 1});
		expect(await readJournal(db, INDEXER, {kind: 'recovered'})).toHaveLength(1);
	});
});

describe('callees that ignore the signal', () => {
	async function released(run: () => Promise<unknown>): Promise<{error: unknown; elapsed: number}> {
		const started = Date.now();
		const error = await run().catch((e: unknown) => e);
		return {error, elapsed: Date.now() - started};
	}

	it('a gate, a feed and a predicate that never resolve still release the round at the timeout', async () => {
		const cases = [
			{code: 'gate-timeout', triggers: service({gate: () => never()})},
			{code: 'feed-timeout', triggers: service({feed: {read: () => never()}})},
			{code: 'predicate-timeout', triggers: service({predicate: () => never()})},
		];
		for (const {code, triggers} of cases) {
			await triggers.setup();
			const {error, elapsed} = await released(() => triggers.tick());
			expect(error).toBeInstanceOf(CallTimeoutError);
			expect((error as CallTimeoutError).code).toBe(code);
			expect(elapsed).toBeLessThan(2000);
		}
	});

	it('an adapter that never resolves releases the round at the timeout, the delivery counted as a retry', async () => {
		const db = memoryDB();
		const triggers = service({
			db,
			reward: {
				lanes: ['safe'],
				policy: {maxAttempts: 3, backoff: {initialMs: 1000, maxMs: 1000}},
				deliver: () => never(),
			},
		});
		await triggers.setup();
		const started = Date.now();
		const report = await triggers.tick();
		expect(Date.now() - started).toBeLessThan(2000);
		expect(report.delivery).toMatchObject({attempted: 1, retried: 1});
		const [pending] = await listDeliveries(db, INDEXER);
		expect(pending).toMatchObject({status: 'pending', attempts: 1});
		expect(pending?.lastError).toMatch(/did not answer within 40 ms/);
	});
});

describe('a delivery whose target never answers', () => {
	it('is retried after the timeout and, past the retry budget, dead-lettered', async () => {
		const db = memoryDB();
		await setupDatabase(db);
		let now = 1_000_000;
		await db.batch([
			insertDeliveryStatement(
				db,
				INDEXER,
				now,
				{blockNumber: 101, blockHash: '0xa101', logIndex: 0, transactionHash: '0x01'},
				{action: 'reward', key: 'k', recipient: '0xr', payload: {}, trigger: 't'},
			),
		]);
		const hanging = hangingFetch();
		const deliverer = createDeliverer({
			db,
			app: INDEXER,
			actions: {
				reward: rewardAction({
					url: 'https://rewards.test/award',
					token: 't',
					fetch: hanging.fetch,
					policy: {maxAttempts: 2, backoff: {initialMs: 1000, maxMs: 1000}},
				}),
			},
			clock: () => now,
			callTimeoutMs: TIMEOUT,
		});

		expect(await deliverer.deliverDue()).toMatchObject({attempted: 1, retried: 1});
		expect(hanging.seen).toEqual({calls: 1, aborted: 1});
		expect((await listDeliveries(db, INDEXER))[0]).toMatchObject({
			status: 'pending',
			attempts: 1,
			nextAttemptAt: now + 1000,
		});

		now += 1000;
		expect(await deliverer.deliverDue()).toMatchObject({attempted: 1, dead: 1});
		const [dead] = await listDeliveries(db, INDEXER, {status: 'dead'});
		expect(dead).toMatchObject({attempts: 2});
		expect(dead?.lastError).toMatch(/did not answer within 40 ms/);
		expect(await readJournal(db, INDEXER, {kind: 'dead-lettered'})).toHaveLength(1);
	});
});

describe('the default timeout', () => {
	afterEach(() => vi.useRealTimers());

	it('is 10 s', async () => {
		expect(DEFAULT_CALL_TIMEOUT_MS).toBe(10_000);
		const db = memoryDB();
		const consumer = createConsumer({
			db,
			app: INDEXER,
			chainId: CHAIN_ID,
			feed: {read: () => never()},
			gate: async () => 1000,
			match: async () => [],
		});
		await consumer.setup();
		vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
		let settled: unknown;
		consumer.step().catch((error: unknown) => (settled = error));
		await vi.advanceTimersByTimeAsync(9_999);
		expect(settled).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toBeInstanceOf(CallTimeoutError);
		expect((settled as CallTimeoutError).code).toBe('feed-timeout');
	});
});
