import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {openIndexer} from '../src/container.js';
import {openMemoryGenerationRegistry} from '../src/generation/memory.js';
import {IndexerGeneration} from '../src/indexer.js';
import {StateMovedPublisher, type StateMoved} from '../src/stateMoved.js';
import type {EventProcessor, LastSync} from '../src/types.js';
import {BRANCH_A, fakeChain, FINALITY, makeLog, SOURCE} from './utils/streamCacheWorld.js';
import {appendsIn, driveToTip, openWorld, reportingFold} from './utils/stateMovedWorld.js';
import {identityOf} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------
// THE FOLD PUBLISHES WHAT IT JUST CHANGED
// ---------------------------------------------------------------------------
// The side that APPLIED a block tells the sides that are READING, in one shape
// every transport carries unchanged (ADR-0083). What is asserted here is the
// CONTAINER's half of that: one notification per block the CANONICAL fold
// applies, carrying the generation that answered and a token that does not move
// while nothing invalidates -- plus the three properties every transport
// downstream depends on (nothing held per subscriber, a throwing handler
// contained, a channel that does not go quiet across a reconfigure).
//
// The ENTITY NAMES are the layer below's and are asserted where they are
// produced, against a real processor over the real workload:
// `@etherfold/conformance-workload-stratagems`'s
// `theFoldPublishesWhatItJustChanged.test.ts`. The folds here report names of
// their own, because what a container does with the set is relay it.
//
// The world, the fold and the drive live in `utils/stateMovedWorld.ts`, beside
// the RETRACTION cases that ask the same questions of the same container
// (`aRetractionNamesTheForkPoint.test.ts`).
// ---------------------------------------------------------------------------

