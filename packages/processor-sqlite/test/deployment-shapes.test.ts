import {createClient} from '@libsql/client';
import {
	captureStream,
	IndexerGeneration,
	LogFetcher,
	UnexpectedFromBlockError,
	WireContextMismatchError,
	type IngestionResponse,
	type IngestionTarget,
	type WireBatch as PublishedWireBatch,
	parseStreamFixture,
	parseWireBatch,
	serializeStreamFixture,
	serializeWireBatch,
	simple_hash,
	type ContextIdentifier,
	type EventProcessor,
	type IndexingSource,
	type LogEvent,
	type StreamFixture,
	type UsedStreamConfig,
} from '@etherfold/core';
import {applyEventStream, type EntityProcessor} from '@etherfold/processor-entities';
import {
	MemoryStateStore,
	openForWriting,
	type EntityId,
	type StateStoreBackend,
	type WritableStateStore,
} from '@etherfold/state-store';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {beforeAll, describe, expect, it} from 'vitest';
import {VersionedStateEventProcessor} from '../src/index.js';
import {abi, processor, timestampOf, type TestABI} from './utils/fixtures.js';

// ---------------------------------------------------------------------------
// ONE PROCESSOR, TWO DEPLOYMENT SHAPES
// ---------------------------------------------------------------------------
// User story 12 of `work/specs/tasked/one-processor-everywhere.md`: the same
// processor and the same entity declarations, whether a deployment runs the
// single-process CLI or a split log-fetcher and indexer-server, so that scaling
// out is a deployment change and not a rewrite.
//
// The two shapes, in ADR-0003's vocabulary:
//
//   single-process  one process does all three. The LOG-FETCHER, the
//                   STREAM-BUILDER and the processor are the one
//                   `IndexerGeneration` driving `indexMore()` against a chain.
//                   This is what `etherfold serve` is, and it is the INTENDED
//                   CLI shape, not a violation.
//
//   split           two deployables. The log-fetcher is stateless and makes
//                   chain calls only; it pushes contiguous ranges of decoded
//                   logs across a wire. The indexer-server hosts the
//                   stream-builder and the processor, derives every reorg
//                   itself (ADR-0004: no reorg information crosses the wire),
//                   and never touches a chain.
//
// The sending half below is the SHIPPED `LogFetcher` (`@etherfold/core`), not a
// stand-in written here: a simulated sender can only ever prove that the
// simulation and the receiver agree. The receiving half is deliberately the
// engine's own `feed` behind a provider that refuses every call, because that is
// what arms check 1 below; the real receiving stack (`StreamBuilder`, the HTTP
// routes, a real database) is driven end to end in
// `packages/server/test/fetcherRoundTrip.test.ts`.
//
// ## Why a test and not an assurance
//
// The failure this file exists to prevent is silent. A convenience in the
// single-process path that reaches across the log-fetcher / indexer-server
// boundary breaks no test today; it is discovered the day somebody tries to pull
// the halves apart. So "the boundary is intact" has to be a thing that GOES RED,
// and it is encoded here in four ways:
//
//   1. **The receiving half is handed a provider that refuses.** Every JSON-RPC
//      method throws, naming the boundary. If the stream-builder / processor
//      half ever needs a chain call -- a block header, a receipt, even
//      `eth_chainId` -- it cannot be deployed away from the fetcher, and this
//      goes red at the call. That is what catches a convenience added on the
//      SINGLE-PROCESS side, which is where one would be added: the same
//      processor and the same core run both ways, so anything the CLI shape
//      quietly reaches for is reached for again here, against a provider that
//      will not answer.
//   2. **Everything that crosses the wire is JSON, and is asserted to survive
//      the crossing unchanged.** A convenience that smuggles a live object, a
//      class instance or a closure from the fetcher to the server goes red
//      structurally rather than eventually.
//   3. **The envelope is asserted to be ADR-0004's, and nothing more**: no
//      `removed` markers, no `unconfirmedBlocks`. If reorg information ever
//      starts being computed by the chain-facing side, the wire stops being a
//      wire.
//   4. **The RECEIVER is authoritative about the cursor.** The fetcher asks it
//      where the next batch must start, and a batch starting anywhere else is
//      refused with nothing applied. If the sender ever became authoritative,
//      the stateless component would have become stateful.
//
// ## Why the input is a replayed fixture
//
// Both shapes have to see IDENTICAL bytes, or an equality between them measures
// two chain reads rather than two deployments. `@etherfold/core`'s stream
// fixture is that: the chain is captured once, serialized once, and every run
// below re-parses the same text and replays it. `replayStream` itself is not
// used, because it serves the capture ABOVE the fetch, where only the
// single-process shape reads -- the split shape's fetcher needs a chain to fetch
// FROM. So the fixture is replayed one level lower, as the provider both shapes'
// chain-facing half talks to.
// ---------------------------------------------------------------------------

