import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {MemoryStateStore, openForWriting, type WritableStateStore} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	createIndexerState,
	keepStreamOnIndexedDB,
	serveIndexerHost,
	type HostAccess,
	type HostGeneration,
	type IndexerPort,
} from '../src/index.js';
import {wire} from './utils/port.js';
import {
	abi,
	BRANCH_A_TIP,
	entityProcessorOver,
	FINALITY,
	fakeChain,
	indexToTip,
	processor,
	processorVariant,
	SOURCE,
	START_BLOCK,
	type TestABI,
} from '../browser/workload.js';

/**
 * A successor whose catch-up takes SEVERAL cycles.
 *
 * A different address, so this is a stream of its own and it FETCHES rather than
 * following; and the full span from `START_BLOCK`, so at the four-block fetch
 * width above it needs more than one range to reach the tip. That is the whole
 * point: a successor that caught up in ONE cycle would be carried by the wake
 * alone and would pass whatever the rest rule said.
 */
const SOURCE_ON_ANOTHER_STREAM = {
	chainId: '1',
	contracts: [{abi, address: '0x00000000000000000000000000000000000000aa' as const, startBlock: START_BLOCK}],
};

async function memoryStore(entities: ConstructorParameters<typeof MemoryStateStore>[0]): Promise<WritableStateStore> {
	return openForWriting(new MemoryStateStore(entities));
}

