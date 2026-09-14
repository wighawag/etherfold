import type {Abi, IndexingSource} from '@etherfold/core';
import type {StateMovedTransport} from '@etherfold/state-moved-conformance';
import {EntityEventProcessor, EntityStateView, type EntityProcessor} from '@etherfold/processor-entities';
import {openForReading, openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	createIndexerState,
	keepStreamOnIndexedDB,
	openStateMovedAcrossTabs,
} from '../../src/index.js';

/**
 * THE TWO BROWSER TRANSPORTS, AS `@etherfold/state-moved-conformance` ASKS FOR
 * THEM.
 *
 * ADR-0083 delivers ONE notification model over whichever transport a deployment
 * has, and two of the three live in this package: the **state-moved signal**
 * across a tab's PORT to its host (ADR-0082), and the same signal across the
 * CROSS-TAB channel to a tab that holds no host at all. The third is
 * `@etherfold/server`'s stream, adapted in that package against this same case
 * list -- which is the point: three adapters that each pass their own file's
 * tests can still have drifted into three semantics, and one shared list is the
 * only thing that notices.
 *
 * ## Everything here moves a REAL fold
 *
 * Nothing below posts a notification of its own. A block is APPLIED by serving
 * one more block on the fake chain and driving the container; a RETRACTION is
 * caused by serving a different branch, which is story 15 of the spec ("the
 * reorg case tested by causing a reorg rather than by asserting a message
 * shape"); a PROMOTION is a successor generation catching up under the ordinary
 * `on-catch-up` policy. What crosses the wire is whatever `@etherfold/core`
 * published, and an adapter that faked one would pass every case while
 * demonstrating nothing.
 *
 * ## Why the world is DRIVEN and never timed
 *
 * The container's own auto-index loop is never started: every case advances the
 * fold by calling `indexMore` and is answered when that call has landed. So a
 * case asserts on a SEQUENCE of notifications rather than racing a timer, and
 * `applyNextBlock` can honestly promise ONE block -- which is what makes "one
 * notification per applied block, in order, nothing coalesced" assertable at
 * all.
 *
 * ## Why the MAIN-THREAD hosting shape
 *
 * A port is a port on all three shapes: `src/host/cases.ts` is the only place a
 * case is served, and the main-thread shape reaches it over a REAL
 * `MessageChannel`, so nothing that could not cross to a worker crosses here
 * either (ADR-0082). What that shape gives the suite and the worker shapes
 * cannot is a handle on the CONTAINER, which is what a promotion needs: adding a
 * generation is not a thing a tab does across a port, because a fold is code.
 * The three shapes' agreement about the signal is `browser/hostingShapes.ts`'s
 * question, one layer down, and it is asked in a real browser.
 */

// ---------------------------------------------------------------------------
// The subject: one contract, one processor, one fake chain
// ---------------------------------------------------------------------------

const abi = [
	{
		type: 'event',
		name: 'Transfer',
		anonymous: false,
		inputs: [
			{indexed: true, name: 'from', type: 'address'},
			{indexed: true, name: 'to', type: 'address'},
			{indexed: false, name: 'id', type: 'uint256'},
		],
	},
] as const satisfies Abi;

type TestABI = typeof abi;

/** Digits only, so the decoder's EIP-55 checksum is invariant and nothing here has to spell one. */
const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const ZERO = '0x0000000000000000000000000000000000000000';
const ALICE = '0x0000000000000000000000000000000000000011';
const BOB = '0x0000000000000000000000000000000000000022';

const START_BLOCK = 100;
/** Small on purpose: every retraction these cases cause has to fall INSIDE the window. */
const FINALITY = 3;

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

/**
 * The fold, with the ONE thing the suite's coherence case needs that no shipped
 * fixture has: a row that RECORDS WHICH BLOCK an answer accounts for.
 *
 * "After a notification naming block N, a read does not answer from below N" is
 * a comparison between a number in a notification and a number in the state, so
 * the state has to carry one. `head` is that, and it is deliberately written by
 * the same handler that writes the entity rows rather than derived from a
 * cursor: what is being checked is that the ROWS a reader sees have caught up,
 * not that a cursor moved.
 */
