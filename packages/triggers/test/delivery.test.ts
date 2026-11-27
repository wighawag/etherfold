import {beforeEach, describe, expect, it} from 'vitest';
import {
	assertActionsFitLane,
	createDeliverer,
	defineTriggers,
	listDeliveries,
	readJournal,
	setupDatabase,
	type ActionAdapter,
	type DeliveryOutcome,
} from '../src/index.js';
import {insertDeliveryStatement} from '../src/outbox.js';
import {memoryDB} from './utils/db.js';
import {BOARD, boardAbi} from './utils/etherfold.js';

// ---------------------------------------------------------------------------
// THE DELIVERY POLICY (etherfold ADR-0009): per action type, a TTL and a retry
// budget, then a dead letter. Every delivery ends in a RECORDED terminal state:
// delivered, expired or dead, each inspectable afterwards.
// ---------------------------------------------------------------------------

let db: ReturnType<typeof memoryDB>;
let now: number;
const position = {blockNumber: 101, blockHash: '0xa101', logIndex: 0, transactionHash: '0x01'};

async function enqueue(action: string, key: string, expiresAt?: number) {
	await db.batch([
		insertDeliveryStatement(db, 'board', now, position, {
			action,
			key,
			recipient: '0xr',
			payload: {key},
			trigger: 't',
			...(expiresAt === undefined ? {} : {expiresAt}),
		}),
	]);
}

/** An adapter answering from a script, one outcome per attempt. */
function scripted(
	outcomes: (DeliveryOutcome | Error)[],
	policy: ActionAdapter['policy'],
): ActionAdapter & {calls: number} {
	const adapter = {
		calls: 0,
		policy,
		async deliver() {
			const next = outcomes[adapter.calls++] ?? {kind: 'delivered'};
			if (next instanceof Error) throw next;
			return next;
		},
	};
	return adapter;
}

beforeEach(async () => {
	db = memoryDB();
	now = 1_000_000;
	await setupDatabase(db);
});