/** Poll until something becomes true, or the test times out. */
async function until(satisfied: () => boolean): Promise<void> {
	for (;;) {
		if (satisfied()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/**
 * THE DRIVER RESTS ON THE WHOLE CONTAINER, NOT ON THE GENERATION THAT ANSWERS
 * READS.
 *
 * `Indexer.indexMore` advances EVERY generation the container holds, one step per
 * call. The driver used to decide whether to rest from the CANONICAL cursor
 * alone, so a successor added by a reconfigure -- while the canonical generation
 * was already at the tip -- got exactly ONE fetch range per tip interval, with
 * the process idle in between. On the default four seconds that is over an hour
 * of wall clock for a successor with a thousand ranges of history to fetch, and
 * nothing anywhere said so: the host reported `at-tip` truthfully, because the
 * generation it was reporting on WAS at the tip.
 *
 * ## Why these cases do not measure time
 *
 * A duration assertion here would be a flake on a loaded machine. Instead the tip
 * interval is set ABSURDLY LONG (`SLOW_REST`), so the two behaviours differ by
 * something a test can state without a stopwatch: under the old rule a catching-up
 * successor makes no further progress at all within the test's lifetime, and under
 * the new one it reaches the tip immediately. The assertion is "it caught up",
 * and the long rest is what makes that assertion mean something.
 *
 * ## The hot loop is the other half, and it is NOT pinned here -- deliberately
 *
 * A generation that is behind and CANNOT advance must not spin the loop, which is
 * the failure mode the canonical-cursor rule accidentally protected against. The
 * driver guards it by resting on a cycle that moved NOTHING (`movedAgainst` in
 * `src/host/serve.ts`), and that branch has no case here because nothing could be
 * found that reaches it through the public host surface: for a generation that
 * fetches from a chain, "behind" implies "progressing", since an empty range still
 * advances the cursor past it (the third case below is exactly that, and it is why
 * the obvious fixture for a stall is not one). The remaining candidate is a
 * FOLLOWER whose stream stops growing, which re-folds from storage and makes no
 * chain call, so it is invisible to the only instrument these cases have.
 *
 * So the guard is DEFENSIVE and untested rather than load-bearing and proven, and
 * that is worth knowing rather than glossing: it is cheap, it cannot make the
 * rested case worse, and the failure it prevents (a browser tab hammering a
 * rate-limited provider) is severe enough to be worth an unexercised branch.
 */

let counter = 0;
const freshName = () => `levels-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A rest so long that nothing waits it out.
 *
 * Any case here that reaches the tip did so WITHOUT resting between ranges: one
 * rest would outlast the run.
 */
const SLOW_REST = 600;

function hostOver(access: HostAccess, databaseName: string, chain: ReturnType<typeof fakeChain>, tipInterval: number) {
	return serveIndexerHost<TestABI, EntityStateView>(
		{
			// ONE STORE PER GENERATION, keyed on the generation's own stream. Load-bearing
			// for every case here, because all of them hold two generations at once: two
			// generations under one database are ONE store, and their cursors collide under
			// the fixed sync-cursor key, so the successor never advances at all.
			createState: async (context) =>
				openForWriting(
					await createBrowserStateStore(processor.entities, {databaseName: `${databaseName}-${context.stream}`}),
				),
			createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
			provider: chain.provider,
			source: SOURCE,
			// Narrow ranges, so catching up is several advances rather than one. Kept
			// ABOVE the finality depth deliberately: a cycle rewinds by the unconfirmed
			// window before it fetches, so a range narrower than that window re-asks for
			// blocks it already has and the cursor never moves at all (see
			// `work/notes/observations/a-fetch-narrower-than-finality-never-advances.md`).
			config: {stream: {finality: FINALITY}, fetch: {numBlocksToFetchAtStart: 4, maxBlocksPerFetch: 4}},
			tipIntervalInSeconds: tipInterval,
		},
		access,
	);
}

/** Poll the port until the generations satisfy something, or the test times out. */
async function untilGenerations(
	port: IndexerPort,
	satisfied: (generations: readonly HostGeneration[]) => boolean,
): Promise<readonly HostGeneration[]> {
	for (;;) {
		const generations = await port.generations();
		if (satisfied(generations)) return generations;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe('the driver rests only when the whole container is level', () => {
	it('catches a successor up without a rest between its ranges', async () => {
		const ends = wire();
		const chain = fakeChain();
		// The rest is ten minutes. Under the rule this replaces, the successor added
		// below advanced once per rest, so it would still be short of the tip when this
		// test gave up -- which is exactly the bug, at a scale a test can see.
		const host = hostOver(ends.host, freshName(), chain, SLOW_REST);
		const port = connectToIndexerHost(ends.tab);

		try {
			// The incumbent reaches the tip, so the driver is now RESTING: this is the
			// state in which a reconfigure used to be so expensive.
			await untilGenerations(port, (generations) => generations[0]?.lastToBlock === BRANCH_A_TIP);

			const reconfigured = await port.reconfigure({source: SOURCE_ON_ANOTHER_STREAM});
			expect(reconfigured.added).toBe(true);

			// The successor crosses its whole span -- SEVERAL fetch ranges -- all inside
			// one test, with a ten-minute rest configured. Under the rule this replaces
			// it advanced one range per rest, so it would still be short of the tip when
			// this test gave up, which is exactly the bug at a scale a test can see.
			const generations = await untilGenerations(port, (all) => all.every((one) => one.lastToBlock === BRANCH_A_TIP));

			expect(generations).toHaveLength(2);
			for (const generation of generations) {
				expect(generation.lastToBlock).toBe(BRANCH_A_TIP);
			}
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('still rests once everything is level, rather than spinning on the tip', async () => {
		const ends = wire();
		const chain = fakeChain();
		// A short rest here, because what is being asserted is that the loop DOES rest:
		// the fixture's tip never moves, so every advance past the first is a provider
		// call bought for nothing.
		const host = hostOver(ends.host, freshName(), chain, 0.25);
		const port = connectToIndexerHost(ends.tab);

		try {
			await untilGenerations(port, (generations) => generations[0]?.lastToBlock === BRANCH_A_TIP);
			const settled = chain.ranges.length;

			// Two rests' worth of wall clock. A driver spinning instead of resting would
			// have asked for a great many ranges in that time.
			await new Promise((resolve) => setTimeout(resolve, 120));

			// At most one further cycle: the rest is what stops a fixture whose tip never
			// moves from becoming a busy loop against a rate-limited provider.
			expect(chain.ranges.length - settled).toBeLessThanOrEqual(1);
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('drives flat out while a generation is genuinely behind, rather than pacing real work', async () => {
		const ends = wire();
		const chain = fakeChain();
		// A tip far above anything this fixture serves logs for, so the fold has a long
		// EMPTY span to cross. It is behind and it CAN advance, which is the case the
		// rest must not pace: an empty range still costs a round trip, and paying a tip
		// interval for each of them is the hour of wall clock this change removes.
		const ahead = {
			...chain,
			provider: {
				async request(args: {method: string; params?: unknown}): Promise<unknown> {
					if (args.method === 'eth_blockNumber') return `0x${(BRANCH_A_TIP + 2_000).toString(16)}`;
					return chain.provider.request(args as never);
				},
			} as never,
		};
		const host = hostOver(ends.host, freshName(), ahead, SLOW_REST);
		const port = connectToIndexerHost(ends.tab);

		try {
			// It crosses the empty span and reaches the distant tip, with a ten-minute
			// rest configured: only possible without a rest between ranges.
			await untilGenerations(port, (generations) => (generations[0]?.lastToBlock ?? 0) >= BRANCH_A_TIP + 2_000);
			expect((await port.progress()).phase).toBe('at-tip');
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});
});

/**
 * THE SAME RULE ON THE MAIN-THREAD DRIVER.
 *
 * The two hosts are two implementations of one idea, and this defect was in both:
 * `_auto_index_cycle` (`src/IndexerState.ts`) re-armed on the full interval unless
 * the CANONICAL cursor was behind, so a successor caught up one cycle per interval
 * there too. Pinned in the same file as the worker host's, so the next person to
 * touch either can see that the other one exists.
 *
 * A FOLLOWER is used here rather than a second source: a processor-only change
 * shares the stream, so it re-folds from storage and needs no chain call, which
 * makes this a claim about the LOOP alone.
 */
describe('the main-thread driver rests on the same rule', () => {
	it('catches a follower up without waiting an interval per cycle', async () => {
		const chain = fakeChain();
		const indexer = createIndexerState<TestABI, EntityStateView>(
			{
				createState: () => memoryStore(processor.entities),
				createProcessor: (state) => entityProcessorOver(state, processor),
			},
			{keepStream: keepStreamOnIndexedDB<TestABI>(freshName())},
		);

		try {
			await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
			await indexToTip(indexer);
			// Ten minutes. Everything below happens inside one test, so nothing waited.
			await indexer.startAutoIndexing(SLOW_REST);

			const edited = processorVariant({version: '2.0.0', countBy: 2});
			const successor = await indexer.addGeneration({
				createState: () => memoryStore(edited.entities),
				createProcessor: (state) => entityProcessorOver(state, edited),
			});
			// The same stream, so this one FOLLOWS rather than fetching.
			expect(successor.follows).toBe(true);

			// It catches up, with a ten-minute re-arm configured: only possible if the
			// loop stopped resting once a generation it holds was behind. Before this fix
			// the follower sat with NO cursor at all until the interval elapsed.
			await until(() => indexer.generations.every((one) => one.lastSync?.lastToBlock === BRANCH_A_TIP));
			expect(indexer.generations).toHaveLength(2);
			for (const generation of indexer.generations) {
				expect(generation.lastSync?.lastToBlock).toBe(BRANCH_A_TIP);
			}
		} finally {
			indexer.dispose();
		}
	});
});
