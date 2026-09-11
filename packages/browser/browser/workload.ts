import type {
	Abi,
	IndexingSource,
	LastSync,
	RangedAbi,
	StoredLastSync,
	StoredLogEvent,
	StreamRead,
} from '@etherfold/core';
import {EntityEventProcessor, type EntityProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {openForWriting, type StateStore, type WritableStateStore} from '@etherfold/state-store';
import {VERSIONS} from '@etherfold/state-store-indexeddb';
import {createBrowserStateStore, type BrowserStateStoreConfig, createIndexerState} from '../src/index.js';

/**
 * The subject both runners drive: one entity processor, one captured stream, one
 * hook.
 *
 * It lives here rather than in `test/` for the same reason
 * `@etherfold/state-store-indexeddb` puts its workload beside its Playwright
 * specs: the browser specs bundle THIS module into a real page, and the node
 * tests import the very same object. An equality between the two runtimes is
 * only worth something if neither side got its own copy of the processor, its
 * own copy of the chain, or its own copy of the expected answer.
 *
 * The processor mirrors the fixture every other reorg test in this repository
 * quotes (`@etherfold/processor-sqlite`'s `reorg.test.ts`): a `token` owner per
 * id, and a `counter` row
 * counting transfers. The counter is not decoration -- it is the value that must
 * come DOWN when a block is reorged out, which is the canonical bug the whole
 * storage seam exists to make impossible.
 */

export const abi = [
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

export type TestABI = typeof abi;

/**
 * The processor an application author writes: declarations and handlers, naming
 * no backend.
 *
 * Every store below runs THIS object. Nothing in it says IndexedDB, patches or
 * SQLite, which is the claim the tests around it are checking.
 */
export const processor: EntityProcessor<TestABI> = {
	version: '1.0.0',
	entities: [
		{name: 'token', id: ['id'], fields: {owner: 'text'}},
		{name: 'counter', id: ['name'], fields: {value: 'integer'}},
	],
	async onTransfer(state, event) {
		state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
};

/**
 * The same processor with its LOGIC changed, and its `version` under the
 * caller's control.
 *
 * This is the hot-reload subject: what Vite hands a running tab after the
 * developer edited a reducer is a new module whose handlers behave differently.
 * `countBy` is that edit, made observable -- the counter is the one value in
 * this fixture whose number is decided purely by handler code, so a run under
 * the edited logic is distinguishable from a run under the old logic by reading
 * it, with no instrumentation.
 *
 * `version` is separate because it is the thing the author must remember to
 * change and the thing the core actually compares. Holding them apart is what
 * lets a test drive the two combinations that matter: edited logic with a bumped
 * version, and edited logic WITHOUT one.
 */
export function processorVariant(options: {version?: string; countBy?: number} = {}): EntityProcessor<TestABI> {
	const countBy = options.countBy ?? 1;
	return {
		version: options.version ?? '1.0.0',
		entities: [
			{name: 'token', id: ['id'], fields: {owner: 'text'}},
			{name: 'counter', id: ['name'], fields: {value: 'integer'}},
		],
		async onTransfer(state, event) {
			state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
			const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
			state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + countBy});
		},
	};
}

/**
 * Digits-only addresses, deliberately.
 *
 * The decoder hands a handler an EIP-55 checksummed address, so an address with
 * hex letters in it would be stored in a casing no assertion here could quote
 * without also encoding viem's checksum. An address with no letters is
 * checksum-invariant.
 */
const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
export const ALICE = '0x0000000000000000000000000000000000000011';
export const BOB = '0x0000000000000000000000000000000000000022';
export const CAROL = '0x0000000000000000000000000000000000000033';
export const DAN = '0x0000000000000000000000000000000000000044';
export const ERIN = '0x0000000000000000000000000000000000000055';
const ZERO = '0x0000000000000000000000000000000000000000';

export const START_BLOCK = 100;

export const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

/**
 * The SAME contract address, with the ABI a redeployed implementation generates.
 *
 * This is the second reload axis, in the shape these apps actually deploy in.
 * A local redeploy goes through a PROXY, so the address does not move: what
 * moves is the implementation behind it and therefore the generated ABI. The
 * added event stands for that regeneration -- an upgraded implementation that
 * emits something the old one did not is the ordinary case, and it is the one
 * that changes the ABI without changing anything the indexer can see about the
 * blocks it has already indexed.
 */
export const abiV2 = [
	...abi,
	{
		type: 'event',
		name: 'Approval',
		anonymous: false,
		inputs: [
			{indexed: true, name: 'owner', type: 'address'},
			{indexed: true, name: 'approved', type: 'address'},
			{indexed: true, name: 'id', type: 'uint256'},
		],
	},
] as const satisfies Abi;

/** The redeployed implementation, at the address the proxy keeps constant. */
export const SOURCE_V2: IndexingSource<typeof abiV2> = {
	chainId: '1',
	contracts: [{abi: abiV2, address: CONTRACT, startBlock: START_BLOCK}],
};

/**
 * THE SAME CONTRACT, INDEXED FROM A LATER BLOCK: a reconfigure whose answers are
 * visibly different.
 *
 * `startBlock` is hashed into the block-0 skeleton entry, so this is a different
 * SOURCE, a different fetch filter and therefore a different STREAM: a
 * generation folding it fetches its own logs rather than following the one
 * already held. That is the expensive half of a reconfigure, which is what makes
 * it the honest subject for one.
 *
 * What it is for is the question "which generation answered this read". Block
 * 100's two transfers are below it and 102's and 104's three are not, so the
 * counter reads 3 here against `EXPECTED_A`'s 5 -- one number, decided purely by
 * which fold answered, with no instrumentation.
 */
export const RECONFIGURED_FROM_BLOCK = 102;
export const SOURCE_FROM_LATER_BLOCK: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: RECONFIGURED_FROM_BLOCK}],
};

