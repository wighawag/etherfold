import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {generationDigestOf} from '../src/generation/identity.js';
import {createMemoryGenerationRegistryPort} from '../src/generation/memory.js';
import {GenerationCapReachedError, type GenerationRegistryPort} from '../src/generation/registry.js';
import {openReceivingIndexer, SERVER_GENERATION_CAPS} from '../src/receivingContainer.js';
import {StreamBuilder} from '../src/streamBuilder.js';
import type {EventProcessor, IndexingSource, LastSync, LogEvent, WireBatch} from '../src/types.js';

// ---------------------------------------------------------------------------------------------------
// A CHANGED CONTEXT CREATES A SUCCESSOR INSTEAD OF CALLING `processor.clear()`
// ---------------------------------------------------------------------------------------------------
// `StreamBuilder` DISCARDS a persisted cursor that carries another fold: it
// calls `processor.clear()` from `currentLastSync`, reached from BOTH public
// methods, so a server whose processor was upgraded wipes the state it answers
// from and serves progressively less until it has caught up. That is the outage,
// and it has a concrete call site.
//
// With a **generation container** above it that branch stops discarding: the
// fold this receiver runs is RESOLVED-OR-CREATED as a generation of its own, and
// the canonical generation goes on answering exactly what it answered before.
//
// What is asserted here is the CONTRACT at the two seams the task names -- the
// receive/`expectedFromBlock` path with a container attached, and the registry
// underneath it. The DURABLE half (rows that survive a restart, a state
// namespace that is really its own tables) is asserted over a real database in
// `packages/cli/test/aChangedContextCreatesASuccessor.test.ts`, because
// `@etherfold/core` depends on no substrate.
// ---------------------------------------------------------------------------------------------------

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

const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const START_BLOCK = 100;
const FINALITY = 3;

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

let logCounter = 0;

function transfer(blockNumber: number, blockHash: string, id: bigint): LogEvent<TestABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash: blockHash as `0x${string}`,
		blockTimestamp: 1_700_000_000 + blockNumber * 12,
		transactionIndex: 0,
		removed: false,
		address: CONTRACT,
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex: 0,
		extra: undefined,
		eventName: 'Transfer',
		args: {from: CONTRACT, to: CONTRACT, id},
	} as unknown as LogEvent<TestABI>;
}

/**
 * ONE SUBSTRATE STANDING IN FOR ONE NAMED INDEXER'S DATABASE: the generation
 * records, and a state store per NAMESPACE.
 *
 * The stores are keyed by a name the caller's own closure chooses, which is
 * exactly how the real thing works: `createState` is handed the STREAM and the
 * caller keys the state on the generation it is building (ADR-0053's table
 * namespace). Keying two folds on ONE name is therefore expressible here, and it
 * is what the `processor.clear()` branch is reached through -- a database written
 * before this runtime held generations has precisely that shape.
 */
function substrate() {
	const port: GenerationRegistryPort = createMemoryGenerationRegistryPort();
	const stores = new Map<string, {rows: string[]; lastSync?: LastSync<TestABI>}>();
	const cleared: string[] = [];

	function storeFor(namespace: string) {
		let store = stores.get(namespace);
		if (!store) {
			store = {rows: []};
			stores.set(namespace, store);
		}
		return store;
	}

	/**
	 * A fold, as the container builds one: the state FIRST, then the processor over
	 * it (ADR-0043).
	 *
	 * `namespace` is what the caller keys the state on. `own` names it from the
	 * generation identity, which is what a host that holds several generations
	 * does; `shared` hands two folds one store, which is what a pre-generation
	 * database is.
	 */
	function specFor(version: string, namespace: 'own' | {shared: string}) {
		return {
			createState: (context: {stream: string}) =>
				storeFor(
					namespace === 'own' ? generationDigestOf({stream: context.stream, processor: version}) : namespace.shared,
				),
			createProcessor: (state: {rows: string[]; lastSync?: LastSync<TestABI>}): EventProcessor<TestABI, void> => {
				const processor: EventProcessor<TestABI, void> = {
					getVersionHash: () => version,
					getCodeFingerprint: () => undefined,
					load: async () => (state.lastSync ? {state: undefined as void, lastSync: state.lastSync} : undefined),
					process: async (eventStream, lastSync) => {
						for (const event of eventStream) {
							state.rows.push(`${version}@${event.blockNumber}`);
						}
						state.lastSync = lastSync;
					},
					reset: async () => {
						state.rows.length = 0;
						state.lastSync = undefined;
					},
					clear: async () => {
						cleared.push(version);
						await processor.reset();
					},
				};
				return processor;
			},
		};
	}

	return {
		port,
		stores,
		cleared,
		specFor,
		rowsIn: (namespace: string) => storeFor(namespace).rows,
	};
}

