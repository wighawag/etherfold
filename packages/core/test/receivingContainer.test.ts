import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {generationDigestOf} from '../src/generation/identity.js';
import {createMemoryGenerationRegistryPort} from '../src/generation/memory.js';
import {
	GenerationCapReachedError,
	type GenerationRecord,
	type GenerationRegistryPort,
} from '../src/generation/registry.js';
import {openReceivingIndexer, SERVER_GENERATION_CAPS} from '../src/receivingContainer.js';
import type {EmissionWrite, StreamCoverage} from '../src/emissionStream.js';
import type {ReplayRead, ReplaySource} from '../src/generation/rebuild.js';
import {StreamBuilder} from '../src/streamBuilder.js';
import type {StreamCursorRead, StreamCursorSource, StreamWriter} from '../src/stream/writer.js';
import type {EmittedLog, EventProcessor, IndexingSource, LastSync, LogEvent, WireBatch} from '../src/types.js';
import {identityOf} from './utils/processorIdentity.js';

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

const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

let logCounter = 0;

/**
 * A REAL raw log with real topics, so a REPLAY can `reparse` it.
 *
 * It used to carry `topics: []` and a pre-decoded `args`, which was enough while
 * a fold was fed by the WIRE: the decoded half arrived with the batch. Since
 * ADR-0087 every generation advances by re-folding the stream the deployment
 * stored, and a stored row carries the RAW log alone (`args` is what SOME ABI
 * made of those bytes, ADR-0034) -- so a fixture with no `topic0` is one no fold
 * can decode, and the folds here would silently apply nothing.
 */
function transfer(blockNumber: number, blockHash: string, id: bigint): LogEvent<TestABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash: blockHash as `0x${string}`,
		blockTimestamp: 1_700_000_000 + blockNumber * 12,
		transactionIndex: 0,
		removed: false,
		address: CONTRACT,
		data: `0x${id.toString(16).padStart(64, '0')}`,
		topics: [TRANSFER_TOPIC0, padded(CONTRACT), padded(CONTRACT)],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex: 0,
		extra: undefined,
	} as unknown as LogEvent<TestABI>;
}

function padded(address: string): string {
	return `0x${address.slice(2).padStart(64, '0')}`;
}

/**
 * THE STORED STREAM OF ONE NAMED INDEXER, in memory, with the three ends a host
 * supplies (ADR-0052, ADR-0087).
 *
 * WRITE (`appendEmissions`), REACH (`streamCursor`, which is what positions the
 * fetch) and READ BACK (`replay`). A container needs the first two to fetch at
 * all and the third to hold a fold, so they are built together here exactly as
 * the CLI builds them together over one database.
 *
 * Keyed by stream digest, because this container holds several: a filter change
 * is a different stream at a different address.
 */
