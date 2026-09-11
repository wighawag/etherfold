import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, EntityStateView} from '@etherfold/processor-entities';
import {
	openMemoryGenerationRegistry,
	type GenerationCaps,
	type GenerationId,
	type IndexingSource,
	type PromotionConfig,
} from '@etherfold/core';
import {openForReading, openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	serveIndexerHost,
	type HostAccess,
	type HostGeneration,
	type IndexerHost,
	type IndexerPort,
} from '../src/index.js';
import {wire} from './utils/port.js';
import {
	BRANCH_A_TIP,
	EXPECTED_A,
	EXPECTED_A_FROM_LATER_BLOCK,
	FINALITY,
	fakeChain,
	processor,
	readState,
	RECONFIGURED_FROM_BLOCK,
	SOURCE,
	SOURCE_FROM_LATER_BLOCK,
	SOURCE_REDEPLOYED_SAME_ABI,
	START_BLOCK,
	type TestABI,
} from '../browser/workload.js';

/**
 * A TAB STARTING, STOPPING AND RECONFIGURING ITS HOST -- over a real
 * `MessagePort`, in node.
 *
 * What runs in a REAL browser with a REAL dedicated worker is the
 * `controls-the-indexer` case of `browser/controlsTheIndexer.spec.ts`. These are
 * the same claims on every commit, because that run needs browser binaries a
 * clean checkout does not have.
 *
 * The ORACLE for the reconfigure half is `test/reconfigure.test.ts` and
 * `test/promotion.test.ts`, which drive the same container through
 * `createIndexerState` on this thread. Nothing about the generation machinery
 * changes here: the reconfigure still adds a generation beside the live one,
 * the canonical one still answers every read until the policy moves the pointer,
 * and what this file adds is that a tab holding only a port can ASK for it and
 * SEE what happened.
 *
 * ## Nothing here waits on a clock
 *
 * The chain is GATED (`gatedChain`), so a case decides when the host may make
 * progress, and every wait is for a VALUE (a cursor, a phase, a pointer that
 * moved) rather than for a duration.
 */