/**
 * The SAME events, plus the members a REGENERATION routinely adds.
 *
 * A view function, an error and a constructor: none of them is indexed, none
 * enters the fetch filter, and none can change what a log decodes to. This is
 * the ordinary shape of an ABI diff, and it is the one that used to cost a
 * complete re-fetch of all history.
 */
export const abiWithNonEventMembers = [
	...abi,
	{
		type: 'function',
		name: 'balanceOf',
		stateMutability: 'view',
		inputs: [{name: 'owner', type: 'address'}],
		outputs: [{name: '', type: 'uint256'}],
	},
	{type: 'error', name: 'NotOwner', inputs: [{name: 'caller', type: 'address'}]},
	{type: 'constructor', stateMutability: 'nonpayable', inputs: [{name: 'admin', type: 'address'}]},
] as const satisfies Abi;

/** The regenerated ABI at the address the proxy keeps constant. */
export const SOURCE_WITH_NON_EVENT_MEMBERS: IndexingSource<typeof abiWithNonEventMembers> = {
	chainId: '1',
	contracts: [{abi: abiWithNonEventMembers, address: CONTRACT, startBlock: START_BLOCK}],
};

/**
 * The same event with a NON-INDEXED parameter renamed, which is the case that
 * splits the two verdicts.
 *
 * `topic0` is the hash of the canonical signature, and that hashes TYPES and not
 * names -- so `Transfer(address,address,uint256)` is the same topic before and
 * after, every cached log is still exactly the right log, and the FETCH has
 * nothing to redo. What did move is the DECODE: `args.id` is now `args.tokenId`,
 * so a fold computed under the old names is stale and the stream has to be
 * decoded again on its way back through.
 */
export const abiRenamedParameter = [
	{
		type: 'event',
		name: 'Transfer',
		anonymous: false,
		inputs: [
			{indexed: true, name: 'from', type: 'address'},
			{indexed: true, name: 'to', type: 'address'},
			{indexed: false, name: 'tokenId', type: 'uint256'},
		],
	},
] as const satisfies Abi;

export const SOURCE_RENAMED_PARAMETER: IndexingSource<typeof abiRenamedParameter> = {
	chainId: '1',
	contracts: [{abi: abiRenamedParameter, address: CONTRACT, startBlock: START_BLOCK}],
};

/**
 * A DIFFERENT source object carrying the SAME ABI, address and start block.
 *
 * The case a redeploy produces when the implementation changed but its events
 * did not: the module is new, the object is new, and every byte the indexer
 * hashes is the same. Kept as its own export because the interesting assertion
 * is that this is indistinguishable from no change at all.
 */