/**
 * Every address here is DIGITS ONLY, and that is deliberate rather than lazy:
 * the decoder hands a handler an EIP-55 checksummed address, so an address
 * containing hex letters would be stored in a casing no assertion below could
 * quote without also encoding viem's checksum. An address with no letters is
 * checksum-invariant, which keeps the expected state readable.
 */
const CONTRACT = '0x0000000000000000000000000000000000000099' as const;

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: 100}],
};

/** Small on purpose: the reorg below has to fall INSIDE the unconfirmed window. */
const FINALITY = 3;
const STREAM_CONFIG: UsedStreamConfig = {finality: FINALITY};

/** `Transfer(address,address,uint256)`, which is what the test ABI's event hashes to. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

const ALICE = '0x0000000000000000000000000000000000000011';
const BOB = '0x0000000000000000000000000000000000000022';
const CAROL = '0x0000000000000000000000000000000000000033';
const DAN = '0x0000000000000000000000000000000000000044';
const ERIN = '0x0000000000000000000000000000000000000055';
const ZERO = '0x0000000000000000000000000000000000000000';

const TOKEN_IDS = ['1', '2', '3', '4'];

// ---------------------------------------------------------------------------
// the chain, as raw logs
// ---------------------------------------------------------------------------

type RawLog = {
	blockNumber: string;
	blockHash: string;
	transactionIndex: string;
	removed: boolean;
	address: string;
	data: string;
	topics: string[];
	transactionHash: string;
	logIndex: string;
	blockTimestamp?: string;
};

function hex(value: number): string {
	return `0x${value.toString(16)}`;
}

function addressTopic(address: string): string {
	return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
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
 * The chain before the reorg: blocks 100, 102 and 104 carry logs, the tip is 105.
 *
 * Block 100 is deliberately outside the finality window at that tip, so it is
 * CONFIRMED by the time the reorg lands and cannot be part of what is retracted.
 */
const BRANCH_A = [
	transferLog(100, '0xa100', {from: ZERO, to: ALICE, id: 1n}, 0),
	transferLog(100, '0xa100', {from: ZERO, to: BOB, id: 2n}, 1),
	transferLog(102, '0xa102', {from: ALICE, to: BOB, id: 1n}),
	transferLog(104, '0xa104', {from: ZERO, to: DAN, id: 3n}, 0),
	transferLog(104, '0xa104', {from: BOB, to: ERIN, id: 2n}, 1),
];
const BRANCH_A_TIP = 105;

/**
 * The same chain after a reorg at block 104: same 100 and 102, a DIFFERENT 104,
 * and the tip has moved on.
 *
 * The replacement carries FEWER events than what it replaces, which is the case
 * that matters: the global counter must come DOWN (5 -> 4), token 3 must vanish
 * entirely, and token 2 -- which the replacement branch never mentions -- must go
 * back to the owner block 100 gave it.
 */
const BRANCH_B = [BRANCH_A[0], BRANCH_A[1], BRANCH_A[2], transferLog(104, '0xb104', {from: ZERO, to: CAROL, id: 4n})];
const BRANCH_B_TIP = 106;

