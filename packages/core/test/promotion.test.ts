import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {openIndexer, type AnyGenerationSpec, type Indexer} from '../src/container.js';
import {openMemoryGenerationRegistry} from '../src/generation/memory.js';
import {GenerationCapReachedError, type GenerationId} from '../src/generation/registry.js';
import {DEFAULT_PROMOTION_POLICY, resolvePromotionConfig, type PromotionPolicy} from '../src/generation/promotion.js';
import {IndexerGeneration} from '../src/indexer.js';
import {resolveStreamConfig} from '../src/internal/engine/utils.js';
import {streamDigestOf} from '../src/stream/identity.js';
import {checkTxInclusion} from '../src/utils/txInclusion.js';
import type {
	EventProcessor,
	ExistingStream,
	IndexingSource,
	LastSync,
	LogEvent,
	StoredLastSync,
	StoredLogEvent,
} from '../src/types.js';
import {
	ADDRESS,
	BRANCH_A,
	BRANCH_A_TIP,
	FINALITY,
	idOf,
	makeLog,
	SOURCE,
	START_BLOCK,
} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------
// THE PROMOTION POLICY: WHEN the canonical pointer moves, and what happens to
// the generation left behind.
// ---------------------------------------------------------------------------
// The registry owns the pointer as a MECHANISM (move it, read it, move it
// back). This is the policy over it, and it has three values with ONE default
// EVERYWHERE:
//
//   on-catch-up (DEFAULT) -- the pointer moves when the successor reaches the
//                            cursor the canonical generation had (stories 1, 3, 14).
//   immediate   (OPT-IN)  -- canonical the moment it is created (story 13).
//   manual                -- it moves only when asked.
//
// There is deliberately no per-runtime and no per-environment default: the axis
// that would select one is DEVELOPMENT versus PRODUCTION, and nothing in a
// browser build can detect which it is in. So the safe value is the default and
// the dangerous one is a deliberate opt-in.
//
// Reads are asserted on the ANSWERS, never on identity: a read does not report
// which generation served it, so the two folds here MARK what they produce.
// ---------------------------------------------------------------------------

const ADDRESS_B = '0x0000000000000000000000000000000000000002';

/** A DIFFERENT FILTER, so a DIFFERENT stream: this successor must fetch its own history. */
const SOURCE_B: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: ADDRESS_B, startBlock: START_BLOCK}],
};

/** What the node serves under the other filter, so a mix-up is visible in a read. */
const BRANCH_C = [makeLog(101, '0xc101'), makeLog(103, '0xc103')];

/**
 * A fold that MARKS what it produces.
 *
 * Two generations over ONE stream compute the same events, so a read could not
 * otherwise say which one answered -- and "which one answered" is exactly what
 * every assertion here is about. The mark is the generation's name.
 */
function markedFold(name: string) {
	let state: string[] = [];
	const processor = {
		getVersionHash: () => `proc-${name}`,
		getCodeFingerprint: () => undefined,
		load: async () => undefined,
		process: async (events: LogEvent<Abi>[]) => {
			for (const event of events) {
				if (event.removed) {
					const at = state.lastIndexOf(`${name}:${idOf(event)}`);
					if (at >= 0) {
						state.splice(at, 1);
					}
				} else {
					state.push(`${name}:${idOf(event)}`);
				}
			}
			return state;
		},
		reset: async () => {
			state = [];
		},
		clear: async () => {
			state = [];
		},
	} as unknown as EventProcessor<Abi, string[]>;
	return {
		processor,
		get state() {
			return state;
		},
	};
}

/** What generation `name` would have folded, had it folded these logs. */
const foldedBy = (name: string, logs: StoredLogEvent[]) => logs.map((log) => `${name}:${idOf(log)}`);