type Substrate = ReturnType<typeof substrate>;

/** The container the server/CLI runtime builds: one substrate, one fold, its caps. */
function open(world: Substrate, version: string) {
	return openReceivingIndexer({
		port: world.port,
		source: SOURCE,
		stream: {finality: FINALITY},
		generation: world.specFor(version, 'own'),
	});
}

function batch(
	builder: StreamBuilder<TestABI, void>,
	over: Pick<WireBatch<TestABI>, 'fromBlock' | 'toBlock' | 'latestBlock'> & {logs?: LogEvent<TestABI>[]},
): WireBatch<TestABI> {
	return {
		context: builder.context,
		fromBlock: over.fromBlock,
		toBlock: over.toBlock,
		latestBlock: over.latestBlock,
		logs: over.logs ?? [],
	};
}

/** The incumbent: one generation, folded up to block 105, canonical. */
async function anIndexerThatHasFolded(world: Substrate) {
	const incumbent = await open(world, 'v1');
	await incumbent.ingestion.receive(
		batch(incumbent.ingestion, {
			fromBlock: 100,
			toBlock: 105,
			latestBlock: 105,
			logs: [transfer(101, '0xa101', 1n)],
		}),
	);
	return incumbent;
}

describe('a changed context, with a container above the receiver', () => {
	it('CREATES a generation beside the canonical one instead of clearing the state it answers from', async () => {
		const world = substrate();
		const incumbent = await anIndexerThatHasFolded(world);
		const incumbentNamespace = generationDigestOf(incumbent.generation);
		const before = [...world.rowsIn(incumbentNamespace)];

		// the upgrade: the SAME source and the SAME stream config, a DIFFERENT fold,
		// and the database still holds what the previous fold wrote
		const successor = await open(world, 'v2');
		await successor.ingestion.expectedFromBlock();

		// THE CALL SITE, which is the outage this removes
		expect(world.cleared).toEqual([]);
		// the incumbent still answers exactly what it answered before
		expect(world.rowsIn(incumbentNamespace)).toEqual(before);
		expect(before).toEqual(['v1@101']);

		const records = await successor.registry.list();
		expect(records.map((record) => record.processor)).toEqual(['v1', 'v2']);
		// the pointer did NOT move: the successor exists beside the live one
		expect(await successor.canonical()).toMatchObject({processor: 'v1'});
		// ADR-0052: only the INDEXING generation writes a stream, and that is the
		// OLDEST SURVIVING one on it -- so the successor appends nothing rather than
		// storing a second copy of a history every generation re-folds
		expect(incumbent.writesStream).toBe(true);
		expect(successor.writesStream).toBe(false);
	});

	it('does not clear even when the caller handed both folds ONE store, which is the pre-generation database', async () => {
		const world = substrate();
		const incumbent = await openReceivingIndexer({
			port: world.port,
			source: SOURCE,
			stream: {finality: FINALITY},
			generation: world.specFor('v1', {shared: 'legacy'}),
		});
		await incumbent.ingestion.receive(
			batch(incumbent.ingestion, {fromBlock: 100, toBlock: 105, latestBlock: 105, logs: [transfer(101, '0xa101', 1n)]}),
		);
		expect(world.rowsIn('legacy')).toEqual(['v1@101']);

		// the branch the outage lives on: a persisted cursor written by another fold
		const successor = await openReceivingIndexer({
			port: world.port,
			source: SOURCE,
			stream: {finality: FINALITY},
			generation: world.specFor('v2', {shared: 'legacy'}),
		});
		expect(await successor.ingestion.expectedFromBlock()).toBe(START_BLOCK);

		expect(world.cleared).toEqual([]);
		expect(world.rowsIn('legacy')).toEqual(['v1@101']);
	});

	it('RESOLVES a context it has already seen rather than registering it twice', async () => {
		const world = substrate();
		await anIndexerThatHasFolded(world);

		const again = await open(world, 'v1');
		await again.ingestion.expectedFromBlock();
		await again.ingestion.expectedFromBlock();

		expect((await again.registry.list()).map((record) => record.processor)).toEqual(['v1']);
		expect(await again.canonical()).toMatchObject({processor: 'v1'});
	});

	it('comes back holding the same generations, with the same canonical one, against the same substrate', async () => {
		const world = substrate();
		await anIndexerThatHasFolded(world);
		await open(world, 'v2');

		// a restart is a new container over the same records
		const restarted = await open(world, 'v2');
		expect((await restarted.generations()).map((record) => record.processor)).toEqual(['v1', 'v2']);
		expect(await restarted.canonical()).toMatchObject({processor: 'v1'});
	});
});

