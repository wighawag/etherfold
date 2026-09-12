import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, EntityStateView} from '@etherfold/processor-entities';
import {
	openMemoryGenerationRegistry,
	type IndexingSource,
	type PromotionConfig,
	type TxInclusionVerdict,
} from '@etherfold/core';
import {openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	serveIndexerHost,
	type HostAccess,
	type IndexerHost,
	type IndexerPort,
} from '../src/index.js';
import {wire} from './utils/port.js';
import {
	BRANCH_A_TIP,
	FINALITY,
	fakeChain,
	processor,
	SOURCE,
	SOURCE_FROM_LATER_BLOCK,
	txInBlock,
	type TestABI,
} from '../browser/workload.js';

/**
 * `checkTxInclusion` ASKED FROM A TAB -- over a real `MessagePort`, in node.
 *
 * What runs in a REAL browser with a REAL dedicated worker is the
 * `tx-inclusion-from-the-tab` case of `browser/txInclusionFromTheTab.spec.ts`.
 * These are the same claims on every commit, because that run needs browser
 * binaries a clean checkout does not have.
 *
 * The ORACLE is `@etherfold/core`'s `test/txInclusion.test.ts` (the rule) and
 * this package's `test/txInclusion.test.ts` (the same-thread wiring). Nothing
 * about the verdict changes here: it is still answered from
 * `LastSync.unconfirmedBlocks` and nothing else stored, a window hit must still
 * be behind `lastToBlock`, and the receipt's block HASH is still never compared.
 * What this file adds is that a tab holding only a port gets the SAME verdict,
 * with its status AND its basis intact -- including the two distinct causes of
 * `unknown`, which an app renders differently from an honest `absent`.
 *
 * ## The fixture, and why its numbers are the ones worth asking about
 *
 * `FINALITY` is 3 and the tip is 105, so the unconfirmed window's floor is 102:
 * block 104's transaction is IN the window and block 100's has fallen out of it.
 * That gives the two halves of the `minedAtBlock` story in one fixture -- the
 * same transaction is `absent`/`window-miss` asked bare and
 * `included`/`below-window` asked with the block a receipt would name.
 *
 * ## Nothing here waits on a clock
 *
 * The chain is GATED, so a case decides when the host may make progress, and
 * every wait is for a VALUE (a cursor, a verdict, a pointer that moved) rather
 * than for a duration.
 */