/** A keeper that ADDRESSES by stream digest, so two filters land in two keyspaces. */
function keyedStream() {
	type Stored = {lastSync: StoredLastSync; eventStream: StoredLogEvent[]};
	const stored = new Map<string, Stored>();
	let streamConfig = resolveStreamConfig(undefined);
	const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
	const digestOf = (source: IndexingSource<Abi>) => streamDigestOf(source, streamConfig);

	const keeper: ExistingStream<Abi> = {
		setStreamConfig: (config) => {
			streamConfig = config;
		},
		fetchFrom: async (source, fromBlock) => {
			const held = stored.get(digestOf(source));
			return held
				? {
						status: 'stream' as const,
						eventStream: held.eventStream.filter((event) => event.blockNumber >= fromBlock),
						lastSync: clone(held.lastSync),
					}
				: {status: 'absent' as const};
		},
		saveNewEvents: async (source, {eventStream, lastSync}) => {
			const digest = digestOf(source);
			const held = stored.get(digest);
			stored.set(digest, {
				lastSync: clone(lastSync),
				eventStream: [...(held?.eventStream ?? []), ...eventStream.map((event) => ({...event}))],
			});
		},
		clear: async (source) => {
			stored.delete(digestOf(source));
		},
	};
	return {keeper};
}

type GenerationWanted = {
	name: string;
	/** A filter of its own, which makes it a generation on a DIFFERENT stream. */
	source?: IndexingSource<Abi>;
	/**
	 * How many of this generation's fetches are THROTTLED to a single block.
	 *
	 * The trigger is "the successor reached the cursor the canonical generation
	 * had", and a successor that catches up inside one cycle cannot show the
	 * "and NOT before" half of it. A node that serves less than it was asked for
	 * is ordinary (`toBlockUsed`, the announced result cap), so this is how a
	 * successor is made to be genuinely BEHIND for a few rounds.
	 */
	slowFetches?: number;
};

/**
 * The world: one node, one keeper, N generations, and the policy under test.
 *
 * `dropped` records what the registry was asked to drop the state of, which is
 * what drop-on-promotion is asserted against -- the container removing a
 * generation from its own list would look identical otherwise.
 */
async function openWorld(options?: {
	promotion?: {policy?: PromotionPolicy; dropOnPromotion?: boolean};
	generations?: GenerationWanted[];
	caps?: {maxGenerations: number; maxStreams: number};
}) {
	const chain = {logs: {[ADDRESS]: [...BRANCH_A], [ADDRESS_B]: [...BRANCH_C]} as Record<string, StoredLogEvent[]>};
	let tip = BRANCH_A_TIP;
	const stream = keyedStream();
	const folds = new Map<string, ReturnType<typeof markedFold>>();
	const dropped: GenerationId[] = [];

	const provider = {
		async request(args: {method: string}): Promise<unknown> {
			switch (args.method) {
				case 'eth_chainId':
					return '0x1';
				case 'eth_blockNumber':
					return `0x${tip.toString(16)}`;
			}
			throw new Error(`unexpected method ${args.method}`);
		},
	} as never;

	const throttles = new Map<string, number>();
	const specFor = (wanted: GenerationWanted): AnyGenerationSpec<Abi, string[]> => {
		throttles.set(`proc-${wanted.name}`, wanted.slowFetches ?? 0);
		return {
			...(wanted.source ? {source: wanted.source} : {}),
			createState: () => ({name: wanted.name}),
			createProcessor: () => {
				const fold = markedFold(wanted.name);
				folds.set(wanted.name, fold);
				return fold.processor;
			},
			stateOf: () => folds.get(wanted.name)?.state ?? [],
		};
	};

	const registry = await openMemoryGenerationRegistry(options?.caps ?? {maxGenerations: 4, maxStreams: 2}, {
		dropState: async (id) => {
			dropped.push(id);
		},
	});

	const indexer = await openIndexer<Abi, string[]>({
		registry,
		provider,
		source: SOURCE,
		config: {stream: {finality: FINALITY}, keepStream: stream.keeper, streamWriteRetry: {delaySeconds: 0}},
		...(options?.promotion ? {promotion: options.promotion} : {}),
		generations: (options?.generations ?? [{name: 'A'}]).map(specFor),
		createGeneration: (generationProvider, processor, source, config) => {
			const generation = new IndexerGeneration<Abi, string[]>(generationProvider, processor, source, config);
			const by = processor.getVersionHash();
			(generation as unknown as {logEventFetcher: unknown}).logEventFetcher = {
				async getLogEvents({fromBlock, toBlock}: {fromBlock: number; toBlock: number}) {
					const remaining = throttles.get(by) ?? 0;
					const served = remaining > 0 ? fromBlock : toBlock;
					throttles.set(by, Math.max(0, remaining - 1));
					const logs = chain.logs[(source.contracts as readonly {address: string}[])[0].address] ?? [];
					return {
						events: logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= served),
						toBlockUsed: served,
					};
				},
				reparse: (events: StoredLogEvent[]) => events.map((event) => ({...event})),
			};
			return generation;
		},
	});

	return {
		indexer,
		registry,
		dropped,
		/** What the CANONICAL generation answers right now, snapshotted. */
		read: () => [...indexer.state],
		stateOf: (name: string) => [...(folds.get(name)?.state ?? [])],
		heldNames: () => indexer.generations.map((held) => held.record.processor.replace('proc-', '')),
		canonicalName: () => indexer.canonical.record.processor.replace('proc-', ''),
		/** Build a generation BESIDE the ones already held: what a reconfigure does. */
		add: (wanted: GenerationWanted) => indexer.add(specFor(wanted)),
		serve(address: string, logs: StoredLogEvent[], newTip: number) {
			chain.logs[address] = logs;
			tip = newTip;
		},
	};
}