export const SOURCE_REDEPLOYED_SAME_ABI: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi: [...abi] as unknown as TestABI, address: CONTRACT, startBlock: START_BLOCK}],
};

// ---------------------------------------------------------------------------
// The same deployment, with the block ranges its events are live over DECLARED.
// ---------------------------------------------------------------------------
// An upgrade APPENDS an entry here rather than moving one whole-source hash, so
// the interesting question stops being "did the state survive" and becomes "was
// anything re-fetched". Only the ranges the fake chain was asked for can answer
// that: a re-index and a resume land on identical rows.

/** The event that already exists, saying out loud that it is live from the start block. */
const transferFrom = (firstBlock: number, lastBlock?: number) =>
	({...abi[0], firstBlock, ...(lastBlock === undefined ? {} : {lastBlock})}) as const;

/** The event an upgraded implementation added, which could not have fired before it existed. */
const approvalFrom = (firstBlock: number) => ({...abiV2[1], firstBlock}) as const;

function rangedSource(abi: RangedAbi): IndexingSource<TestABI> {
	return {chainId: '1', contracts: [{abi: abi as unknown as TestABI, address: CONTRACT, startBlock: START_BLOCK}]};
}

/** The baseline: one event, one declared range, open-ended. */
export const SOURCE_RANGED = rangedSource([transferFrom(START_BLOCK)]);

/** The upgrade: a second event appended, live only from a block ABOVE the cursor. */
export const APPENDED_ABOVE_BLOCK = 200;
export const SOURCE_RANGED_APPENDED_ABOVE = rangedSource([
	transferFrom(START_BLOCK),
	approvalFrom(APPENDED_ABOVE_BLOCK),
]);

/** The same append, declared from a block the indexer has already been past. */
export const APPENDED_BELOW_BLOCK = 102;
export const SOURCE_RANGED_APPENDED_BELOW = rangedSource([
	transferFrom(START_BLOCK),
	approvalFrom(APPENDED_BELOW_BLOCK),
]);

/**
 * `[A@a, B@b, A@c]`: what a generator that cannot recognise a ROLLBACK appends.
 *
 * It saw a proxy upgrade and appended `Approval`, then saw another and appended
 * `Transfer` again. The third entry says nothing the first does not, and the
 * normalised coverage is byte-identical, so it must cost nothing.
 */
export const SOURCE_RANGED_WITH_REDUNDANT_APPEND = rangedSource([
	transferFrom(START_BLOCK),
	approvalFrom(APPENDED_ABOVE_BLOCK),
	transferFrom(300),
]);

/** An EDIT to the entry that is already below the cursor: the list length does not move. */
export const SOURCE_RANGED_EDITED_BELOW = rangedSource([transferFrom(START_BLOCK, 104)]);

/** Small on purpose: the reorg below has to fall INSIDE the unconfirmed window. */
export const FINALITY = 3;

/** `Transfer(address,address,uint256)`, which is what this ABI's event hashes to. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

/** The raw shape a node returns, which is what a captured stream is captured AS. */
export type RawLog = {
	blockNumber: string;
	blockHash: string;
	transactionIndex: string;
	removed: boolean;
	address: string;
	data: string;
	topics: string[];
	transactionHash: string;
	logIndex: string;
	blockTimestamp: string;
};

function hex(value: number): string {
	return `0x${value.toString(16)}`;
}