describe('the generation caps, on the runtime that supplies them', () => {
	it('defaults to the receiving runtime bound and REPORTS which one is in force', async () => {
		const world = substrate();
		const indexer = await open(world, 'v1');
		expect(indexer.caps).toEqual(SERVER_GENERATION_CAPS);
		// far more generous than a browser tab's two, and stated rather than derived
		expect(SERVER_GENERATION_CAPS.maxGenerations).toBeGreaterThan(2);
	});

	it('REFUSES at a host-supplied bound, naming what to delete, and creates nothing', async () => {
		const world = substrate();
		await anIndexerThatHasFolded(world);

		const refused = openReceivingIndexer({
			port: world.port,
			source: SOURCE,
			stream: {finality: FINALITY},
			caps: {maxGenerations: 1, maxStreams: 1},
			generation: world.specFor('v2', 'own'),
		});

		await expect(refused).rejects.toBeInstanceOf(GenerationCapReachedError);
		await expect(refused).rejects.toThrow(/maxGenerations of 1/);
		// nothing was evicted and no partial record was left behind
		const registry = await open(world, 'v1');
		expect((await registry.generations()).map((record) => record.processor)).toEqual(['v1']);
		expect(await registry.canonical()).toMatchObject({processor: 'v1'});
	});

	it('lets a host that raises the bound past the refusal create the successor', async () => {
		const world = substrate();
		await anIndexerThatHasFolded(world);

		const successor = await openReceivingIndexer({
			port: world.port,
			source: SOURCE,
			stream: {finality: FINALITY},
			caps: {maxGenerations: 2, maxStreams: 1},
			generation: world.specFor('v2', 'own'),
		});

		expect((await successor.generations()).map((record) => record.processor)).toEqual(['v1', 'v2']);
	});
});