/**
 * Drive until the CANONICAL generation is at the tip.
 *
 * Note what it does not wait for: a non-canonical generation catching up. The
 * cursor a driver watches is the one reads are answered from, so a throttled
 * successor is still behind when this returns -- which is exactly the interval
 * the trigger has to be asserted over.
 */
async function driveToTip(indexer: Indexer<Abi, string[]>, maxRounds = 30): Promise<LastSync<Abi>> {
	let rounds = 0;
	let lastSync = await indexer.indexMore();
	while (lastSync.lastToBlock < lastSync.latestBlock) {
		if (rounds++ >= maxRounds) {
			throw new Error(`did not reach the tip in ${maxRounds} rounds (lastToBlock ${lastSync.lastToBlock})`);
		}
		lastSync = await indexer.indexMore();
	}
	return lastSync;
}

/** Advance EVERY generation a fixed number of rounds, which is what a throttled successor needs. */
async function driveRounds(indexer: Indexer<Abi, string[]>, rounds = 6): Promise<LastSync<Abi>> {
	let lastSync = await indexer.indexMore();
	for (let round = 1; round < rounds; round++) {
		lastSync = await indexer.indexMore();
	}
	return lastSync;
}

describe('there are THREE policies and `on-catch-up` is the default EVERYWHERE', () => {
	it('resolves to `on-catch-up` when nothing names a policy', () => {
		expect(DEFAULT_PROMOTION_POLICY).toBe('on-catch-up');
		// no argument, an empty object, and an object naming only the OTHER knob:
		// none of them is a place a runtime could slip a default in
		expect(resolvePromotionConfig()).toEqual({policy: 'on-catch-up', dropOnPromotion: false});
		expect(resolvePromotionConfig({})).toEqual({policy: 'on-catch-up', dropOnPromotion: false});
		expect(resolvePromotionConfig({dropOnPromotion: true}).policy).toBe('on-catch-up');
	});

	it('reports the resolved policy, so a runtime cannot select one silently', async () => {
		const world = await openWorld();
		expect(world.indexer.promotion).toEqual({policy: 'on-catch-up', dropOnPromotion: false});

		const opted = await openWorld({promotion: {policy: 'immediate'}});
		expect(opted.indexer.promotion.policy).toBe('immediate');
	});

	it('refuses a policy that is not one of the three', async () => {
		await expect(openWorld({promotion: {policy: 'on-load' as PromotionPolicy}})).rejects.toThrow(TypeError);
	});
});