let counter = 0;
const freshName = () => `tx-inclusion-tab-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** Block 104's transaction: inside the unconfirmed window at this fixture's tip. */
const IN_WINDOW = txInBlock(104);
/** Block 100's transaction: folded, and BELOW the window at this fixture's tip. */
const BELOW_WINDOW = txInBlock(100);
/** A transaction this chain never carried. */
const NEVER_SEEN = '0x00000000000000000000000000000000000000000000000000000000000000bb';

/**
 * The captured stream behind two gates: one that holds EVERYTHING, and one that
 * holds the fetches that would take the fold ABOVE a block (or, once
 * `holdFetches` is called, every fetch from that moment on).
 *
 * The second gate is what makes "before and after the fold advances past the
 * transaction" a deterministic pair rather than a race: the fold lands on a
 * cursor a case chose, is asked there, and is released.
 */
function heldChain(options: {tip?: number; holdFetchesAbove?: number} = {}) {
	const chain = fakeChain(undefined, options.tip ?? BRANCH_A_TIP);
	const underlying = chain.provider.request.bind(chain.provider);
	let openChain!: () => void;
	const chainGate = new Promise<void>((resolve) => (openChain = resolve));
	let openFetches!: () => void;
	const fetchGate = new Promise<void>((resolve) => (openFetches = resolve));
	let holdingEveryFetch = false;
	return {
		ranges: chain.ranges,
		/** Let the host talk to the chain at all. */
		release: () => openChain(),
		/** From now on, hold EVERY fetch: the fold stops where it is. */
		holdFetches: () => (holdingEveryFetch = true),
		/** Let the fold go on. */
		releaseFetches: () => openFetches(),
		provider: {
			async request(args: {method: string; params?: unknown}): Promise<unknown> {
				await chainGate;
				if (args.method === 'eth_getLogs') {
					const asked = args.params as [{toBlock: string}];
					const to = parseInt(asked[0].toBlock.slice(2), 16);
					if (holdingEveryFetch || (options.holdFetchesAbove !== undefined && to > options.holdFetchesAbove)) {
						await fetchGate;
					}
				}
				return underlying(args as never);
			},
		} as never,
	};
}

type Chain = ReturnType<typeof heldChain>;

function hostOver(
	access: HostAccess,
	databaseName: string,
	chain: Chain,
	options: {promotion?: PromotionConfig; fetchWidth?: number} = {},
): Promise<IndexerHost> {
	return openMemoryGenerationRegistry({maxGenerations: 4, maxStreams: 4}).then((registry) =>
		serveIndexerHost<TestABI, EntityStateView>(
			{
				registry,
				createState: async (context) =>
					openForWriting(
						await createBrowserStateStore(processor.entities, {databaseName: `${databaseName}-${context.stream}`}),
					),
				createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
				provider: chain.provider,
				source: SOURCE as IndexingSource<TestABI>,
				config: {
					stream: {finality: FINALITY},
					...(options.fetchWidth
						? {fetch: {numBlocksToFetchAtStart: options.fetchWidth, maxBlocksPerFetch: options.fetchWidth}}
						: {}),
				},
				...(options.promotion ? {promotion: options.promotion} : {}),
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
 * container that has loaded and not yet fetched publishes `0` of `0`.
 */
const atTip = (port: IndexerPort) =>
	until(port, (progress) => progress.latestBlock === BRANCH_A_TIP && progress.lastToBlock === progress.latestBlock);

/** Ask until the verdict for one hash says what a case is waiting for. */
async function untilVerdict(
	port: IndexerPort,
	txHash: string,
	matches: (verdict: TxInclusionVerdict) => boolean,
	attempts = 400,
): Promise<TxInclusionVerdict> {
	let verdict = (await port.checkTxInclusion([{txHash}]))[txHash];
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (matches(verdict)) return verdict;
		await new Promise((resolve) => setTimeout(resolve, 10));
		verdict = (await port.checkTxInclusion([{txHash}]))[txHash];
	}
	throw new Error(`the verdict never got there: ${JSON.stringify(verdict)}`);
}

describe('a tab asking whether the state already accounts for its transactions', () => {
	/**
	 * THE VERDICT, WHOLE: status and basis, for a folded transaction, an unseen
	 * one, and one closed by the block a receipt names -- all in ONE call, because
	 * an app with a pending queue asks about the queue and not about one
	 * transaction at a time.
	 */
	it('answers a whole pending set in one round trip, keeping each verdict whole', async () => {
		const ends = wire();
		const chain = heldChain();
		const host = await hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);

		try {
			chain.release();
			await atTip(port);

			const verdicts = await port.checkTxInclusion([{txHash: IN_WINDOW}, {txHash: NEVER_SEEN}, {txHash: BELOW_WINDOW}]);

			// A VERDICT PER HASH, keyed exactly as it was asked for.
			expect(Object.keys(verdicts).sort()).toEqual([IN_WINDOW, NEVER_SEEN, BELOW_WINDOW].sort());

			// The load-bearing one: the transaction's own events are in the window AND
			// the cursor has passed them. It carries the block IN THE INDEXER'S view,
			// which is the whole point -- it is not whatever block the app's own node
			// reported.
			expect(verdicts[IN_WINDOW]).toEqual({
				status: 'included',
				basis: 'window-hit',
				blockNumber: 104,
				blockHash: '0xa104',
			});
			// `absent` means "not in the window", and it says so in its basis rather
			// than arriving as a bare `false`.
			expect(verdicts[NEVER_SEEN]).toEqual({status: 'absent', basis: 'window-miss'});
			// The window is SPARSE and bounded by finality, so a transaction the fold
			// certainly applied reads `absent` once it has fallen out of it. That is the
			// limit `minedAtBlock` exists to close, below.
			expect(verdicts[BELOW_WINDOW]).toEqual({status: 'absent', basis: 'window-miss'});
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * `minedAtBlock` CROSSES, PER QUERY, and reaches the `below-window` branch.
	 *
	 * A tab is exactly the place a caller holds a receipt, so dropping the argument
	 * at the boundary would remove the one affordance that makes the verdict
	 * trustworthy there: the same transaction, asked bare, is `absent`.
	 */
	it('takes minedAtBlock per query and concludes below-window from it', async () => {
		const ends = wire();
		const chain = heldChain();
		const host = await hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);

		try {
			chain.release();
			await atTip(port);

			const verdicts = await port.checkTxInclusion([
				{txHash: BELOW_WINDOW, minedAtBlock: 100},
				// ...and it is PER QUERY: the same call carries one that has none.
				{txHash: NEVER_SEEN},
			]);

			// Deep enough that the caller's node and the indexer's node are assumed to
			// agree, and the cursor is past it. No block HASH was compared to get here.
			expect(verdicts[BELOW_WINDOW]).toEqual({status: 'included', basis: 'below-window'});
			expect(verdicts[NEVER_SEEN]).toEqual({status: 'absent', basis: 'window-miss'});

			// A receipt for a block the fold has NOT reached is not an inclusion: the
			// answer is about the indexer's own chain, and it has not got there.
			const ahead = await port.checkTxInclusion([{txHash: NEVER_SEEN, minedAtBlock: BRANCH_A_TIP + 10}]);
			expect(ahead[NEVER_SEEN]).toEqual({status: 'absent', basis: 'ahead-of-cursor'});
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * A SNAPSHOT AND NOT A CACHE: the same question, asked twice across one port,
	 * answers from where the fold is at the moment of the call.
	 *
	 * This is the optimistic-update loop itself. The fold is held below block 104,
	 * so the transaction an app is watching is `absent` and the app keeps its
	 * overlay; the fold is released, and the same call says `included`, which is
	 * when the overlay must go.
	 */
	it('answers from the fold as it is NOW, before and after it advances past the transaction', async () => {
		const ends = wire();
		const chain = heldChain({holdFetchesAbove: 103});
		const host = await hostOver(ends.host, freshName(), chain, {fetchWidth: 4});
		const port = connectToIndexerHost(ends.tab);

		try {
			chain.release();
			// The fold has landed on block 103 and cannot go higher until this case
			// says so: block 104's transaction has not been folded.
			await until(port, (progress) => progress.lastToBlock === 103);

			expect((await port.checkTxInclusion([{txHash: IN_WINDOW}]))[IN_WINDOW]).toEqual({
				status: 'absent',
				basis: 'window-miss',
			});

			chain.releaseFetches();
			await atTip(port);

			// The SAME call, and a different answer: nothing was re-connected and
			// nothing was re-subscribed.
			expect((await port.checkTxInclusion([{txHash: IN_WINDOW}]))[IN_WINDOW]).toEqual({
				status: 'included',
				basis: 'window-hit',
				blockNumber: 104,
				blockHash: '0xa104',
			});
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * THE TWO CAUSES OF `unknown`, TOLD APART ACROSS THE BOUNDARY.
	 *
	 * Both are honest answers and an app renders them differently from `absent`:
	 * nothing has been indexed yet, and the fold is so far behind the tip that its
	 * window says nothing about the region asked about. Collapsing either into
	 * `absent` is what makes an app drop an overlay it should have kept.
	 */
	it('says nothing is synced yet rather than refusing, before the host has a cursor', async () => {
		const ends = wire();
		// Nothing is released, so the container never opens: the host is WAITING on a
		// provider and holds no generation.
		const chain = heldChain();
		const host = await hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);

		try {
			expect((await port.progress()).phase).toBe('waiting');
			const verdicts = await port.checkTxInclusion([{txHash: IN_WINDOW}, {txHash: NEVER_SEEN}]);
			expect(verdicts[IN_WINDOW]).toEqual({status: 'unknown', basis: 'not-synced'});
			expect(verdicts[NEVER_SEEN]).toEqual({status: 'unknown', basis: 'not-synced'});
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('says its window covers nothing while it is far behind the tip', async () => {
		const ends = wire();
		// A tip 100,000 blocks above what the fold has reached: the unconfirmed window
		// describes the tip, the cursor is nowhere near it, and nothing in between is
		// known either way.
		const chain = heldChain({tip: 100_000, holdFetchesAbove: 103});
		const host = await hostOver(ends.host, freshName(), chain, {fetchWidth: 4});
		const port = connectToIndexerHost(ends.tab);

		try {
			chain.release();
			await until(port, (progress) => progress.lastToBlock === 103 && progress.latestBlock === 100_000);

			const verdicts = await port.checkTxInclusion([{txHash: IN_WINDOW}, {txHash: BELOW_WINDOW}]);
			// UNKNOWN and not ABSENT: the fold has genuinely passed block 100, but its
			// window says nothing about it, and an app that dropped an overlay here
			// would drop it on no evidence.
			expect(verdicts[IN_WINDOW]).toEqual({status: 'unknown', basis: 'window-not-covering'});
			expect(verdicts[BELOW_WINDOW]).toEqual({status: 'unknown', basis: 'window-not-covering'});

			// ...and the caller holding a RECEIPT still gets a conclusion, which is the
			// second limit `minedAtBlock` closes.
			const withReceipt = await port.checkTxInclusion([{txHash: BELOW_WINDOW, minedAtBlock: 100}]);
			expect(withReceipt[BELOW_WINDOW]).toEqual({status: 'included', basis: 'below-window'});
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * A PROMOTION STOPS THE ANSWER COMING FROM THE RETIRED WINDOW, across the port
	 * as it does in process.
	 *
	 * The window belongs to the generation that ANSWERS READS, and `immediate`
	 * makes a generation canonical BEFORE it has folded anything. The container
	 * drops the retired cursor at the pointer move (`onPromoted`) and the host
	 * reports from what the new one publishes, so a tab is never answered from a
	 * window nothing is maintaining any more.
	 *
	 * The assertion is that `included` GOES, and not which honest answer replaces
	 * it: whether the successor has published a cursor of its own by then is the
	 * container's own timing, and `@etherfold/core`'s `test/promotion.test.ts` is
	 * the oracle for which basis each of those states produces.
	 */
	it('stops answering from the window of a generation the pointer has moved off', async () => {
		const ends = wire();
		const chain = heldChain();
		const host = await hostOver(ends.host, freshName(), chain, {promotion: {policy: 'immediate'}});
		const port = connectToIndexerHost(ends.tab);

		try {
			chain.release();
			await atTip(port);
			expect((await port.checkTxInclusion([{txHash: IN_WINDOW}]))[IN_WINDOW].status).toBe('included');

			// The successor can fold NOTHING while this holds, so any `included` after
			// the pointer moves could only have come from the generation it moved off.
			chain.holdFetches();
			const reconfigured = await port.reconfigure({source: SOURCE_FROM_LATER_BLOCK});
			// Canonical on creation, before it has caught up to anything.
			expect(reconfigured.generation.canonical).toBe(true);

			const degraded = (await port.checkTxInclusion([{txHash: IN_WINDOW}]))[IN_WINDOW];
			expect(degraded.status).not.toBe('included');
			expect(['not-synced', 'window-miss', 'window-not-covering']).toContain(degraded.basis);

			// ...and it comes back once the generation that now answers has folded the
			// transaction into a window of its OWN.
			chain.releaseFetches();
			const caughtUp = await untilVerdict(port, IN_WINDOW, (verdict) => verdict.status === 'included');
			expect(caughtUp.basis).toBe('window-hit');
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('carries a verdict through a REAL structured clone', async () => {
		const ends = wire();
		const chain = heldChain();
		const host = await hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);

		try {
			chain.release();
			await atTip(port);
			const verdicts = await port.checkTxInclusion([{txHash: IN_WINDOW}, {txHash: NEVER_SEEN}]);
			// It already crossed a MessagePort to get here, which is the claim; this
			// says so a second time in one line, against the algorithm itself.
			expect(structuredClone(verdicts)).toEqual(verdicts);
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});
});