function addressTopic(address: string): string {
	return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

/** Deterministic and monotonic, so the recorded time axis is assertable. */
export function timestampOf(blockNumber: number): number {
	return 1_700_000_000 + blockNumber * 12;
}

let logCounter = 0;

function transferLog(
	blockNumber: number,
	blockHash: string,
	args: {from: string; to: string; id: bigint},
	logIndex = 0,
): RawLog {
	logCounter++;
	return {
		blockNumber: hex(blockNumber),
		blockHash,
		transactionIndex: '0x0',
		removed: false,
		address: CONTRACT,
		data: `0x${args.id.toString(16).padStart(64, '0')}`,
		topics: [TRANSFER_TOPIC, addressTopic(args.from), addressTopic(args.to)],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: hex(logIndex),
		blockTimestamp: hex(timestampOf(blockNumber)),
	};
}

/**
 * The captured stream: blocks 100, 102 and 104 carry logs, the tip is 105.
 *
 * Fixed bytes rather than a live chain, so that a run in node and a run in
 * Chromium are comparable at all. Block 100 is outside the finality window at
 * that tip, so it is CONFIRMED by the time the reorg lands and cannot be part of
 * what is retracted.
 */
export const BRANCH_A: readonly RawLog[] = [
	transferLog(100, '0xa100', {from: ZERO, to: ALICE, id: 1n}, 0),
	transferLog(100, '0xa100', {from: ZERO, to: BOB, id: 2n}, 1),
	transferLog(102, '0xa102', {from: ALICE, to: BOB, id: 1n}),
	transferLog(104, '0xa104', {from: ZERO, to: DAN, id: 3n}, 0),
	transferLog(104, '0xa104', {from: BOB, to: ERIN, id: 2n}, 1),
];
export const BRANCH_A_TIP = 105;

/**
 * Branch A with one more block on top: no reorg, just the chain moving on.
 *
 * The reconfigure tests need events that arrive AFTER a swap, because "did the
 * new logic take effect" is a question about what happens to the next event and
 * not only about what happened to the stored rows. Block 106 is that next event.
 */
export const BRANCH_A_EXTENDED: readonly RawLog[] = [
	...BRANCH_A,
	transferLog(106, '0xa106', {from: ERIN, to: CAROL, id: 2n}),
];
export const BRANCH_A_EXTENDED_TIP = 107;

/**
 * Branch A, and then a long QUIET stretch with one event at the end of it.
 *
 * The gap is the whole point, and it is what a retention window is actually
 * measured against: event-bearing blocks on the real stream are median 429
 * blocks apart (ADR-0019), so a window that sounds generous holds one or two of
 * them. Here the tip a floor is measured back from is block 200 while everything
 * else this fixture holds was written at 100 to 104 -- which puts a 64-block
 * window's floor ABOVE every version that was ever CLOSED and below several that
 * are still LIVE. A prune that reads its floor as "delete what is old" destroys
 * the state; one that reads it as "delete what no legal read can reach" reclaims
 * four versions and answers exactly as an unbounded store does.
 */
export const BRANCH_A_LATER: readonly RawLog[] = [
	...BRANCH_A,
	transferLog(200, '0xa200', {from: DAN, to: ALICE, id: 3n}),
];
export const BRANCH_A_LATER_TIP = 201;

/**
 * The same chain after a reorg at 104: same 100 and 102, a DIFFERENT 104.
 *
 * The replacement carries FEWER events than what it replaces, which is the case
 * that matters: the counter must come DOWN (5 -> 4), token 3 must vanish
 * entirely, and token 2 -- which the replacement never mentions -- must go back
 * to the owner block 100 gave it.
 */
export const BRANCH_B: readonly RawLog[] = [
	BRANCH_A[0],
	BRANCH_A[1],
	BRANCH_A[2],
	transferLog(104, '0xb104', {from: ZERO, to: CAROL, id: 4n}),
];
export const BRANCH_B_TIP = 106;

/** The state branch A produces, as the assertions quote it. */
export const EXPECTED_A = {
	owners: {'1': BOB, '2': ERIN, '3': DAN, '4': undefined},
	transfers: 5,
};

/** The state branch B produces, once the reorg has been reverted and replaced. */
export const EXPECTED_B = {
	owners: {'1': BOB, '2': BOB, '3': undefined, '4': CAROL},
	transfers: 4,
};

/**
 * The state a fold of branch A that STARTED AT `RECONFIGURED_FROM_BLOCK`
 * produces.
 *
 * Block 100's two transfers are below that start block, so they were never
 * fetched: the counter is 3 where `EXPECTED_A` is 5, and token 1's first owner
 * is the one block 102 gave it. Everything else agrees, which is what makes the
 * counter the field that says which generation answered.
 */
export const EXPECTED_A_FROM_LATER_BLOCK = {
	owners: {'1': BOB, '2': ERIN, '3': DAN, '4': undefined},
	transfers: 3,
};

/** The state `BRANCH_A_LATER` produces: branch A, plus the one late transfer. */
export const EXPECTED_A_LATER = {
	owners: {'1': BOB, '2': ERIN, '3': ALICE, '4': undefined},
	transfers: 6,
};

/** One `eth_getLogs` call, as the fake chain saw it. */
export type FetchedRange = {from: number; to: number};

/**
 * A node that serves ONE branch at a time and records what it was asked for.
 *
 * The recording is the point on the resume path: "did this tab re-index from the
 * start block" is a question about the RANGES a reload asks for, and nothing in
 * the resulting state can answer it (re-indexing lands on the same rows).
 */
export function fakeChain(branch: readonly RawLog[] = BRANCH_A, latestBlock: number = BRANCH_A_TIP) {
	const ranges: FetchedRange[] = [];
	let served: readonly RawLog[] = branch;
	let tip = latestBlock;
	return {
		ranges,
		serve(logs: readonly RawLog[], newTip: number) {
			served = logs;
			tip = newTip;
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
						ranges.push({from, to});
						return served.filter((log) => {
							const blockNumber = parseInt(log.blockNumber.slice(2), 16);
							return blockNumber >= from && blockNumber <= to;
						});
					}
				}
				throw new Error(`unexpected method ${args.method}`);
			},
		} as any,
	};
}