function foldAt(version: string): EntityProcessor<TestABI> {
	return {
		version,
		entities: [
			{name: 'token', id: ['id'], fields: {owner: 'text'}},
			{name: 'head', id: ['name'], fields: {block: 'integer'}},
		],
		async onTransfer(state, event) {
			// A BURN this processor does not track: the event is decoded and handed over, and
			// this handler takes a branch that mutates nothing. That is how a block gets
			// APPLIED while touching no entity -- the ordinary shape of an empty changed-set,
			// and what `applyNextEmptyBlock` drives. A block carrying no logs at all would be
			// a different thing: no block applied, so nothing to name and nothing published.
			if (event.args.to === ZERO) return;
			state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
			state.set('head', {name: 'head'}, {block: event.blockNumber});
		},
	};
}

const ENTITIES = foldAt('1.0.0').entities;

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

const hex = (value: number) => `0x${value.toString(16)}`;
const addressTopic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

/**
 * A node serving ONE contiguous history, whose EVENT-BEARING HEIGHT and whose
 * FORK POINT the test moves.
 *
 * `forkedFrom` is the whole of the reorg: from that height up, every block
 * carries a different HASH and a different transfer, so the fold meets a
 * contradiction at a height it already holds and concludes a retraction for
 * itself. Below it, byte for byte the same chain.
 *
 * ## The TIP sits ON the last event-bearing block, and the `FINALITY` LEAD it
 * used to carry is GONE
 *
 * The lead was not a property of this world, it was a workaround. A FOLLOWER
 * asks the stored stream from `getFromBlock`, which at the tip is
 * `latestBlock - finality`: floored at 0 that landed BELOW the block the stored
 * stream OPENS at, the keeper honestly answered that it does not reach back, and
 * the follower stopped advancing for ever -- a world running level with its own
 * start block, and a defect in the engine after all
 * (`work/tasks/done/a-replay-never-asks-below-a-streams-start-block.md`).
 * The read start is floored at the source's earliest block now, so this world
 * runs without a lead, and running WITHOUT one is what keeps the fix asserted
 * from here: restore it and the promotion case stops meeting the condition at
 * all.
 *
 * What the lead was bounded by from the other side still holds and no longer
 * needs stating as a range: a REORG has to fall INSIDE the unconfirmed window,
 * and with the tip ON the block just applied it is the NEWEST block in that
 * window rather than the oldest, so it is re-scanned and re-foldable with room
 * to spare.
 */
function forkableChain() {
	let logsThrough = START_BLOCK - 1;
	let tip = START_BLOCK - 1;
	let forkedFrom = Number.POSITIVE_INFINITY;
	let logCounter = 0;
	/**
	 * Blocks whose transfer goes TO the zero address, which `foldAt`'s handler does
	 * not track. They are event-bearing and therefore APPLIED, and they touch no
	 * entity, which is the pair `applyNextEmptyBlock` needs.
	 */
	const untracked = new Set<number>();

	const logsUpTo = (): unknown[] => {
		const logs: unknown[] = [];
		for (let block = START_BLOCK; block <= logsThrough; block++) {
			const forked = block >= forkedFrom;
			logCounter++;
			logs.push({
				blockNumber: hex(block),
				blockHash: `0x${forked ? 'b' : 'a'}${block.toString(16)}`,
				transactionIndex: '0x0',
				removed: false,
				address: CONTRACT,
				// The token id is the BLOCK, so which branch a row came from is readable.
				data: `0x${(forked ? block + 1000 : block).toString(16).padStart(64, '0')}`,
				topics: [
					TRANSFER_TOPIC,
					addressTopic(untracked.has(block) ? ALICE : ZERO),
					addressTopic(untracked.has(block) ? ZERO : forked ? BOB : ALICE),
				],
				transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
				logIndex: '0x0',
				blockTimestamp: hex(1_700_000_000 + block * 12),
			});
		}
		return logs;
	};

	return {
		get tip() {
			return tip;
		},
		/** Put one more event-bearing block on the chain, and carry the tip above it. */
		advanceTo(block: number, touching: 'an entity' | 'nothing' = 'an entity') {
			if (touching === 'nothing') untracked.add(block);
			logsThrough = block;
			tip = block;
		},
		forkFrom(block: number) {
			forkedFrom = block;
		},
		provider: {
			async request(args: {method: string; params?: any}): Promise<any> {
				switch (args.method) {
					case 'eth_chainId':
						return hex(Number(SOURCE.chainId));
					case 'eth_blockNumber':
						return hex(tip);
					case 'eth_getLogs': {
						const from = parseInt(args.params[0].fromBlock.slice(2), 16);
						const to = parseInt(args.params[0].toBlock.slice(2), 16);
						return logsUpTo().filter((log) => {
							const block = parseInt((log as {blockNumber: string}).blockNumber.slice(2), 16);
							return block >= from && block <= to;
						});
					}
				}
				throw new Error(`unexpected method ${args.method}`);
			},
		} as never,
	};
}