function streams() {
	const rows = new Map<string, {seq: number; log: EmittedLog & {removed: boolean}}[]>();
	const coverage = new Map<string, StreamCoverage & {startBlock: number}>();
	let seq = 0;

	const blockOf = (row: {log: EmittedLog}) => (row.log as unknown as {blockNumber: number}).blockNumber;
	const eventsOf = (rowsIn: readonly {seq: number; log: EmittedLog}[]) =>
		[...rowsIn].sort((a, b) => a.seq - b.seq).map((row) => ({...row.log}) as unknown as LogEvent<TestABI>);

	return {
		rowsOn: (stream: string) => rows.get(stream) ?? [],
		append(write: EmissionWrite): void {
			const held = coverage.get(write.stream);
			coverage.set(write.stream, {
				...write.coverage,
				startBlock: held ? held.startBlock : write.coverage.lastFromBlock,
			});
			const on = rows.get(write.stream) ?? [];
			for (const emission of write.emissions) {
				seq++;
				on.push({seq, log: {...emission, removed: !!(emission as {removed?: boolean}).removed} as never});
			}
			rows.set(write.stream, on);
		},
		cursor(): StreamCursorSource {
			return {
				async readStreamCursor({stream, finality}): Promise<StreamCursorRead | undefined> {
					const held = coverage.get(stream);
					if (!held) return undefined;
					const from = Math.max(0, held.lastToBlock - finality);
					return {
						latestBlock: held.latestBlock,
						lastFromBlock: held.lastFromBlock,
						lastToBlock: held.lastToBlock,
						tail: eventsOf((rows.get(stream) ?? []).filter((row) => blockOf(row) >= from)) as never,
					};
				},
			};
		},
		source(): ReplaySource<TestABI> {
			return {
				async readChunk({stream, fromBlock, foldedThrough, maxEmissions}): Promise<ReplayRead<TestABI>> {
					const held = coverage.get(stream);
					if (!held) return {status: 'absent'};
					if (held.startBlock > fromBlock) {
						return {status: 'does-not-reach-back', startBlock: held.startBlock};
					}
					const on = rows.get(stream) ?? [];
					const highWater = on.length === 0 ? 0 : (on[on.length - 1] as {seq: number}).seq;
					const above = on
						.filter((row) => blockOf(row) >= fromBlock)
						.sort((a, b) => blockOf(a) - blockOf(b) || a.seq - b.seq);
					const floor = Math.max(foldedThrough + 1, fromBlock);
					const budgetCut = above.length > maxEmissions ? blockOf(above[maxEmissions] as never) - 1 : held.lastToBlock;
					const lastToBlock = Math.min(held.lastToBlock, Math.max(budgetCut, floor));
					return {
						status: 'chunk',
						eventStream: eventsOf(above.filter((row) => blockOf(row) <= lastToBlock)),
						lastFromBlock: fromBlock,
						lastToBlock,
						latestBlock: held.latestBlock,
						truncated: lastToBlock < held.lastToBlock,
						highWater,
					};
				},
			};
		},
	};
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
	const stream = streams();

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
	function specFor(
		/** WHICH synthetic bundle this fold ARRIVED as: `identityOf` is what a host handed those bytes derives. */
		marker: string,
		namespace: 'own' | {shared: string},
	) {
		return {
			createState: (context: {stream: string}) =>
				storeFor(
					namespace === 'own'
						? generationDigestOf({stream: context.stream, processor: identityOf(marker)})
						: namespace.shared,
				),
			// The identity this fold ARRIVED with (ADR-0086), named from the same expression
			// the namespace above is: ADR-0053's namespace is chosen before the processor
			// exists and must be the one the registered generation owns.
			processorIdentity: identityOf(marker),
			createProcessor: (state: {rows: string[]; lastSync?: LastSync<TestABI>}): EventProcessor<TestABI, void> => {
				const processor: EventProcessor<TestABI, void> = {
					// Answered because the seam requires it, and read by nothing on this side: it
					// names the browser's module arrival and no other (ADR-0086).
					getCodeFingerprint: () => undefined,
					load: async () => (state.lastSync ? {state: undefined as void, lastSync: state.lastSync} : undefined),
					process: async (eventStream, lastSync) => {
						for (const event of eventStream) {
							state.rows.push(`${marker}@${event.blockNumber}`);
						}
						state.lastSync = lastSync;
					},
					reset: async () => {
						state.rows.length = 0;
						state.lastSync = undefined;
					},
					clear: async () => {
						cleared.push(marker);
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
		stream,
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
		// THE STREAM'S THREE ENDS, supplied together because a host that owns the
		// database owns all three (ADR-0087): where it is stored, where it reaches, and
		// how it is read back.
		appendEmissions: (write) => world.stream.append(write),
		streamCursor: world.stream.cursor(),
		replay: world.stream.source(),
		generation: world.specFor(version, 'own'),
	});
}

function batch(
	builder: StreamWriter<TestABI> | StreamBuilder<TestABI, void>,
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
		expect(records.map((record) => record.processor)).toEqual([identityOf('v1'), identityOf('v2')]);
		// the pointer did NOT move: the successor exists beside the live one
		expect(await successor.canonical()).toMatchObject({processor: identityOf('v1')});
		// ADR-0052's one-writer rule, with its subject moved (ADR-0087): NEITHER
		// generation writes the stream, so the successor cannot store a second copy of a
		// history every generation re-folds -- not because it was refused the appender,
		// but because no fold has one. The stream is written by the DEPLOYMENT, and this
		// second container is a second deployment over the same rows, so what it holds at
		// the stream's address is its own writer of the same stream.
		expect(incumbent.held()[0]).not.toHaveProperty('writesStream');
		expect(successor.held()[0]).not.toHaveProperty('writesStream');
		expect(successor.ingestion.streamDigest).toBe(incumbent.ingestion.streamDigest);
	});

	it('does not clear even when the caller handed both folds ONE store, which is the pre-generation database', async () => {
		const world = substrate();
		const incumbent = await openReceivingIndexer({
			port: world.port,
			source: SOURCE,
			stream: {finality: FINALITY},
			appendEmissions: (write) => world.stream.append(write),
			streamCursor: world.stream.cursor(),
			replay: world.stream.source(),
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
			appendEmissions: (write) => world.stream.append(write),
			streamCursor: world.stream.cursor(),
			replay: world.stream.source(),
			generation: world.specFor('v2', {shared: 'legacy'}),
		});
		// RE-SCOPED, and this number IS the change. It used to be `START_BLOCK`, read
		// off the successor's EMPTY state -- which is the duplicate-history defect stated
		// as an assertion: a restarted deployment asking for history the stream already
		// holds, and ADR-0052 appending the re-sent range a second time. The position is
		// the STREAM's now (ADR-0087), so an empty-state successor cannot drag it
		// backwards: it resumes over the reorg window of what is stored and no further.
		expect(await successor.ingestion.expectedFromBlock()).toBe(105 - FINALITY);
		expect(await successor.ingestion.expectedFromBlock()).not.toBe(START_BLOCK);

		expect(world.cleared).toEqual([]);
		expect(world.rowsIn('legacy')).toEqual(['v1@101']);
	});

	it('RESOLVES a context it has already seen rather than registering it twice', async () => {
		const world = substrate();
		await anIndexerThatHasFolded(world);

		const again = await open(world, 'v1');
		await again.ingestion.expectedFromBlock();
		await again.ingestion.expectedFromBlock();

		expect((await again.registry.list()).map((record) => record.processor)).toEqual([identityOf('v1')]);
		expect(await again.canonical()).toMatchObject({processor: identityOf('v1')});
	});

	it('comes back holding the same generations, with the same canonical one, against the same substrate', async () => {
		const world = substrate();
		await anIndexerThatHasFolded(world);
		await open(world, 'v2');

		// a restart is a new container over the same records
		const restarted = await open(world, 'v2');
		expect((await restarted.generations()).map((record) => record.processor)).toEqual([
			identityOf('v1'),
			identityOf('v2'),
		]);
		expect(await restarted.canonical()).toMatchObject({processor: identityOf('v1')});
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
			appendEmissions: (write) => world.stream.append(write),
			streamCursor: world.stream.cursor(),
			replay: world.stream.source(),
			caps: {maxGenerations: 1, maxStreams: 1},
			generation: world.specFor('v2', 'own'),
		});

		await expect(refused).rejects.toBeInstanceOf(GenerationCapReachedError);
		await expect(refused).rejects.toThrow(/maxGenerations of 1/);
		// nothing was evicted and no partial record was left behind
		const registry = await open(world, 'v1');
		expect((await registry.generations()).map((record) => record.processor)).toEqual([identityOf('v1')]);
		expect(await registry.canonical()).toMatchObject({processor: identityOf('v1')});
	});

	it('lets a host that raises the bound past the refusal create the successor', async () => {
		const world = substrate();
		await anIndexerThatHasFolded(world);

		const successor = await openReceivingIndexer({
			port: world.port,
			source: SOURCE,
			stream: {finality: FINALITY},
			appendEmissions: (write) => world.stream.append(write),
			streamCursor: world.stream.cursor(),
			replay: world.stream.source(),
			caps: {maxGenerations: 2, maxStreams: 1},
			generation: world.specFor('v2', 'own'),
		});

		expect((await successor.generations()).map((record) => record.processor)).toEqual([
			identityOf('v1'),
			identityOf('v2'),
		]);
	});
});