/**
 * HOW MANY VERSIONS the database is physically holding, counted from a second
 * connection.
 *
 * The honest measure of a prune, and the one the assertions are written against:
 * a version count is a fact about what is STORED, where "the retention says N"
 * is a statement the store issues and `navigator.storage.estimate()` is
 * quantised, lags, and once reported MORE space used after a prune that dropped
 * nothing (`work/notes/findings/sqlite-in-the-browser.md`).
 *
 * It reaches past the seam on purpose. `StateStore` has no verb for this and
 * should not grow one -- a host has no business counting rows -- so the count is
 * read the way an operator would read it, from the object store the backend
 * documents, through the same engine the run used.
 */
export async function versionCount(databaseName: string): Promise<number> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const open = indexedDB.open(databaseName);
		open.onsuccess = () => resolve(open.result);
		open.onerror = () => reject(open.error);
	});
	try {
		return await new Promise<number>((resolve, reject) => {
			const counted = database.transaction(VERSIONS, 'readonly').objectStore(VERSIONS).count();
			counted.onsuccess = () => resolve(counted.result);
			counted.onerror = () => reject(counted.error);
		});
	} finally {
		database.close();
	}
}

/** The state as the assertions quote it, read back through the seam-tier handle. */
export async function readState(view: EntityStateView): Promise<{
	owners: Record<string, string | undefined>;
	transfers: number;
}> {
	const owners: Record<string, string | undefined> = {};
	for (const id of ['1', '2', '3', '4']) {
		owners[id] = (await view.getCurrent<{owner: string}>('token', {id}))?.owner;
	}
	return {
		owners,
		transfers: (await view.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value ?? 0,
	};
}

/**
 * A browser store for a case that INDEXES: built, then CLAIMED.
 *
 * Every case in this harness folds, and folding is writing, so what a case needs
 * is the handle a claim hands back (ADR-0077). `openForWriting` migrates on the
 * way, which is the whole of the open.
 */
export async function writableStore(config: BrowserStateStoreConfig = {}): Promise<WritableStateStore> {
	return openForWriting(await createBrowserStateStore(processor.entities, config));
}

/**
 * The hook, wired to a store, exactly as an application wires it.
 *
 * Two lines an application author writes: the store is the deployment's choice
 * and the processor above is untouched.
 */
export function indexerFor(store: WritableStateStore) {
	return indexerForProcessor(store, processor);
}

/**
 * The same wiring, with the processor DEFINITION passed in.
 *
 * What a hot reload replaces is the author's object, not the store and not the
 * hook, so the reconfigure tests need to build a second `EntityEventProcessor`
 * over the same store from a second definition. That is exactly this call, and
 * `indexerFor` is now it with the fixture's own processor.
 *
 * The hook is handed the FACTORIES that build a generation rather than a
 * processor already built over a store: an indexer holds any number of
 * generations and each folds into its OWN state, so the store cannot be a value
 * the hook is given once. The store here is one the caller already opened (a
 * reload reopens the same database, which is what makes a reload a reload), so
 * `createState` hands that one back -- the factory is what distinguishes THIS
 * generation's state, and this fixture has exactly one.
 */
export function indexerForProcessor(store: WritableStateStore, definition: EntityProcessor<TestABI>) {
	return createIndexerState<TestABI, EntityStateView>({
		createState: () => store,
		createProcessor: (state) => entityProcessorOver(state, definition),
	});
}

/**
 * The `EventProcessor` the core drives, built from an author's definition over a
 * store.
 *
 * A hot reload rebuilds exactly this and hands it to `updateProcessor`: the
 * store is the same object (the tab's IndexedDB connection did not go anywhere),
 * and only the definition is new.
 */
export function entityProcessorOver(store: WritableStateStore, definition: EntityProcessor<TestABI>) {
	return new EntityEventProcessor<TestABI>(store, definition);
}

type IndexerState = ReturnType<typeof indexerFor>;

/**
 * Drive the hook to the tip, one `indexMore` at a time.
 *
 * `indexToLatest` is not used here on purpose: it swallows a failure and retries
 * on a timer forever, which in a test turns a broken wiring into a hang instead
 * of a red line.
 *
 * An advance answers nothing when this tab has been DEMOTED to a reader (another
 * writer took the store, or a lease was lost), which is not a cursor and cannot
 * be returned as one. It is raised here NAMING the demotion, so a test that did
 * not mean to lose the store fails saying what happened rather than on a null
 * read three lines later; a test that DOES mean to drives `indexMore` itself.
 */
export async function indexToTip(indexer: IndexerState, maxRounds = 20): Promise<LastSync<TestABI>> {
	let lastSync = demotedOrCursor(indexer, await indexer.indexMore());
	let rounds = 0;
	while (lastSync.lastToBlock < lastSync.latestBlock && rounds++ < maxRounds) {
		lastSync = demotedOrCursor(indexer, await indexer.indexMore());
	}
	return lastSync;
}

function demotedOrCursor(indexer: IndexerState, lastSync: LastSync<TestABI> | undefined): LastSync<TestABI> {
	if (!lastSync) {
		throw new Error(
			`this indexer was DEMOTED to a reader (${indexer.syncing.$state.demotion?.reason ?? 'unknown'}), so the ` +
				`advance answered no cursor: it has stopped fetching and folding and now only reads.`,
		);
	}
	return lastSync;
}

/**
 * One whole run: open the hook over `store`, index the captured stream, read the
 * state back.
 *
 * `chain` is passed in so a caller can keep the SAME node across two runs, which
 * is what makes the reload case a reload rather than a fresh chain.
 */
export async function runWorkload(
	store: WritableStateStore,
	chain: ReturnType<typeof fakeChain> = fakeChain(),
): Promise<{
	state: Awaited<ReturnType<typeof readState>>;
	lastSync: LastSync<TestABI>;
	ranges: FetchedRange[];
	indexer: IndexerState;
}> {
	const indexer = indexerFor(store);
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
	const lastSync = await indexToTip(indexer);
	const state = await readState(indexer.state.$state);
	indexer.dispose();
	return {state, lastSync, ranges: chain.ranges, indexer};
}

/**
 * The stream a read was expected to hand back, or a failure that SAYS what came
 * instead.
 *
 * `fetchFrom` answers a VERDICT since ADR-0069, so a test wanting the stream has
 * to narrow. One helper keeps the failure useful -- `expected a stream, got
 * 'does-not-reach-back'` names the verdict, where a bare `?.` would fail later
 * and somewhere else.
 */
export function streamOf(read: StreamRead): {lastSync: StoredLastSync; eventStream: StoredLogEvent[]} {
	if (read.status !== 'stream') {
		throw new Error(`expected a stream, got '${read.status}'`);
	}
	return read;
}

/** The same, for an inspection that TOLERATES there being no stream yet. */
export function streamOrAbsent(
	read: StreamRead,
): {lastSync: StoredLastSync; eventStream: StoredLogEvent[]} | undefined {
	return read.status === 'stream' ? read : undefined;
}