describe('the TRIGGER is the successor reaching the cursor the canonical generation had', () => {
	it('moves the pointer at that moment, and NOT before', async () => {
		// A is at the tip; B fetches its own history and is throttled, so it is
		// genuinely BEHIND for several rounds rather than catching up inside one
		const world = await openWorld();
		await world.indexer.load();
		await driveToTip(world.indexer);
		expect(world.read()).toEqual(foldedBy('A', BRANCH_A));

		await world.add({name: 'B', source: SOURCE_B, slowFetches: 2});
		// created, not canonical: the successor has demonstrated nothing yet
		expect(world.canonicalName()).toBe('A');

		await world.indexer.indexMore();
		expect(world.canonicalName()).toBe('A');
		// ...and the READ still answers from A, which is the whole of story 1
		expect(world.read()).toEqual(foldedBy('A', BRANCH_A));

		await driveRounds(world.indexer);
		expect(world.canonicalName()).toBe('B');
		expect(world.read()).toEqual(foldedBy('B', BRANCH_C));
	});

	it('promotes a SAME-STREAM successor once its re-fold has reached the cursor', async () => {
		const world = await openWorld();
		await world.indexer.load();
		await driveToTip(world.indexer);

		// the common reconfigure: a processor change, on the stream that is already
		// there, so the successor FOLLOWS it and fetches nothing
		const added = await world.add({name: 'B'});
		expect(added.follows).toBe(true);
		expect(world.canonicalName()).toBe('A');
		expect(world.read()).toEqual(foldedBy('A', BRANCH_A));

		await driveToTip(world.indexer);

		expect(world.canonicalName()).toBe('B');
		// the same events, folded by the new processor: reads answer the successor
		expect(world.read()).toEqual(foldedBy('B', BRANCH_A));
	});

	it('never moves the pointer BACKWARDS on its own', async () => {
		const world = await openWorld();
		await world.indexer.load();
		await driveToTip(world.indexer);
		await world.add({name: 'B'});
		await driveToTip(world.indexer);
		expect(world.canonicalName()).toBe('B');

		// story 4: the developer decides the new fold is WORSE and moves back
		await world.indexer.promote(world.indexer.generations[0].record);
		expect(world.read()).toEqual(foldedBy('A', BRANCH_A));

		// B is level with A and would satisfy the trigger arithmetic; the revert
		// must nevertheless STICK, or a revert would be undone on the next cycle
		await driveToTip(world.indexer);
		expect(world.canonicalName()).toBe('A');
		expect(world.read()).toEqual(foldedBy('A', BRANCH_A));
	});
});

describe('reads succeed CONTINUOUSLY across a reconfigure', () => {
	it('answers from the canonical generation at every step until the pointer moves', async () => {
		const world = await openWorld();
		await world.indexer.load();
		await driveToTip(world.indexer);

		await world.add({name: 'B', source: SOURCE_B, slowFetches: 2});

		const answers: string[][] = [world.read()];
		for (let round = 0; round < 8 && world.canonicalName() === 'A'; round++) {
			await world.indexer.indexMore();
			answers.push(world.read());
		}

		// not one read was empty, threw, or answered from a fold that had not
		// reached the cursor: every answer is either the incumbent's or the
		// successor's completed one
		const complete = [foldedBy('A', BRANCH_A), foldedBy('B', BRANCH_C)];
		for (const answer of answers) {
			expect(complete).toContainEqual(answer);
		}
		expect(answers[0]).toEqual(foldedBy('A', BRANCH_A));
		expect(answers[answers.length - 1]).toEqual(foldedBy('B', BRANCH_C));
	});
});