describe('delivering the outbox', () => {
	it('settles a delivered row, attempting it once', async () => {
		const adapter = scripted([{kind: 'delivered'}], {maxAttempts: 3, backoff: {initialMs: 1000, maxMs: 10_000}});
		const deliverer = createDeliverer({db, app: 'board', actions: {push: adapter}, clock: () => now});
		await enqueue('push', 'k');
		expect(await deliverer.deliverDue()).toMatchObject({delivered: 1});
		expect(await deliverer.deliverDue()).toMatchObject({delivered: 0});
		expect(adapter.calls).toBe(1);
		expect((await listDeliveries(db, 'board'))[0]).toMatchObject({status: 'delivered', attempts: 1, settledAt: now});
	});

	it('retries with backoff, and dead-letters past its budget, recorded and inspectable', async () => {
		const adapter = scripted(
			[{kind: 'retry', error: 'a 503'}, new TypeError('fetch failed'), {kind: 'retry', error: 'a 503 again'}],
			{maxAttempts: 3, backoff: {initialMs: 1000, maxMs: 10_000}},
		);
		const deliverer = createDeliverer({db, app: 'board', actions: {reward: adapter}, clock: () => now});
		await enqueue('reward', 'k');

		expect(await deliverer.deliverDue()).toMatchObject({retried: 1});
		expect((await listDeliveries(db, 'board'))[0]).toMatchObject({
			status: 'pending',
			attempts: 1,
			nextAttemptAt: now + 1000,
		});
		// not due yet: nothing is attempted
		now += 999;
		expect(await deliverer.deliverDue()).toMatchObject({retried: 0});
		now += 1;
		expect(await deliverer.deliverDue()).toMatchObject({retried: 1});
		expect((await listDeliveries(db, 'board'))[0]).toMatchObject({
			attempts: 2,
			nextAttemptAt: now + 2000,
			lastError: 'fetch failed',
		});
		now += 2000;
		expect(await deliverer.deliverDue()).toMatchObject({dead: 1});

		const [dead] = await listDeliveries(db, 'board', {status: 'dead'});
		expect(dead).toMatchObject({attempts: 3, lastError: 'a 503 again', settledAt: now});
		expect(await readJournal(db, 'board', {kind: 'dead-lettered'})).toHaveLength(1);
		expect(adapter.calls).toBe(3);
	});

	it('dead-letters at once what the target refuses for good, and an action nobody configured', async () => {
		const adapter = scripted([{kind: 'dead', error: 'a 401'}], {maxAttempts: 5, backoff: {initialMs: 1, maxMs: 1}});
		const deliverer = createDeliverer({db, app: 'board', actions: {push: adapter}, clock: () => now});
		await enqueue('push', 'refused');
		await enqueue('mint', 'unknown');
		expect(await deliverer.deliverDue()).toMatchObject({dead: 2});
		expect((await listDeliveries(db, 'board', {status: 'dead'})).map((d) => d.lastError)).toEqual([
			'a 401',
			'no adapter is configured for the action "mint"',
		]);
	});

	it('expires a row past its TTL without sending it', async () => {
		const adapter = scripted(
			[
				{kind: 'retry', error: 'down'},
				{kind: 'retry', error: 'still down'},
			],
			{
				ttlMs: 60_000,
				maxAttempts: 10,
				backoff: {initialMs: 30_000, maxMs: 30_000},
			},
		);
		const deliverer = createDeliverer({db, app: 'board', actions: {push: adapter}, clock: () => now});
		await enqueue('push', 'stale');
		await deliverer.deliverDue();
		now += 30_000;
		await deliverer.deliverDue();
		expect(adapter.calls).toBe(2);
		now += 30_000;
		expect(await deliverer.deliverDue()).toMatchObject({expired: 1});
		expect(adapter.calls).toBe(2);
		expect((await listDeliveries(db, 'board'))[0]).toMatchObject({status: 'expired', settledAt: now});
		expect(await readJournal(db, 'board', {kind: 'expired'})).toHaveLength(1);
	});

	it('honours an expiry the match set on the row itself', async () => {
		const adapter = scripted([], {maxAttempts: 1, backoff: {initialMs: 1, maxMs: 1}});
		const deliverer = createDeliverer({db, app: 'board', actions: {push: adapter}, clock: () => now});
		await enqueue('push', 'k', now - 1);
		expect(await deliverer.deliverDue()).toMatchObject({expired: 1});
		expect(adapter.calls).toBe(0);
	});

	it('puts a dead letter back in the queue when an operator asks', async () => {
		const adapter = scripted([{kind: 'dead', error: 'misconfigured'}, {kind: 'delivered'}], {
			maxAttempts: 1,
			backoff: {initialMs: 1, maxMs: 1},
		});
		const deliverer = createDeliverer({db, app: 'board', actions: {push: adapter}, clock: () => now});
		await enqueue('push', 'k');
		await deliverer.deliverDue();
		const [dead] = await listDeliveries(db, 'board', {status: 'dead'});
		expect(await deliverer.requeue(dead!.id)).toBe(true);
		expect(await deliverer.requeue(dead!.id)).toBe(false);
		await deliverer.deliverDue();
		expect((await listDeliveries(db, 'board'))[0]).toMatchObject({status: 'delivered', attempts: 1});
		expect((await readJournal(db, 'board')).map((j) => j.kind)).toEqual(['dead-lettered', 'requeued']);
	});
});

describe('an action and its lanes', () => {
	const definitions = defineTriggers({
		events: {posted: {address: BOARD, abi: boardAbi[0]}},
		rules: {r: {event: 'posted', recipients: () => undefined, action: 'reward', render: () => ({})}},
	});
	const reward = {
		lanes: ['safe'],
		policy: {maxAttempts: 1, backoff: {initialMs: 1, maxMs: 1}},
		deliver: async () => ({kind: 'delivered'}),
	} as const satisfies ActionAdapter;

	it('refuses a trigger whose action may not fire from the consumer lane, and one with no adapter', () => {
		expect(() => assertActionsFitLane(definitions, {reward}, 'safe')).not.toThrow();
		expect(() => assertActionsFitLane(definitions, {reward}, 'fast')).toThrow(/reward.*safe/);
		expect(() => assertActionsFitLane(definitions, {}, 'safe')).toThrow(/no adapter.*reward/);
	});
});