let counter = 0;
const freshName = () => `controlled-indexer-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The captured stream behind a gate, counting what the chain was asked for.
 *
 * The RANGES are the evidence for two of this file's claims that no state can
 * carry: "no further chain requests after a stop resolves" is a count that stops
 * moving, and "a stopped indexer resumes without re-indexing or skipping" is
 * about which blocks were asked for, not about the rows a re-index would land on
 * identically.
 */
function gatedChain() {
	const chain = fakeChain();
	let open: () => void;
	const gate = new Promise<void>((resolve) => (open = resolve));
	const underlying = chain.provider.request.bind(chain.provider);
	let holding: {announce: () => void; held: Promise<void>} | undefined;
	return {
		ranges: chain.ranges,
		release: () => open(),
		/**
		 * HOLD THE NEXT FETCH OPEN, so a case can ask for something while a cycle is
		 * genuinely in flight rather than between two of them.
		 *
		 * `reached` resolves when the host is inside the call; `release` lets it
		 * answer. A fake chain answers instantly otherwise, so "mid-cycle" would
		 * otherwise be a window nothing can be observed in, let alone act in.
		 */
		holdNextFetch(): {reached: Promise<void>; release: () => void} {
			let announce!: () => void;
			let release!: () => void;
			const reached = new Promise<void>((resolve) => (announce = resolve));
			const held = new Promise<void>((resolve) => (release = resolve));
			holding = {announce, held};
			return {reached, release};
		},
		provider: {
			async request(args: {method: string; params?: unknown}): Promise<unknown> {
				await gate;
				if (args.method === 'eth_getLogs' && holding) {
					const waiting = holding;
					holding = undefined;
					waiting.announce();
					await waiting.held;
				}
				return underlying(args as never);
			},
		} as never,
	};
}

type Chain = ReturnType<typeof gatedChain>;

function hostOver(
	access: HostAccess,
	databaseName: string,
	chain: Chain,
	options: {
		promotion?: PromotionConfig;
		caps?: GenerationCaps;
		source?: IndexingSource<TestABI>;
		fetchWidth?: number;
	} = {},
): Promise<IndexerHost> {
	const registry = openMemoryGenerationRegistry(options.caps ?? {maxGenerations: 4, maxStreams: 4});
	return registry.then((held) =>
		serveIndexerHost<TestABI, EntityStateView>(
			{
				registry: held,
				// ONE STORE PER GENERATION, keyed on the generation's own stream -- the rule
				// `GenerationSpec.createState` states, and the one a reconfigure makes
				// load-bearing: two generations under one database are ONE store, and their
				// cursors collide under the fixed sync-cursor key.
				createState: async (context) =>
					openForWriting(
						await createBrowserStateStore(processor.entities, {databaseName: `${databaseName}-${context.stream}`}),
					),
				createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
				provider: chain.provider,
				source: options.source ?? SOURCE,
				config: {
					stream: {finality: FINALITY},
					...(options.fetchWidth
						? {fetch: {numBlocksToFetchAtStart: options.fetchWidth, maxBlocksPerFetch: options.fetchWidth}}
						: {}),
				},
				// Passed through UN-DEFAULTED, exactly as an application passes it: absent
				// where a case does not select one, which is what the first reconfigure case
				// below asserts about.
				...(options.promotion ? {promotion: options.promotion} : {}),
				// The node run has no reason to rest for four seconds at the tip.
				tipIntervalInSeconds: 0.05,
			},
			access,
		),
	);
}

/** Ask until a predicate holds, and fail SAYING WHAT the host was doing if it never does. */
async function until(
	port: IndexerPort,
	matches: (progress: Awaited<ReturnType<IndexerPort['progress']>>) => boolean,
	attempts = 400,
): Promise<Awaited<ReturnType<IndexerPort['progress']>>> {
	let progress = await port.progress();
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (progress.failure) {
			throw new Error(`the host stopped: ${progress.failure.name}: ${progress.failure.message}`);
		}
		if (matches(progress)) return progress;
		await new Promise((resolve) => setTimeout(resolve, 10));
		progress = await port.progress();
	}
	throw new Error(`the host never got there: ${JSON.stringify(progress)}`);
}

/**
 * Level with THIS FIXTURE'S tip, named rather than inferred from equality: a
 * container that has loaded and not yet fetched publishes `0` of `0`, so
 * `lastToBlock === latestBlock` is true before a single log has been asked for.
 */
const atTip = (port: IndexerPort) =>
	until(port, (progress) => progress.latestBlock === BRANCH_A_TIP && progress.lastToBlock === progress.latestBlock);

/** Ask until the generation list says what a case is waiting for. */
async function untilGenerations(
	port: IndexerPort,
	matches: (generations: readonly HostGeneration[]) => boolean,
	attempts = 400,
): Promise<readonly HostGeneration[]> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const generations = await port.generations();
		if (matches(generations)) return generations;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`the generations never got there: ${JSON.stringify(await port.generations())}`);
}

/** The state a generation wrote, read back the way a tab would: through a READER. */
async function stateOf(databaseName: string, generation: GenerationId) {
	const reader = openForReading(
		await createBrowserStateStore(processor.entities, {databaseName: `${databaseName}-${generation.stream}`}),
	);
	return readState(new EntityStateView(reader));
}

describe('a tab starting and stopping its host', () => {
	it('stops indexing, and the host makes no chain request after the stop has answered', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = await hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);

		try {
			chain.release();
			await atTip(port);

			const stopped = await port.stopIndexing();
			expect(stopped.indexing).toBe(false);
			// The FOLD is still where it got to: `indexing` says whether a driver is
			// advancing it, and the phase says where it is.
			expect(stopped.phase).toBe('at-tip');
			expect(stopped.lastToBlock).toBe(BRANCH_A_TIP);

			// The host was resting at the tip and would have asked for more ranges
			// several times over in this window. It asked for none.
			const asked = chain.ranges.length;
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(chain.ranges.length).toBe(asked);
			expect((await port.progress()).indexing).toBe(false);

			// ...and it is still a host: the store it folded into goes on answering,
			// because stopping the DRIVER is not closing the CONTAINER.
			expect(await port.reads.getCurrent('counter', {name: 'transfers'})).toEqual({
				name: 'transfers',
				value: EXPECTED_A.transfers,
			});

			// started again, it goes on fetching from where it was
			await port.startIndexing();
			await until(port, () => chain.ranges.length > asked);
			expect((await port.progress()).indexing).toBe(true);
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * A STOP THAT LANDS MID-CYCLE, which is the case the promise is actually about:
	 * a stop asked for while a fetch is in flight LETS THAT CYCLE LAND rather than
	 * cutting it in half, so the cursor is where a completed cycle would have left
	 * it and the resumed run neither re-indexes nor skips.
	 *
	 * The fixture is fetched four blocks at a time so that there are several cycles
	 * to land in, and the stop is asked for while the chain is SERVING one.
	 */
	it('lets the cycle in flight land, and resumes without re-indexing or skipping', async () => {
		const databaseName = freshName();
		const ends = wire();
		const chain = gatedChain();
		const host = await hostOver(ends.host, databaseName, chain, {fetchWidth: 4});
		const port = connectToIndexerHost(ends.tab);

		try {
			const held = chain.holdNextFetch();
			chain.release();
			// A fetch is in flight, and the host is inside it.
			await held.reached;

			const stopping = port.stopIndexing();
			let answered = false;
			void stopping.then(() => (answered = true));
			await new Promise((resolve) => setTimeout(resolve, 50));
			// It has NOT answered: the cycle it landed in is being let land, rather than
			// cut in half.
			expect(answered).toBe(false);

			held.release();
			const stopped = await stopping;

			expect(stopped.indexing).toBe(false);
			const asked = [...chain.ranges];
			// A cursor that a completed cycle left: the last range asked for was
			// FINISHED, so the fold reaches the top of it.
			expect(stopped.lastToBlock).toBe(asked[asked.length - 1].to);

			// nothing else is asked for while it is stopped
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(chain.ranges.length).toBe(asked.length);

			await port.startIndexing();
			const done = await atTip(port);

			// THE RANGES ARE CONTIGUOUS ACROSS THE STOP: the resumed run asks for
			// blocks it has not folded, starting no higher than the block after the
			// cursor (it may RE-ASK for the unconfirmed window, which is a re-scan and
			// not a re-index) and leaving no gap.
			let covered = START_BLOCK - 1;
			for (const range of chain.ranges) {
				expect(range.from).toBeLessThanOrEqual(covered + 1);
				covered = Math.max(covered, range.to);
			}
			expect(covered).toBe(BRANCH_A_TIP);
			expect(done.lastToBlock).toBe(BRANCH_A_TIP);

			// ...and the state is the state this workload produces anywhere else: the
			// interrupted run folded every event exactly once.
			expect(await stateOf(databaseName, (await port.generations())[0].record)).toEqual(EXPECTED_A);
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * Asking for a state the host is already in is an ANSWER, not a refusal: a
	 * settings screen and a visibility handler each asking once must leave the host
	 * in the state they both asked for rather than wedging it.
	 */
	it('answers a start that is already started and a stop that is already stopped, and wedges nothing', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = await hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);

		try {
			chain.release();
			expect((await port.startIndexing()).indexing).toBe(true);
			expect((await port.startIndexing()).indexing).toBe(true);
			await atTip(port);

			expect((await port.stopIndexing()).indexing).toBe(false);
			expect((await port.stopIndexing()).indexing).toBe(false);
			const asked = chain.ranges.length;
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(chain.ranges.length).toBe(asked);

			// and it still starts, after all of that
			await port.startIndexing();
			expect((await atTip(port)).indexing).toBe(true);

			// A STOP AND A START IN FLIGHT AT ONCE, which two components each minding
			// their own business produce: the last one to be served decides, and what
			// must not happen is a host that was asked to index sitting there not
			// indexing because the stop unwound after the start had looked.
			const [, started] = await Promise.all([port.stopIndexing(), port.startIndexing()]);
			expect(started.indexing).toBe(true);
			expect((await port.progress()).indexing).toBe(true);
			const asking = chain.ranges.length;
			await until(port, () => chain.ranges.length > asking);
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('tells a subscriber that the driver stopped, rather than simply going quiet', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = await hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);

		try {
			chain.release();
			await atTip(port);

			const pushed = new Promise<boolean>((resolve) => {
				const stop = port.onProgress((progress) => {
					if (!progress.indexing) {
						resolve(true);
						queueMicrotask(() => stop());
					}
				});
			});
			await port.stopIndexing();
			// Silence is the one thing a stalled host and a stopped one look identical
			// in (ADR-0082), so the stop is a CHANGE and is pushed like any other.
			expect(await pushed).toBe(true);
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});
});

describe('a tab reconfiguring the source', () => {
	/**
	 * THE RECONFIGURE, end to end: a generation beside the live one, the live one
	 * still answering while it catches up, and the pointer moving when the policy
	 * says so. `test/promotion.test.ts` is the oracle for that behaviour on this
	 * thread; what is asserted here is that it is reachable from a tab.
	 */
	it('adds a generation beside the live one, and the promoted one answers reads', async () => {
		const databaseName = freshName();
		const ends = wire();
		const chain = gatedChain();
		const host = await hostOver(ends.host, databaseName, chain);
		const port = connectToIndexerHost(ends.tab);

		try {
			chain.release();
			await atTip(port);
			const incumbent = (await port.generations())[0];
			expect(await port.reads.getCurrent('counter', {name: 'transfers'})).toEqual({
				name: 'transfers',
				value: EXPECTED_A.transfers,
			});

			const reconfigured = await port.reconfigure({source: SOURCE_FROM_LATER_BLOCK});

			// A generation was CREATED, on a stream of its own: a different source is a
			// different fetch filter, so it fetches its logs rather than following the
			// stream that is already there.
			expect(reconfigured.added).toBe(true);
			expect(reconfigured.generation.follows).toBe(false);
			expect(reconfigured.generation.record.stream).not.toBe(incumbent.record.stream);
			// ...and it is NOT answering reads yet, which is what makes a reconfigure
			// not an outage: the default policy is `on-catch-up`.
			expect(reconfigured.generation.canonical).toBe(false);
			expect(await port.reads.getCurrent('counter', {name: 'transfers'})).toEqual({
				name: 'transfers',
				value: EXPECTED_A.transfers,
			});

			// It catches up, the pointer moves, and the reads switch WITH it: what the
			// tab is answered from is the store the promoted generation folds into.
			await untilGenerations(
				port,
				(generations) =>
					generations.find((generation) => generation.record.stream === reconfigured.generation.record.stream)
						?.canonical === true,
			);
			expect(await port.reads.getCurrent('counter', {name: 'transfers'})).toEqual({
				name: 'transfers',
				value: EXPECTED_A_FROM_LATER_BLOCK.transfers,
			});

			// and nothing was discarded: the generation that was superseded still holds
			// the complete fold the pointer can move back to.
			expect(await stateOf(databaseName, incumbent.record)).toEqual(EXPECTED_A);
			expect(await stateOf(databaseName, reconfigured.generation.record)).toEqual(EXPECTED_A_FROM_LATER_BLOCK);
			expect(chain.ranges.some((range) => range.from === RECONFIGURED_FROM_BLOCK)).toBe(true);
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('reports which generations exist, how far each has got, and which one answers reads', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = await hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);

		try {
			chain.release();
			await atTip(port);

			expect(await port.generations()).toEqual([
				{
					record: {stream: expect.any(String), processor: expect.any(String), createdAt: expect.any(Number)},
					canonical: true,
					follows: false,
					lastToBlock: BRANCH_A_TIP,
					blocksBehind: 0,
				},
			]);

			const reconfigured = await port.reconfigure({source: SOURCE_FROM_LATER_BLOCK});
			const both = await port.generations();
			expect(both).toHaveLength(2);
			expect(both.filter((generation) => generation.canonical)).toHaveLength(1);
			// The new one is reported FROM THE MOMENT IT EXISTS, before it has folded
			// anything: an app that dims its answers during a rebuild has to be able to
			// do so from the reconfigure rather than from the first cursor a successor
			// happens to publish.
			expect(both.map((generation) => generation.record.stream)).toContain(reconfigured.generation.record.stream);

			const caughtUp = await untilGenerations(port, (generations) =>
				generations.every((generation) => generation.lastToBlock === BRANCH_A_TIP),
			);
			expect(caughtUp.map((generation) => generation.blocksBehind)).toEqual([0, 0]);
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * A source that hashes to a generation the host already holds RESOLVES to it.
	 * The container refuses to put a second engine over one state, and a tab is
	 * told that nothing was created rather than being left to infer it.
	 */
	it('resolves to the live generation when the source did not really change', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = await hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);

		try {
			chain.release();
			await atTip(port);
			const incumbent = (await port.generations())[0];

			// A new object, rebuilt from the same bytes: what a redeploy produces when
			// the implementation changed and its events did not.
			const reconfigured = await port.reconfigure({source: SOURCE_REDEPLOYED_SAME_ABI});

			expect(reconfigured.added).toBe(false);
			expect(reconfigured.generation.record).toEqual(incumbent.record);
			expect(reconfigured.generation.canonical).toBe(true);
			expect(await port.generations()).toHaveLength(1);
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('reports the promotion policy the container resolved, and defaults nothing at the boundary', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = await hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);

		const chosen = wire();
		const chain2 = gatedChain();
		const host2 = await hostOver(chosen.host, freshName(), chain2, {promotion: {policy: 'immediate'}});
		const port2 = connectToIndexerHost(chosen.tab);

		try {
			// The host selects NOTHING of its own, so what a tab is told is the one
			// default there is everywhere.
			expect(await port.promotion()).toEqual({policy: 'on-catch-up', dropOnPromotion: false});
			expect(await port2.promotion()).toEqual({policy: 'immediate', dropOnPromotion: false});

			// ...and `immediate` does what it says from a tab too: canonical on
			// creation, before it has caught up to anything (story 13).
			chain2.release();
			await atTip(port2);
			const reconfigured = await port2.reconfigure({source: SOURCE_FROM_LATER_BLOCK});
			expect(reconfigured.generation.canonical).toBe(true);
			expect(reconfigured.generation.lastToBlock).toBeUndefined();
		} finally {
			host.dispose();
			port.close();
			ends.close();
			host2.dispose();
			port2.close();
			chosen.close();
		}
	});

	/**
	 * A REFUSAL KEEPS ITS TYPE, which is the difference between an app that can act
	 * on one and an app that has to read it.
	 *
	 * `GenerationCapReachedError` is the refusal a reconfigure actually meets: it
	 * says which cap, at what limit, for which generation, and WHICH GENERATIONS
	 * COULD BE DELETED to make room. A crossing that kept only the sentence would
	 * leave a tab parsing prose for the one list it needs.
	 */
	it('refuses a reconfigure the caps cannot hold, as a refusal that keeps its name and its fields', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = await hostOver(ends.host, freshName(), chain, {caps: {maxGenerations: 1, maxStreams: 1}});
		const port = connectToIndexerHost(ends.tab);

		try {
			chain.release();
			await atTip(port);

			const refused = await port.reconfigure({source: SOURCE_FROM_LATER_BLOCK}).catch((error: unknown) => error);
			const refusal = refused as Error & {cap?: string; limit?: number; candidates?: readonly GenerationId[]};

			expect(refusal).toBeInstanceOf(Error);
			expect(refusal.name).toBe('GenerationCapReachedError');
			expect(refusal.cap).toBe('maxGenerations');
			expect(refusal.limit).toBe(1);
			// Nothing may be evicted to make room -- the only generation held is the
			// canonical one -- and the refusal says so as DATA rather than in prose.
			expect(refusal.candidates).toEqual([]);
			// and the host is untouched by having refused: it still holds one
			// generation, still indexing, still answering.
			expect(await port.generations()).toHaveLength(1);
			expect((await port.progress()).indexing).toBe(true);
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * The PROCESSOR cannot cross, so neither can anything else that is code. A
	 * caller reaching for the hook's `updateIndexer` shape and passing its provider
	 * is refused NAMING THE FIELD, on this side, before anything is posted.
	 */
	it('refuses to carry anything that is code, naming where it was', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = await hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);

		try {
			const source = {...SOURCE, resolveAddress: () => '0x0'} as unknown as IndexingSource<TestABI>;
			// It REJECTS the caller's own call rather than throwing past it: a method
			// that answers a promise everywhere else must answer one here too.
			await expect(port.reconfigure({source})).rejects.toThrow(/cannot cross the indexer port/);
			// ...and the port still works, because nothing was posted.
			expect((await port.progress()).host).toBe('main-thread');
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('carries a generation report through a REAL structured clone', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = await hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);

		try {
			chain.release();
			await atTip(port);
			await port.reconfigure({source: SOURCE_FROM_LATER_BLOCK});
			const generations = await port.generations();
			// It already crossed a MessagePort to get here, which is the claim; this
			// says so a second time in one line, against the algorithm itself.
			expect(structuredClone(generations)).toEqual(generations);
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});
});