describe('`immediate` is canonical from CREATION, and it is opt-in', () => {
	it('promotes the successor the moment it is created, before it has caught up', async () => {
		const world = await openWorld({promotion: {policy: 'immediate'}});
		await world.indexer.load();
		await driveToTip(world.indexer);

		await world.add({name: 'B', source: SOURCE_B, slowFetches: 2});

		// story 13: the developer wants to see what the edit does, and an incomplete
		// answer from the new fold beats a complete one from the fold they replaced
		expect(world.canonicalName()).toBe('B');
		expect(world.read()).toEqual([]);

		await driveToTip(world.indexer);
		expect(world.read()).toEqual(foldedBy('B', BRANCH_C));
	});

	it('is not what the DEFAULT does: the old generation keeps answering (story 14)', async () => {
		const world = await openWorld();
		await world.indexer.load();
		await driveToTip(world.indexer);

		await world.add({name: 'B', source: SOURCE_B, slowFetches: 2});

		expect(world.canonicalName()).toBe('A');
		expect(world.read()).toEqual(foldedBy('A', BRANCH_A));
	});
});

describe('`manual` moves only when asked', () => {
	it('never promotes on its own, and still promotes when told', async () => {
		const world = await openWorld({promotion: {policy: 'manual'}});
		await world.indexer.load();
		await driveToTip(world.indexer);

		const successor = await world.add({name: 'B'});
		await driveToTip(world.indexer);

		// caught up, and still not canonical: an operator inspects first
		expect(world.canonicalName()).toBe('A');
		expect(world.stateOf('B')).toEqual(foldedBy('B', BRANCH_A));

		await world.indexer.promote(successor.record);
		expect(world.canonicalName()).toBe('B');
		expect(world.read()).toEqual(foldedBy('B', BRANCH_A));
	});
});

/**
 * `checkTxInclusion` DEGRADES HONESTLY under `immediate`, and the assertion is
 * on the BASIS and not on the status alone.
 *
 * This was checked against `verdictFor` rather than assumed. A caller WITH a
 * `minedAtBlock` above the cursor is answered `absent`, because that branch is
 * tested BEFORE the window-not-covering one -- so a consumer switching on
 * `status` alone would read "the indexer says this transaction is not there"
 * for a generation that simply has not reached it. The BASIS is what carries the
 * meaning: `ahead-of-cursor` is "not processed that far yet", which is the right
 * direction for the caller this exists for, since an optimistic update laid over
 * a fold that has not reached the transaction is right rather than double-counted.
 */
describe('`checkTxInclusion` degrades HONESTLY under `immediate`', () => {
	const PENDING = '0x00000000000000000000000000000000000000000000000000000000000000ff';

	it('answers unknown/not-synced from a generation promoted before it has loaded', async () => {
		const world = await openWorld({promotion: {policy: 'immediate'}});
		await world.indexer.load();
		await driveToTip(world.indexer);
		await world.add({name: 'B', source: SOURCE_B, slowFetches: 2});

		// canonical, and it has no cursor at all yet
		expect(world.canonicalName()).toBe('B');
		expect(checkTxInclusion(undefined, [{txHash: PENDING}], FINALITY)[PENDING]).toEqual({
			status: 'unknown',
			basis: 'not-synced',
		});
	});

	it('answers unknown/window-not-covering while catching up, and absent/ahead-of-cursor with a receipt', async () => {
		const world = await openWorld({promotion: {policy: 'immediate'}});
		await world.indexer.load();
		await driveToTip(world.indexer);
		await world.add({name: 'B', source: SOURCE_B, slowFetches: 2});

		// ONE round of the throttled successor: a real cursor, genuinely behind the
		// tip by more than the finality window
		const lastSync = await world.indexer.indexMore();
		expect(lastSync.lastToBlock).toBeLessThan(lastSync.latestBlock - FINALITY);

		expect(checkTxInclusion(lastSync, [{txHash: PENDING}], FINALITY)[PENDING]).toEqual({
			status: 'unknown',
			basis: 'window-not-covering',
		});
		// the STATUS is `absent` here, which is the claim that was wrong once
		expect(checkTxInclusion(lastSync, [{txHash: PENDING, minedAtBlock: BRANCH_A_TIP}], FINALITY)[PENDING]).toEqual({
			status: 'absent',
			basis: 'ahead-of-cursor',
		});
	});
});