/**
 * THE RUNTIME THE `predecessor` SLOT IS STILL FOR (ADR-0089).
 *
 * The chain-facing twin assigns NO `predecessor`, because the code a revert needs
 * is not in a tab's build. That decision is taken by the CONTAINER and passed to
 * the shared registry, so the hazard it carries is a fix applied one level too low:
 * a registry that stopped assigning for everybody would silently close the SERVER's
 * revert window, which is the one place the slot earns its seat -- an operator
 * reverts without redeploying, and the fold they return to arrives by a route a
 * browser does not have.
 *
 * So this is the twin of `container.test.ts`'s `assigns NO predecessor` case, and
 * the pair of them is the assertion: same registry, same move, two runtimes, two
 * answers.
 */
describe('a promotion on the RECEIVING container still opens a revert window', () => {
	it('ASSIGNS `predecessor`, and the pointer moves BACK to what it names', async () => {
		const world = substrate();
		const incumbent = await anIndexerThatHasFolded(world);
		const deployed = await open(world, 'v2');
		const [v1, v2] = await deployed.generations();

		await deployed.promote(v2);

		// the generation the pointer moved OFF is NAMED, in the commit that moved it:
		// that is the fact the rows cannot answer afterwards, and it is what the operator
		// route reports and reverts to
		expect(await deployed.slots()).toMatchObject({canonical: v2, predecessor: v1});
		expect(await deployed.canonical()).toMatchObject({processor: identityOf('v2')});

		// ...and the way back is real: one small write, no re-index, and the state the
		// incumbent folded is exactly where it was
		await deployed.promote((await deployed.slots()).predecessor as GenerationRecord);
		expect(await deployed.canonical()).toMatchObject({processor: identityOf('v1')});
		expect(await deployed.slots()).toMatchObject({canonical: v1, predecessor: v2});
		expect(world.rowsIn(generationDigestOf(incumbent.generation))).toEqual(['v1@101']);
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
		// so the container holds a SECOND writer, at a second address: one per stream
		// it holds a fold on (ADR-0087), and the batches of one cannot reach the other
		const live = await incumbent.liveIngestions();
		expect(live.map((one) => one.streamDigest).sort()).toEqual([incumbent.streamDigest, successor.streamDigest].sort());
		const other = live.find((one) => one.streamDigest === successor.streamDigest);
		expect(other?.context).not.toEqual(incumbent.ingestion.context);
		// two generations, on two streams. `createdAt` is strictly increasing since
		// ADR-0072, so the listing's order is defined now rather than tied -- but what
		// this case is about is MEMBERSHIP, so what is asserted is still the SET.
		expect((await incumbent.generations()).map((record) => record.stream).sort()).toEqual(
			[incumbent.streamDigest, successor.streamDigest].sort(),
		);
	});

	it('REFUSES ANY fold when it was given no stream to re-fold', async () => {
		// RE-SCOPED. This used to be a refusal about the SECOND fold on a stream: the
		// first was fed by the wire and only a follower needed something to re-fold. That
		// asymmetry went with the election (ADR-0087) -- EVERY generation here reads the
		// stored stream the deployment fetches -- so a container with no `replay` can hold
		// no fold at all, and the refusal is at `open` rather than on the successor.
		const world = substrate();

		const refused = openReceivingIndexer({
			port: world.port,
			source: SOURCE,
			stream: {finality: FINALITY},
			appendEmissions: (write) => world.stream.append(write),
			streamCursor: world.stream.cursor(),
			generation: world.specFor('v1', 'own'),
		});

		await expect(refused).rejects.toThrow(/no `replay` source/);
		await expect(refused).rejects.toThrow(/could never advance/);
		expect(await world.port.read()).toMatchObject({generations: []});
	});

	it('REFUSES a container that could fetch nothing, rather than folding for ever on stale history', async () => {
		// The failure ADR-0087's second amendment MEASURED, refused at the seam: a
		// deployment that folds and never fetches is promoted, serves reads and reports
		// healthy while asking the node for `["eth_chainId"]` and nothing else, for ever.
		const world = substrate();

		await expect(
			openReceivingIndexer({
				port: world.port,
				source: SOURCE,
				stream: {finality: FINALITY},
				replay: world.stream.source(),
				generation: world.specFor('v1', 'own'),
			}),
		).rejects.toThrow(/no way to write the stream it would fetch/);

		await expect(
			openReceivingIndexer({
				port: world.port,
				source: SOURCE,
				stream: {finality: FINALITY},
				appendEmissions: (write) => world.stream.append(write),
				replay: world.stream.source(),
				generation: world.specFor('v1', 'own'),
			}),
		).rejects.toThrow(/`streamCursor`/);
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

	/**
	 * WHICH GENERATION ANSWERS is the REGISTRY's answer, including when it has none.
	 *
	 * The container used to fall back to the fold it opened with, which made a host
	 * holding an engine answer reads from a generation the pointer does not name while
	 * a read tier over the same rows refused (ADR-0058). One database must not have two
	 * answers depending on who is asking.
	 */
	it('answers NONE where the registry names none, rather than falling back to its opening fold', async () => {
		const world = substrate();
		/**
		 * A substrate whose POINTER names a generation the RECORDS do not have.
		 *
		 * `openGenerationRegistry.canonical()` resolves the pointer against the records,
		 * so this is what it means for it to answer nothing while generations exist. It
		 * is simulated at the PORT because the registry itself refuses to produce it --
		 * deleting the canonical generation is refused by its own rules -- so the only
		 * way in is out of band: another process, or a half-written substrate. That is
		 * exactly the case the old fallback quietly served a read for.
		 */
		let detachPointer = false;
		const port: GenerationRegistryPort = {
			...world.port,
			read: async () => {
				const state = await world.port.read();
				return detachPointer
					? {...state, slots: {...state.slots, canonical: {stream: 'gone', processor: 'gone'}}}
					: state;
			},
		};
		const incumbent = await openReceivingIndexer({
			port,
			source: SOURCE,
			stream: {finality: FINALITY},
			appendEmissions: (write) => world.stream.append(write),
			streamCursor: world.stream.cursor(),
			replay: world.stream.source(),
			generation: world.specFor('v1', 'own'),
		});
		expect(await incumbent.canonicalGeneration()).toEqual(incumbent.generation);

		detachPointer = true;

		expect(await incumbent.canonicalGeneration()).toBeUndefined();
		// and specifically NOT the opening fold, which is what the fallback answered:
		// a generation the pointer does not name, served as though it did
		expect(await incumbent.canonicalGeneration()).not.toEqual(incumbent.generation);
		// the container still HOLDS its fold. This says which generation ANSWERS, not
		// which ones exist, so nothing stops folding.
		expect(incumbent.held().length).toBe(1);
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
		const bare = new StreamBuilder<TestABI, void>(processor, SOURCE, {
			stream: {finality: FINALITY},
			processorIdentity: identityOf('v2'),
		});

		expect(await bare.expectedFromBlock()).toBe(START_BLOCK);
		expect(world.cleared).toEqual(['v2']);
		expect(world.rowsIn(namespace)).toEqual([]);
	});
});