describe('the fold publishes what it just changed', () => {
	it('publishes ONE notification per applied block, naming the block, the generation and the entities', async () => {
		const fold = reportingFold('A', (block) => (block === 102 ? ['cell', 'player'] : ['cell']));
		const world = await openWorld([fold]);
		await world.indexer.load();
		await driveToTip(world.indexer);

		const appends = appendsIn(world.moved);
		expect(fold.applied.length).toBeGreaterThan(0);
		expect(appends.map((notification) => notification.block)).toEqual(fold.applied);
		expect(appends.every((notification) => notification.generation === world.digestOf('A'))).toBe(true);
		expect(appends.find((notification) => notification.block === 102)?.entities).toEqual(['cell', 'player']);
	});

	it('carries ONE unchanged token while nothing invalidates', async () => {
		// N blocks folded canonically, no reorg and no promotion: N notifications and
		// one token. The token is what makes best-effort delivery safe, so it must
		// move ONLY when something says what a reader holds may be wrong.
		const world = await openWorld([reportingFold('A')]);
		await world.indexer.load();
		await driveToTip(world.indexer);

		const tokens = new Set(world.moved.map((notification) => notification.coherence));
		expect(world.moved.length).toBeGreaterThan(1);
		expect(tokens.size).toBe(1);
	});

	it('keeps the token OPAQUE: it is compared and never parsed', async () => {
		// The assertion is deliberately only a COMPARISON, because that is the whole
		// contract: two producers are two tokens, and a rotation is a third. Nothing
		// here reads a block, a generation or a time out of one, and nothing may.
		const first = new StateMovedPublisher();
		const second = new StateMovedPublisher();
		expect(typeof first.token).toBe('string');
		expect(first.token).not.toBe(second.token);

		const before = first.token;
		const after = first.rotate('a retraction, in a later task');
		expect(after).not.toBe(before);
		expect(first.token).toBe(after);
	});

	it('publishes an EMPTY entity set for a block that touched nothing', async () => {
		// A block whose handlers produced no mutation was still APPLIED -- it is
		// recorded and the cursor moved with it -- so it is published, with nothing to
		// invalidate narrowly. The rule is "one notification per APPLIED BLOCK", not
		// "per block that changed something", and this is what makes it one rule.
		const fold = reportingFold('A', () => []);
		const world = await openWorld([fold]);
		await world.indexer.load();
		await driveToTip(world.indexer);

		expect(world.moved.length).toBe(fold.applied.length);
		expect(appendsIn(world.moved).every((notification) => notification.entities.length === 0)).toBe(true);
	});

	it('publishes NOTHING for a non-canonical generation re-folding a stored stream', async () => {
		// A follower re-folds the WHOLE stored stream to catch up, so a per-block
		// publication there would fire one notification per past block while nothing a
		// reader can see has moved. Asserted rather than assumed: the follower's fold
		// really does apply those blocks, and NONE of them is published.
		const canonicalFold = reportingFold('A');
		const world = await openWorld([canonicalFold], {keepStream: true});
		await world.indexer.load();
		await driveToTip(world.indexer);
		const publishedBeforeTheFollower = world.moved.length;

		const follower = reportingFold('B');
		const held = await world.add(follower);
		expect(held.follows).toBe(true);
		await world.indexer.load();
		await driveToTip(world.indexer);

		// the follower DID apply the stream -- otherwise this asserts nothing
		expect(follower.applied.length).toBeGreaterThan(0);
		expect(world.moved.every((notification) => notification.generation === world.digestOf('A'))).toBe(true);
		expect(world.moved.length).toBe(publishedBeforeTheFollower);
	});

	it('does not go quiet when a reconfigure swaps the processor in place', async () => {
		const before = reportingFold('A');
		const world = await openWorld([before]);
		await world.indexer.load();
		await driveToTip(world.indexer);
		const published = world.moved.length;
		expect(published).toBeGreaterThan(0);

		const after = reportingFold('B');
		const outcome = await world.indexer.updateProcessor(after.processor, {force: true});
		expect(outcome.stateDiscarded).toBe(true);
		// the fold that was replaced is detached; the one folding now is attached
		expect(before.attached).toBe(false);
		expect(after.attached).toBe(true);

		world.chain.serve([...BRANCH_A, makeLog(106, '0xa106')], 107);
		await driveToTip(world.indexer);

		const appends = appendsIn(world.moved);
		expect(world.moved.length).toBeGreaterThan(published);
		expect(appends[appends.length - 1].generation).toBe(world.digestOf('A'));
		expect(appends[appends.length - 1].block).toBe(106);
	});

	it('SUBSCRIBES and UNSUBSCRIBES symmetrically, and holds nothing else per subscriber', async () => {
		// The producer must remember NOTHING about who is listening: no buffer, no
		// retry, no cursor per client. That is what stops a SharedWorker's memory
		// growing with the number of open tabs, and every transport downstream rests
		// on it -- so it is asserted on what the producer HOLDS and not on what it
		// delivers.
		const publisher = new StateMovedPublisher();
		const shape = Object.keys(publisher).sort();

		const detaches = Array.from({length: 50}, (_, index) =>
			publisher.subscribe(() => {
				void index;
			}),
		);
		expect(publisher.subscriberCount).toBe(50);
		publisher.publish({block: 1, entities: ['cell'], generation: 'g'});
		// the SHAPE of the producer is unchanged: 50 handler references and no
		// per-subscriber record beside them
		expect(Object.keys(publisher).sort()).toEqual(shape);

		for (const detach of detaches) detach();
		expect(publisher.subscriberCount).toBe(0);

		// and detaching really does stop delivery
		let called = 0;
		const detach = publisher.subscribe(() => called++);
		publisher.publish({block: 2, entities: [], generation: 'g'});
		detach();
		publisher.publish({block: 3, entities: [], generation: 'g'});
		expect(called).toBe(1);
	});

	it('CONTAINS a handler that throws, exactly as onStateUpdated does', async () => {
		const fold = reportingFold('A');
		const world = await openWorld([fold]);
		const seen: number[] = [];
		world.indexer.onStateMoved(() => {
			throw new Error('a subscriber blew up');
		});
		world.indexer.onStateMoved((notification) => seen.push(appendsIn([notification])[0].block));

		await world.indexer.load();
		await driveToTip(world.indexer);

		// the fold ran to the tip, and the handler beside the throwing one was told
		expect(fold.applied.length).toBeGreaterThan(0);
		expect(seen).toEqual(fold.applied);
	});

	it('publishes NOTHING for a fold that reports nothing, rather than a fabricated set', async () => {
		// A processor that implements no reporting channel cannot say which blocks it
		// applied, and core cannot know: `process` returns an opaque result and this
		// package has no mutation vocabulary at all. Silence is the honest answer
		// there; the entity path is what fills it.
		const silent: EventProcessor<Abi, string[]> = {
			// still on the seam until the contract task removes it, and read by nobody: the
			// spec below hands the container the identity this fold ARRIVED with
			getVersionHash: () => 'declared-version-of-silent',
			getCodeFingerprint: () => undefined,
			load: async () => undefined,
			process: async () => [],
			reset: async () => {},
			clear: async () => {},
		};
		const chain = fakeChain(BRANCH_A, 105);
		const registry = await openMemoryGenerationRegistry({maxGenerations: 2, maxStreams: 1});
		const indexer = await openIndexer<Abi, string[]>({
			registry,
			provider: chain.provider,
			source: SOURCE,
			config: {stream: {finality: FINALITY}},
			generations: [
				{
					createState: () => ({}),
					createProcessor: () => silent,
					processorIdentity: identityOf('silent'),
					stateOf: () => [],
				},
			],
			createGeneration: (provider, processor, source, config, processorIdentity) => {
				const generation = new IndexerGeneration<Abi, string[]>(provider, processor, source, config, {
					processorIdentity,
				});
				(generation as unknown as {logEventFetcher: unknown}).logEventFetcher = chain.fetcher;
				return generation;
			},
		});
		const moved: StateMoved[] = [];
		indexer.onStateMoved((notification) => moved.push(notification));

		await indexer.load();
		await driveToTip(indexer);
		const cursor: LastSync<Abi> = await indexer.indexMore();

		expect(cursor.lastToBlock).toBeGreaterThan(0);
		expect(moved).toEqual([]);
	});
});