/**
 * WHAT A CONSUMER IS TOLD at a promotion, and the order it is told in.
 *
 * `onPromoted` fires BEFORE the state notification, because a consumer that
 * keeps anything DERIVED from the canonical generation -- a cursor, a progress
 * figure, a `checkTxInclusion` window -- has to drop it before it is told to
 * re-read. And the cursor of the generation that now answers is PUBLISHED, so
 * what replaces it is not the retired generation's.
 */
describe('a promotion says so, and re-publishes the cursor that now answers', () => {
	it('fires `onPromoted` before the state notification, naming both generations', async () => {
		const world = await openWorld();
		await world.indexer.load();
		await driveToTip(world.indexer);

		const told: string[] = [];
		world.indexer.onPromoted = (promoted, superseded) => {
			told.push(`promoted:${promoted.processor}<-${superseded?.processor}`);
		};
		world.indexer.onStateUpdated = () => told.push(`state:${world.canonicalName()}`);
		world.indexer.onLastSyncUpdated = (lastSync) => told.push(`cursor:${lastSync.lastToBlock}`);

		await world.add({name: 'B'});
		await driveToTip(world.indexer);

		const promotion = told.indexOf('promoted:proc-B<-proc-A');
		expect(promotion).toBeGreaterThanOrEqual(0);
		expect(told.indexOf('state:B')).toBe(promotion + 1);
		// ...and the cursor that follows is the NEW canonical generation's own
		expect(told[promotion + 2]).toBe(`cursor:${BRANCH_A_TIP}`);
	});

	it('publishes NO cursor for a generation promoted before it has one', async () => {
		const world = await openWorld({promotion: {policy: 'immediate'}});
		await world.indexer.load();
		await driveToTip(world.indexer);

		const told: string[] = [];
		world.indexer.onPromoted = () => told.push('promoted');
		world.indexer.onLastSyncUpdated = (lastSync) => told.push(`cursor:${lastSync.lastToBlock}`);

		await world.add({name: 'B', source: SOURCE_B, slowFetches: 2});

		// nothing to publish: it is canonical having folded nothing, and inventing a
		// cursor for it would be the retired generation's answer wearing a new name
		expect(told).toEqual(['promoted']);
	});
});