// ---------------------------------------------------------------------------
// The world both browser transports are two ends of
// ---------------------------------------------------------------------------

let counter = 0;
const freshName = (what: string) => `state-moved-${what}-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * ONE APP, INDEXING: a container over the forkable chain, driven by hand, with a
 * port to it.
 *
 * The port is joined BEFORE `init`, which is the ordering the two worker shapes
 * get for nothing (a worker has not booted when its tab subscribes): a
 * subscriber has to be attachable before the first block is applied, or a case
 * about what a reader was told from the start could never be written.
 */
async function openWorld() {
	const chain = forkableChain();
	const databaseName = freshName('db');
	const store = await openForWriting(await createBrowserStateStore(ENTITIES, {databaseName}));
	const indexer = createIndexerState<TestABI, EntityStateView>(
		{
			createState: () => store,
			createProcessor: (state) => new EntityEventProcessor<TestABI>(state, foldAt('1.0.0')),
		},
		// A KEEPER, because a successor generation over the same stream is a FOLLOWER:
		// it re-folds the stored stream rather than fetching a history of its own, which
		// is the cheap promotion this suite's case needs (ADR-0044).
		{keepStream: keepStreamOnIndexedDB<TestABI>(freshName('stream'))},
	);
	// `watch: false` is the honest setting on this shape: a host on this thread
	// cannot die independently of the code holding the port -- they are one context.
	const port = connectToIndexerHost(indexer.mainThreadHost(), {watch: false});
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});

	/** The highest block this world has made the fold APPLY. */
	let applied = START_BLOCK - 1;

	/**
	 * Advance every generation until the fold that ANSWERS READS is level with the
	 * chain's tip.
	 *
	 * It is the CANONICAL generation's cursor that is waited on and deliberately
	 * not the chain-facing one's, because after a promotion those are two different
	 * generations: the successor FOLLOWS the stream its predecessor writes, so it
	 * reaches a block one cycle after the fetch that brought it in, and a wait on
	 * the fetcher would return before the fold a reader is told about had applied
	 * anything.
	 */
	const driveToTip = async (): Promise<void> => {
		for (let round = 0; round < 60; round++) {
			const lastSync = await indexer.indexMore();
			if (!lastSync) throw new Error(`this container was demoted to a reader, so it applies nothing`);
			if (lastSync.lastToBlock >= chain.tip) return;
		}
		throw new Error(`the fold did not reach block ${chain.tip}`);
	};

	return {
		databaseName,
		port,
		async applyNextBlock(): Promise<number> {
			applied += 1;
			chain.advanceTo(applied);
			await driveToTip();
			return applied;
		},
		async applyNextEmptyBlock(): Promise<number> {
			// An event-bearing block whose only event is a burn `foldAt` does not track, so
			// the fold APPLIES the block and mutates nothing.
			applied += 1;
			chain.advanceTo(applied, 'nothing');
			await driveToTip();
			return applied;
		},
		async retract(): Promise<number> {
			// THE BLOCK IT JUST APPLIED comes back carrying a different hash. It is inside
			// the finality window, so the fold re-scans it, meets the contradiction and
			// takes the branch back on its own; the tip does not move, because a reorg is
			// not the chain getting longer.
			chain.forkFrom(applied);
			await driveToTip();
			return applied - 1;
		},
		async promote(): Promise<void> {
			// A PROCESSOR change: the same stream, so the successor fetches nothing at all
			// and catches up by re-folding what is stored. Its own database, because a
			// second claim on one storage is a writer being refused (ADR-0075).
			const successorStore = await openForWriting(
				await createBrowserStateStore(ENTITIES, {databaseName: freshName('db')}),
			);
			const before = indexer.canonical?.record.processor;
			await indexer.addGeneration({
				createState: () => successorStore,
				createProcessor: (state) => new EntityEventProcessor<TestABI>(state, foldAt('2.0.0')),
			});
			// The pointer moves under the ordinary default (`on-catch-up`) once the
			// successor reaches the cursor the canonical generation has -- nothing here
			// asks for it, which is what makes this the promotion an app actually meets.
			for (let round = 0; round < 40; round++) {
				if (indexer.canonical?.record.processor !== before) return;
				await indexer.indexMore();
			}
			throw new Error(`the successor generation never became canonical`);
		},
		close(): void {
			port.close();
			indexer.dispose();
		},
	};
}

/** The highest block a set of rows accounts for, as the fold recorded it. */
function headBlockOf(row: unknown): number | undefined {
	return (row as {block?: number} | undefined)?.block;
}

// ---------------------------------------------------------------------------
// The two adapters
// ---------------------------------------------------------------------------

/**
 * TRANSPORT ONE: the signal across a tab's PORT to the host that is folding
 * (ADR-0082's push, ADR-0083's payload).
 *
 * Its reader has the richest surface of the three -- the port proxies the
 * store's four reads -- so this is the transport the coherence case is sharpest
 * on: the same object that was TOLD about block N is the object a read goes
 * through.
 */
export async function openPortTransport(): Promise<StateMovedTransport> {
	const world = await openWorld();
	return {
		onStateMoved: (handler) => world.port.onStateMoved(handler),
		applyNextBlock: () => world.applyNextBlock(),
		applyNextEmptyBlock: () => world.applyNextEmptyBlock(),
		retract: () => world.retract(),
		promote: () => world.promote(),
		async readsUpTo() {
			return headBlockOf(await world.port.reads.getCurrent('head', {name: 'head'}));
		},
		async close() {
			world.close();
		},
	};
}

/**
 * TRANSPORT TWO: the signal across the CROSS-TAB channel, to a tab that holds no
 * host and no fold.
 *
 * The wiring is the one an app copies: the tab that HAS a port forwards what it
 * is told (`indexer.onStateMoved(tabs.publish)`), and every other tab listens.
 * A tab never hears its own publication, which is why there are two channel
 * objects here rather than one.
 *
 * Its reader reads the SAME STORAGE the fold writes into, opened for READING --
 * which is the whole shape of a reader tab, and is why the channel is named from
 * the storage identity and nothing else.
 */
export async function openCrossTabTransport(): Promise<StateMovedTransport> {
	const world = await openWorld();
	const indexingTab = openStateMovedAcrossTabs({databaseName: world.databaseName});
	const readerTab = openStateMovedAcrossTabs({databaseName: world.databaseName});
	const forwarding = world.port.onStateMoved(indexingTab.publish);

	return {
		onStateMoved: (handler) => readerTab.onStateMoved(handler),
		applyNextBlock: () => world.applyNextBlock(),
		applyNextEmptyBlock: () => world.applyNextEmptyBlock(),
		retract: () => world.retract(),
		promote: () => world.promote(),
		async readsUpTo() {
			// A READER TAB'S OWN HANDLE: the same database, narrowed to the reads, which
			// is what a tab that only renders holds (ADR-0077).
			const reads = new EntityStateView(
				openForReading(await createBrowserStateStore(ENTITIES, {databaseName: world.databaseName})),
			);
			return headBlockOf(await reads.getCurrent('head', {name: 'head'}));
		},
		async close() {
			forwarding();
			readerTab.close();
			indexingTab.close();
			world.close();
		},
	};
}