describe('one container, SEVERAL live wire contexts', () => {
	/** A DIFFERENT fetch filter, so `streamDigestOf` moves: a new stream, not a fork. */
	const OTHER_SOURCE: IndexingSource<TestABI> = {
		chainId: '1',
		contracts: [{abi, address: '0x0000000000000000000000000000000000000077', startBlock: START_BLOCK}],
	};

	it('gives a fold on a NEW stream its own receiver, at its own address, writing its own stream', async () => {
		const world = substrate();
		const incumbent = await anIndexerThatHasFolded(world);

		const successor = await incumbent.add({source: OTHER_SOURCE, ...world.specFor('v1', 'own')});

		// a filter change is a new STREAM, so it is a new ADDRESS on the wire: the two
		// receivers cannot be reached by each other's batches
		expect(successor.streamDigest).not.toBe(incumbent.streamDigest);
		// it is NOT a follower, so it has a receiver of its own (ADR-0044: determined by
		// the stream, never configured)
		expect(successor.follows).toBe(false);
		expect(successor.ingestion?.context).not.toEqual(incumbent.ingestion.context);
		// and it is the only generation on its stream, so it is that stream's WRITER
		// (ADR-0044) -- unlike a processor-change successor, which re-folds one already
		// stored
		expect(successor.writesStream).toBe(true);
		// two generations, on two streams (the listing's order ties on `createdAt`
		// within one millisecond, so what is asserted is the SET)
		expect((await incumbent.generations()).map((record) => record.stream).sort()).toEqual(
			[incumbent.streamDigest, successor.streamDigest].sort(),
		);
	});

	it('REFUSES a fold on a stream it already holds when it was given no stream to re-fold', async () => {
		const world = substrate();
		const incumbent = await anIndexerThatHasFolded(world);

		// the same source and config, another fold: a PROCESSOR change, which asserts
		// the very same `{source, config}`. It gets no receiver -- a second one there
		// would be reachable only by iteration order -- and catches up by re-folding the
		// stored stream instead (ADR-0044). This container was given no `replay` source,
		// so there is nothing to re-fold and the successor would never advance.
		// `packages/core/test/rebuild.test.ts` is the same call with one supplied.
		await expect(incumbent.add(world.specFor('v2', 'own'))).rejects.toThrow(/ONE address on the wire/);
		await expect(incumbent.add(world.specFor('v2', 'own'))).rejects.toThrow(/no `replay` source/);
		expect((await incumbent.generations()).map((record) => record.processor)).toEqual(['v1']);
	});

	it('reports as LIVE exactly the folds whose generation is still registered', async () => {
		const world = substrate();
		const incumbent = await anIndexerThatHasFolded(world);
		const successor = await incumbent.add({source: OTHER_SOURCE, ...world.specFor('v1', 'own')});

		expect((await incumbent.liveIngestions()).map((receiver) => receiver.streamDigest)).toEqual([
			incumbent.streamDigest,
			successor.streamDigest,
		]);

		// the pointer MOVING does not retire a context: a superseded generation is
		// retained under the caps, so what happens to its context is a policy input
		// rather than something this routing decides
		await incumbent.registry.moveCanonicalTo(successor.record);
		expect((await incumbent.liveIngestions()).length).toBe(2);
		expect(await incumbent.canonicalGeneration()).toEqual({
			stream: successor.record.stream,
			processor: successor.record.processor,
		});

		// DELETING one does: its state is gone, so folding into it would be writing
		// into nothing
		await incumbent.registry.deleteGeneration(incumbent.generation);
		expect((await incumbent.liveIngestions()).map((receiver) => receiver.streamDigest)).toEqual([
			successor.streamDigest,
		]);
	});
});

describe('a receiver built WITHOUT a container', () => {
	it('still discards a persisted cursor written by another fold, exactly as before', async () => {
		const world = substrate();
		const incumbent = await anIndexerThatHasFolded(world);
		const namespace = generationDigestOf(incumbent.generation);

		// the same fold, over the same store, with no container attached
		const state = world.stores.get(namespace) as {rows: string[]; lastSync?: LastSync<TestABI>};
		const processor = world.specFor('v2', {shared: namespace}).createProcessor(state);
		const bare = new StreamBuilder<TestABI, void>(processor, SOURCE, {stream: {finality: FINALITY}});

		expect(await bare.expectedFromBlock()).toBe(START_BLOCK);
		expect(world.cleared).toEqual(['v2']);
		expect(world.rowsIn(namespace)).toEqual([]);
	});
});