describe('DROP-ON-PROMOTION applies only under `on-catch-up` and `manual`', () => {
	it('keeps every generation when it is not asked for, which is the default', async () => {
		const world = await openWorld();
		await world.indexer.load();
		await driveToTip(world.indexer);
		await world.add({name: 'B', source: SOURCE_B});
		await driveToTip(world.indexer);

		expect(world.canonicalName()).toBe('B');
		expect(world.dropped).toEqual([]);
		expect(world.heldNames()).toEqual(['A', 'B']);
		// still revertible, which is what retention BUYS
		await world.indexer.promote(world.indexer.generations[0].record);
		expect(world.read()).toEqual(foldedBy('A', BRANCH_A));
	});

	it('drops the superseded generation at the promotion under `on-catch-up`', async () => {
		const world = await openWorld({promotion: {dropOnPromotion: true}});
		await world.indexer.load();
		await driveToTip(world.indexer);
		await world.add({name: 'B', source: SOURCE_B, slowFetches: 2});
		await driveRounds(world.indexer);

		expect(world.canonicalName()).toBe('B');
		// the promotion DEMONSTRATED something, so the generation left behind goes
		expect(world.dropped.map((id) => id.processor)).toEqual(['proc-A']);
		expect(world.heldNames()).toEqual(['B']);
		expect((await world.registry.list()).map((record) => record.processor)).toEqual(['proc-B']);
	});

	it('RETAINS the previous generation on an `immediate` promotion, until the successor reaches its cursor', async () => {
		const world = await openWorld({promotion: {policy: 'immediate', dropOnPromotion: true}});
		await world.indexer.load();
		const caughtUp = await driveToTip(world.indexer);

		await world.add({name: 'B', source: SOURCE_B, slowFetches: 2});
		// canonical at once, and it has caught up to NOTHING: dropping A here would
		// discard a complete state for an empty one, with no fallback if the new
		// fold throws on its first event
		expect(world.canonicalName()).toBe('B');
		expect(world.dropped).toEqual([]);
		expect(world.heldNames()).toEqual(['A', 'B']);

		const behind = await world.indexer.indexMore();
		expect(behind.lastToBlock).toBeLessThan(caughtUp.lastToBlock);
		expect(world.dropped).toEqual([]);
		expect(world.heldNames()).toEqual(['A', 'B']);

		// ...and only once it reaches the cursor A had at the promotion
		await driveToTip(world.indexer);
		expect(world.dropped.map((id) => id.processor)).toEqual(['proc-A']);
		expect(world.heldNames()).toEqual(['B']);
	});

	it('drops on a `manual` promotion too, because that one demonstrated something as well', async () => {
		const world = await openWorld({promotion: {policy: 'manual', dropOnPromotion: true}});
		await world.indexer.load();
		await driveToTip(world.indexer);
		const successor = await world.add({name: 'B', source: SOURCE_B});
		await driveToTip(world.indexer);

		await world.indexer.promote(successor.record);
		expect(world.dropped.map((id) => id.processor)).toEqual(['proc-A']);
		expect(world.heldNames()).toEqual(['B']);
	});

	it('never drops a generation that WRITES a stream another one follows', async () => {
		const world = await openWorld({promotion: {dropOnPromotion: true}});
		await world.indexer.load();
		await driveToTip(world.indexer);

		// the same stream, so the successor FOLLOWS it -- and A is the writer
		await world.add({name: 'B'});
		await driveToTip(world.indexer);

		expect(world.canonicalName()).toBe('B');
		// dropping A would leave B following a stream nothing appends to, so the
		// drop is DECLINED rather than taken (ADR-0044: the writer is the first
		// generation held on a stream, and promotion does not move that duty)
		expect(world.dropped).toEqual([]);
		expect(world.heldNames()).toEqual(['A', 'B']);
	});

	it('does not drop on a REVERT: a backwards move supersedes nothing', async () => {
		const world = await openWorld({promotion: {policy: 'manual', dropOnPromotion: true}});
		await world.indexer.load();
		await driveToTip(world.indexer);
		const successor = await world.add({name: 'B', source: SOURCE_B});
		await driveToTip(world.indexer);
		await world.indexer.promote(successor.record);
		expect(world.heldNames()).toEqual(['B']);

		// and the other direction, from a world where nothing was dropped
		const kept = await openWorld({promotion: {policy: 'manual'}});
		await kept.indexer.load();
		await driveToTip(kept.indexer);
		const newer = await kept.add({name: 'B', source: SOURCE_B});
		await driveToTip(kept.indexer);
		await kept.indexer.promote(newer.record);
		await kept.indexer.promote(kept.indexer.generations[0].record);
		expect(kept.dropped).toEqual([]);
		expect(kept.heldNames()).toEqual(['A', 'B']);
	});
});

describe('a superseded generation is never EVICTED by a cap', () => {
	it('refuses the new generation and names what to delete, holding on to the old one', async () => {
		const world = await openWorld({caps: {maxGenerations: 2, maxStreams: 2}});
		await world.indexer.load();
		await driveToTip(world.indexer);
		await world.add({name: 'B'});
		await driveToTip(world.indexer);
		expect(world.canonicalName()).toBe('B');

		await expect(world.add({name: 'C'})).rejects.toThrow(GenerationCapReachedError);

		// the superseded generation is still there: an eviction policy cannot know
		// which generation was being kept, and a wrong one costs a re-index
		expect(world.heldNames()).toEqual(['A', 'B']);
		expect(world.dropped).toEqual([]);
	});
});