/** A node that serves one branch at a time, and counts what it was asked. */
function fakeChain() {
	const calls: string[] = [];
	let served: RawLog[] = [];
	let tip = 0;
	return {
		calls,
		serve(logs: RawLog[], latestBlock: number) {
			served = logs;
			tip = latestBlock;
		},
		provider: {
			async request(args: {method: string; params?: any}): Promise<any> {
				calls.push(args.method);
				switch (args.method) {
					case 'eth_chainId':
						return hex(Number(SOURCE.chainId));
					case 'eth_blockNumber':
						return hex(tip);
					case 'eth_getLogs': {
						const from = parseInt(args.params[0].fromBlock.slice(2), 16);
						const to = parseInt(args.params[0].toBlock.slice(2), 16);
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
 * A provider for the half of a SPLIT deployment that has no chain, and the first
 * of the four boundary checks.
 *
 * ADR-0003 puts every chain call in the log-fetcher, which is its own deployable
 * precisely because it is stateless and disposable. If the stream-builder /
 * processor half ever reaches for a provider, it can no longer be deployed
 * apart, and that is the silent failure this file exists to make loud: it
 * happens HERE, at the call, naming the method.
 */
function noChain() {
	const calls: string[] = [];
	return {
		calls,
		provider: {
			async request(args: {method: string}): Promise<never> {
				calls.push(args.method);
				throw new Error(
					`the indexer-server called ${args.method}: it reached across the log-fetcher boundary. ` +
						`ADR-0003 keeps every chain call in the log-fetcher, which is a separate deployable; a ` +
						`stream-builder/processor half that needs a provider cannot be split off from it.`,
				);
			},
		} as any,
	};
}

/** The raw form of a captured event, so a fixture can be replayed AS a chain. */
function rawLogOf(event: LogEvent<TestABI>): RawLog {
	return {
		blockNumber: hex(event.blockNumber),
		blockHash: event.blockHash,
		transactionIndex: hex(event.transactionIndex),
		removed: false,
		address: event.address,
		data: event.data,
		topics: event.topics,
		transactionHash: event.transactionHash,
		logIndex: hex(event.logIndex),
		...(event.blockTimestamp === undefined ? {} : {blockTimestamp: hex(event.blockTimestamp)}),
	};
}

// ---------------------------------------------------------------------------
// the wire (ADR-0004)
// ---------------------------------------------------------------------------

/**
 * What the log-fetcher pushes: a contiguous block range and the logs in it.
 *
 * ADR-0004's envelope. This was a local structural copy while the endpoint was
 * still `ingest-wire-receiving-side`'s to settle; it landed, so this is now the
 * published type and the assertions below are about the REAL envelope rather
 * than about a look-alike that could drift from it.
 */
type WireBatch = PublishedWireBatch<TestABI>;

/**
 * The `{source, config}` identity both halves compute from the SAME declarations.
 *
 * It is what the receiver's own indexer hashes its source and stream config to,
 * so comparing a batch against it is the receiver comparing a batch against
 * itself. `context.processor` is deliberately absent: the fetcher has no idea
 * which processor version runs on the other side, so it cannot assert it
 * (ADR-0004).
 */
const WIRE_CONTEXT: WireBatch['context'] = {
	source: [{startBlock: 0, hash: simple_hash(SOURCE)}],
	config: simple_hash(STREAM_CONFIG),
};

/**
 * The log-fetcher: the SHIPPED one, not a stand-in for it.
 *
 * This used to be a local loop built out of `captureStream`, written when the
 * component did not exist. It does now (`LogFetcher`, `@etherfold/core`), and a
 * test that simulated the sending half could only ever prove that the
 * SIMULATION and the receiver agree. What is wired up below is the real object:
 * it asks this target where to start, holds no cursor, and gets its batches
 * refused by the same rule a deployed one would.
 *
 * The RECEIVING half is deliberately still the engine's own `feed` behind a
 * provider that refuses every call, because that is what arms this file's
 * boundary check: `StreamBuilder` takes no provider at all, so pointing this at
 * it would make "the indexer-server has no chain" structurally true and
 * therefore untestable HERE. The real receiving stack (`StreamBuilder`, the HTTP
 * routes, a real database) is driven end to end by the fetcher in
 * `packages/server/test/fetcherRoundTrip.test.ts`.
 */
function ingestionInto(indexer: IndexerGeneration<TestABI, any>, wire: WireBatch[]): IngestionTarget {
	return {
		async expectedFromBlock() {
			// the RECEIVER's number, which is the whole of ADR-0004
			return {expectedFromBlock: indexer.expectedFromBlock, context: WIRE_CONTEXT};
		},
		async send(batch): Promise<IngestionResponse> {
			const received = cross(batch as unknown as WireBatch);
			// recorded BEFORE the outcome is known: a refused batch crossed the wire too,
			// and the envelope assertions below are about what crossed, not what was kept
			wire.push(received);
			try {
				await receive(indexer, received);
			} catch (err) {
				if (err instanceof UnexpectedFromBlockError) {
					// the one resumable refusal, handed back as data rather than thrown
					return {accepted: false, expectedFromBlock: err.expectedFromBlock};
				}
				throw err;
			}
			return {
				accepted: true,
				expectedFromBlock: indexer.expectedFromBlock,
				// `feed` reports no counts, and the sender steers by none of them: only
				// `expectedFromBlock` is load-bearing here
				applied: received.logs.length,
				retracted: 0,
			};
		},
	};
}

function fetcherOn(
	provider: {request(args: {method: string; params?: any}): Promise<any>},
	target: IngestionTarget,
): LogFetcher<TestABI> {
	return new LogFetcher<TestABI>(provider as any, SOURCE, target, {
		stream: STREAM_CONFIG,
		// no sleeping in a test: what is asserted is where batches start, not how long
		// a host waits between attempts
		retry: {wait: async () => {}},
	});
}

/**
 * The crossing itself: nothing reaches the receiver that is not JSON.
 *
 * Through the REAL wire codec, so this exercises what a deployed log-fetcher and
 * receiver actually put on and take off the wire, tag and all.
 */
function cross(batch: WireBatch): WireBatch {
	return parseWireBatch(serializeWireBatch(batch)) as WireBatch;
}

/**
 * The indexer-server's ingestion, minus the HTTP.
 *
 * `IndexerGeneration.feed` IS the stream-builder: it takes raw fetched events and
 * a range, derives the retractions itself, and drives the processor. The context
 * is validated first, which is the rule ADR-0004 states for the receiving side.
 */
async function receive(indexer: IndexerGeneration<TestABI, any>, batch: WireBatch): Promise<void> {
	if (simple_hash(batch.context) !== simple_hash(WIRE_CONTEXT)) {
		// the core's own refusal type, so a SENDER classifies it the way it would
		// classify the real receiver's `400`: fatal, and never retried
		throw new WireContextMismatchError(WIRE_CONTEXT, batch.context);
	}
	const context: ContextIdentifier = {...batch.context, processor: ''};
	await indexer.feed(batch.logs, {
		context,
		latestBlock: batch.latestBlock,
		lastFromBlock: batch.fromBlock,
		lastToBlock: batch.toBlock,
		unconfirmedBlocks: [],
	});
}

// ---------------------------------------------------------------------------
// where the state lives: a deployment's choice, and nothing the processor sees
// ---------------------------------------------------------------------------

type Snapshot = Record<string, unknown>;

type Reader = (entity: string, id: EntityId) => Promise<Record<string, unknown> | undefined>;

/** The declared fields only: versions, ranges and cursors are storage, not state. */
async function snapshotOf(read: Reader): Promise<Snapshot> {
	const state: Snapshot = {};
	for (const id of TOKEN_IDS) {
		const token = await read('token', {id});
		state[`token/${id}`] = token && {owner: token.owner};
	}
	const counter = await read('counter', {name: 'transfers'});
	state['counter/transfers'] = counter && {value: counter.value};
	return state;
}

/**
 * The `EventProcessor` a deployment hands the indexer for a `StateStore` that
 * has no published one yet.
 *
 * TEST-LOCAL ON PURPOSE. It is `applyEventStream` (the backend-agnostic half of
 * processing, written once at the seam) plus the lifecycle calls the core makes,
 * and NOTHING else -- in particular it persists no `LastSync`, so it starts
 * fresh every time. Publishing a general one means deciding where a backend-less
 * processor keeps its cursor, and ADR-0016 makes that a property of where its
 * state lives; that decision belongs to the task that wires a browser
 * deployment, not to this one. What it is here for is that the storage backend
 * is the only thing that differs between two runs of the SAME processor object.
 */
function entityProcessorOver(
	store: StateStoreBackend,
	authored: EntityProcessor<TestABI>,
): EventProcessor<TestABI, void> {
	// CLAIMED once, on first use: folding is writing, and the ability to mutate is
	// obtained by claiming (ADR-0077). `openForWriting` migrates, which is what the
	// `migrated` flag here used to be.
	let writer: Promise<WritableStateStore> | undefined;
	const claimed = () => (writer ??= openForWriting(store));
	return {
		getVersionHash: () => `${authored.version}-${simple_hash({entities: authored.entities})}`,
		getCodeFingerprint: () => undefined,
		load: async () => {
			await claimed();
			return undefined;
		},
		process: async (eventStream) => {
			await applyEventStream(await claimed(), authored, eventStream, undefined);
		},
		reset: async () => {
			await (await claimed()).revertTo(-1);
		},
		clear: async () => {
			await (await claimed()).revertTo(-1);
		},
	};
}

type Backend = {
	name: string;
	make(): {processor: EventProcessor<TestABI, any>; read: Reader};
};

const backends: Backend[] = [
	{
		// the published one: versioned rows in a REAL local libSQL database
		name: 'sqlite',
		make() {
			const p = new VersionedStateEventProcessor<TestABI>(new RemoteLibSQL(createClient({url: ':memory:'})), processor);
			return {processor: p, read: (entity, id) => p.state.getCurrent(entity, id)};
		},
	},
	{
		// versioned rows in a Map, owing nothing to SQL: one line of configuration
		// away, and the processor object below is the same one, by reference
		name: 'memory',
		make() {
			const store = new MemoryStateStore(processor.entities);
			return {processor: entityProcessorOver(store, processor), read: (entity, id) => store.getCurrent(entity, id)};
		},
	},
];

// ---------------------------------------------------------------------------
// the two deployment shapes
// ---------------------------------------------------------------------------

type Deployed = {
	/** Point the chain at a branch and index up to its tip. */
	advanceTo(fixture: StreamFixture<TestABI>): Promise<void>;
	state(): Promise<Snapshot>;
	/** What the half that HOSTS THE PROCESSOR asked a chain for. */
	processingSideChainCalls: string[];
	/** Every envelope that crossed a wire; empty in the single-process shape. */
	wire: WireBatch[];
};

type Shape = {name: string; start(backend: Backend): Promise<Deployed>};

function chainOf(fixture: StreamFixture<TestABI>): {logs: RawLog[]; tip: number} {
	return {logs: fixture.eventStream.map(rawLogOf), tip: fixture.provenance.toBlock};
}

const shapes: Shape[] = [
	{
		name: 'single-process',
		async start(backend) {
			const chain = fakeChain();
			const {processor: eventProcessor, read} = backend.make();
			const indexer = new IndexerGeneration<TestABI, any>(chain.provider, eventProcessor, SOURCE, {
				stream: STREAM_CONFIG,
			});
			return {
				async advanceTo(fixture) {
					const branch = chainOf(fixture);
					chain.serve(branch.logs, branch.tip);
					let sync = await indexer.indexMore();
					while (sync.lastToBlock < sync.latestBlock) {
						sync = await indexer.indexMore();
					}
				},
				state: () => snapshotOf(read),
				// one process: the half that hosts the processor IS the half that fetches
				processingSideChainCalls: chain.calls,
				wire: [],
			};
		},
	},
	{
		name: 'split',
		async start(backend) {
			const chain = fakeChain();
			const server = noChain();
			const {processor: eventProcessor, read} = backend.make();
			// the indexer-server boots its processor itself: that is storage (a
			// migration, a cursor read), and it needs no chain. `indexer.load()` is NOT
			// called, because it starts with an `eth_chainId` round-trip and this half
			// has no node to ask; the fetcher asserts `{source, config}` instead.
			await eventProcessor.load(SOURCE, STREAM_CONFIG);
			const indexer = new IndexerGeneration<TestABI, any>(server.provider, eventProcessor, SOURCE, {
				stream: STREAM_CONFIG,
			});
			const wire: WireBatch[] = [];
			// one fetcher across every advance, so the runs also exercise what it does
			// and does not carry between cycles
			const fetcher = fetcherOn(chain.provider, ingestionInto(indexer, wire));
			return {
				async advanceTo(fixture) {
					const branch = chainOf(fixture);
					chain.serve(branch.logs, branch.tip);
					for (let cycle = 0; cycle < 10; cycle++) {
						// where the next range starts is asked of the RECEIVER, inside the
						// fetcher, and never decided here (ADR-0004)
						const outcome = await fetcher.fetchAndPush();
						if (outcome.status === 'up-to-date') return;
						if (outcome.status === 'pushed' && outcome.toBlock >= outcome.latestBlock) return;
					}
					throw new Error(`the fetcher did not reach the tip of ${fixture.provenance.toBlock} in 10 cycles`);
				},
				state: () => snapshotOf(read),
				processingSideChainCalls: server.calls,
				wire,
			};
		},
	},
];

// ---------------------------------------------------------------------------

/** The captured chain, serialized ONCE: every run below re-parses this text. */
let CANONICAL_TEXT: string;
let REORGED_TEXT: string;

beforeAll(async () => {
	const chain = fakeChain();
	chain.serve(BRANCH_A, BRANCH_A_TIP);
	CANONICAL_TEXT = serializeStreamFixture(
		await captureStream<TestABI>(chain.provider, SOURCE, {toBlock: BRANCH_A_TIP}),
	);
	chain.serve(BRANCH_B, BRANCH_B_TIP);
	REORGED_TEXT = serializeStreamFixture(await captureStream<TestABI>(chain.provider, SOURCE, {toBlock: BRANCH_B_TIP}));
});

/** What the handlers describe, so "the same" is never "the same wrong". */
const AFTER_CANONICAL: Snapshot = {
	'token/1': {owner: BOB}, // minted to alice in 100, moved to bob in 102
	'token/2': {owner: ERIN}, // minted to bob in 100, moved to erin in 104
	'token/3': {owner: DAN},
	'token/4': undefined,
	'counter/transfers': {value: 5},
};

const AFTER_REORG: Snapshot = {
	'token/1': {owner: BOB}, // block 102 is untouched by the fork
	'token/2': {owner: BOB}, // the 104 move is undone: back to what block 100 wrote
	'token/3': undefined, // minted only on the dead branch
	'token/4': {owner: CAROL}, // the replacement branch's only event
	'counter/transfers': {value: 4}, // DOWN from 5: the canonical reorg bug
};

const runs: Record<string, {canonical: Snapshot; reorged: Snapshot; deployed: Deployed}> = {};

beforeAll(async () => {
	for (const shape of shapes) {
		for (const backend of backends) {
			const deployed = await shape.start(backend);
			await deployed.advanceTo(parseStreamFixture<TestABI>(CANONICAL_TEXT));
			const canonical = await deployed.state();
			await deployed.advanceTo(parseStreamFixture<TestABI>(REORGED_TEXT));
			const reorged = await deployed.state();
			runs[`${shape.name}/${backend.name}`] = {canonical, reorged, deployed};
		}
	}
});

const combinations = shapes.flatMap((shape) => backends.map((backend) => `${shape.name}/${backend.name}`));

describe('one processor, run under the single-process CLI and under the split server', () => {
	it.each(combinations)('lands on the same state on %s', (key) => {
		expect(runs[key].canonical).toEqual(AFTER_CANONICAL);
	});

	it.each(combinations)('reverts the reorg the same way on %s, counter included', (key) => {
		expect(runs[key].reorged).toEqual(AFTER_REORG);
	});

	it('compares the two shapes on the PUBLISHED processor, not only on a harness', () => {
		expect(runs['split/sqlite'].canonical).toEqual(runs['single-process/sqlite'].canonical);
		expect(runs['split/sqlite'].reorged).toEqual(runs['single-process/sqlite'].reorged);
	});

	it('makes the storage backend the only difference between two runs of the same processor', () => {
		// the processor object is the SAME reference in all four runs: it is imported
		// from the fixtures module and named by neither backend nor shape.
		expect(runs['split/memory'].reorged).toEqual(runs['split/sqlite'].reorged);
		expect(runs['single-process/memory'].reorged).toEqual(runs['single-process/sqlite'].reorged);
	});
});

// ---------------------------------------------------------------------------
// the seam boundary, encoded so that closing it goes red
// ---------------------------------------------------------------------------

describe('the split seam is still open', () => {
	it.each(backends.map((backend) => backend.name))('gives the indexer-server no chain at all, on %s', (backendName) => {
		// The receiving half was constructed with a provider that THROWS on every
		// method. Any chain call it made would already have failed the runs above;
		// this states the property the runs relied on.
		expect(runs[`split/${backendName}`].deployed.processingSideChainCalls).toEqual([]);
		// and the single-process shape is the contrast, not a second violation: it
		// IS the log-fetcher, so of course it talked to a node.
		expect(runs[`single-process/${backendName}`].deployed.processingSideChainCalls.length).toBeGreaterThan(0);
	});

	it('arms that refusal rather than merely declaring it', async () => {
		// the check above is only worth its assertion if the guard would actually
		// fire, so this asks it to.
		const server = noChain();
		await expect(server.provider.request({method: 'eth_chainId'})).rejects.toThrow(/log-fetcher boundary/);
	});

	it('sends the ADR-0004 envelope across the wire and nothing else', () => {
		const batches = runs['split/sqlite'].deployed.wire;
		expect(batches.length).toBeGreaterThan(1); // one before the reorg, one after
		for (const batch of batches) {
			expect(Object.keys(batch).sort()).toEqual(['context', 'fromBlock', 'latestBlock', 'logs', 'toBlock']);
			expect(Object.keys(batch.context).sort()).toEqual(['config', 'source']);
			// no reorg information crosses: the receiver derives all of it
			expect(batch.logs.some((log) => log.removed)).toBe(false);
			expect(serializeWireBatch(batch)).not.toContain('unconfirmedBlocks');
		}
	});

	it('carries nothing across the wire that is not JSON', () => {
		for (const batch of runs['split/sqlite'].deployed.wire) {
			// the receiver already saw the round-tripped copy; this asserts the crossing
			// is lossless, so that a convenience smuggling a live object or a closure
			// fails HERE rather than on the day the halves are deployed apart.
			expect(cross(batch)).toEqual(batch);
		}
	});

	it('keeps the RECEIVER authoritative about the cursor', async () => {
		const chain = fakeChain();
		chain.serve(BRANCH_A, BRANCH_A_TIP);
		const server = noChain();
		const backend = backends[0].make();
		await backend.processor.load(SOURCE, STREAM_CONFIG);
		const indexer = new IndexerGeneration<TestABI, any>(server.provider, backend.processor, SOURCE, {
			stream: STREAM_CONFIG,
		});

		const sent: WireBatch[] = [];
		const fetcher = fetcherOn(chain.provider, ingestionInto(indexer, sent));

		expect(indexer.expectedFromBlock).toBe(100);
		await fetcher.fetchAndPush();
		expect(indexer.expectedFromBlock).toBe(102);
		// the batch a REAL fetcher sent, kept so the re-send below is the genuine
		// lost-acknowledgement case rather than one built for the occasion
		const good = sent[0];

		// a sender that decided for itself where to resume is refused, and nothing is
		// applied: the cursor IS the idempotency key, so the same batch re-sent after
		// a lost acknowledgement cannot be applied twice.
		await expect(receive(indexer, cross(good))).rejects.toThrow(/not as expected/);
		expect(await snapshotOf(backend.read)).toEqual(AFTER_CANONICAL);

		// a batch for another {source, config} is refused loudly rather than folded in
		await expect(
			receive(indexer, {...cross(good), context: {...WIRE_CONTEXT, config: 'someone-elses'}}),
		).rejects.toThrow(/another/);
	});
});
