import type {Abi} from 'abitype';
import type {EmissionWrite, StreamCoverage} from '../../src/emissionStream.js';
import {generationDigestOf} from '../../src/generation/identity.js';
import {createMemoryGenerationRegistryPort} from '../../src/generation/memory.js';
import type {RebuildReport, ReplayRead, ReplaySource} from '../../src/generation/rebuild.js';
import type {GenerationRegistryPort} from '../../src/generation/registry.js';
import {
	openReceivingIndexer,
	type ReceivingIndexer,
	type ReceivingIndexerOptions,
} from '../../src/receivingContainer.js';
import type {StreamCursorRead, StreamCursorSource} from '../../src/stream/writer.js';
import type {
	EmittedLog,
	EventProcessor,
	FoldReporter,
	IndexingSource,
	LastSync,
	LogEvent,
	StoredLogEvent,
	WireBatch,
} from '../../src/types.js';
import {taggedBnReplacer, taggedBnReviver} from '../../src/utils/bigint.js';
import {appliedBlocksOf, forkPointOf} from './stateMovedWorld.js';
import {arrivalOf, identityOf} from './processorIdentity.js';

// ---------------------------------------------------------------------------------------------------
// THE WORLD A RECEIVING CONTAINER RUNS IN: a stored stream, a registry substrate,
// and a state store per generation
// ---------------------------------------------------------------------------------------------------
// One named indexer's DURABLE world, in memory: the ADR-0006 emission stream
// with its coverage claim beside it, the reference registry port, and a state
// store per GENERATION NAMESPACE (ADR-0053). A container over it is a new object
// graph every time, over the same durable rows, which is what lets a test drive
// chunk after chunk through a FRESH process.
//
// It lives here rather than inside one suite because TWO files now ask the same
// questions of it -- the bounded rebuild (`rebuild.test.ts`) and the way BACK
// (`theCanonicalPointerMovesBack.test.ts`) -- and a second copy of the stored
// stream would be a second definition of what a reorg, a quiet range and a
// coverage claim MEAN in a test, which is the only thing several of those
// assertions can be made against. It is the same reasoning `streamCacheWorld.ts`
// is here for.
//
// The stream is written by a REAL `StreamBuilder` fed real batches, including a
// REORG and a QUIET range, so what is re-folded is what a deployment actually
// stores rather than a fixture written to suit the reader. What the SQL
// substrate adds -- rows, the coverage claim, the bounded read's block-boundary
// cut -- is asserted in `packages/server/test/rebuildInBoundedChunks.test.ts`.
// ---------------------------------------------------------------------------------------------------

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

export const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;
export const START_BLOCK = 100;
export const FINALITY = 3;

export const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

let logCounter = 0;

/** A REAL raw log with real topics, so `reparse` decodes it rather than recording a decode error. */
export function transfer(blockNumber: number, blockHash: string, id: bigint, logIndex = 0): LogEvent<TestABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash,
		transactionIndex: 0,
		removed: false,
		address: CONTRACT,
		data: `0x${id.toString(16).padStart(64, '0')}`,
		topics: [TRANSFER_TOPIC0, pad(CONTRACT), pad(CONTRACT)],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex,
		extra: undefined,
	} as unknown as LogEvent<TestABI>;
}

function pad(address: string): string {
	return `0x${address.slice(2).padStart(64, '0')}`;
}

/** What ONE emission is, for comparing a fold against a re-fold. */
export function idOf(event: {blockNumber: number; blockHash: string; logIndex: number}): string {
	return `${event.blockNumber}:${event.blockHash}:${event.logIndex}`;
}

// ---------------------------------------------------------------------------------------------------
// THE STORED STREAM, in memory, with the two things the real one has
// ---------------------------------------------------------------------------------------------------

export type StoredRow = {seq: number; log: EmittedLog};

/**
 * The emission stream of one named indexer, as ADR-0006's table holds it: rows
 * in `seq` order with retractions INCLUDED, plus the COVERAGE CLAIM beside them,
 * which is the only thing that can say how far a quiet range carried the stream.
 *
 * Only the RAW log is kept, exactly as the columns do: `args` and `eventName`
 * are what SOME ABI made of those bytes (ADR-0034) and a replay decodes again.
 */
export function storedStream() {
	const rows: StoredRow[] = [];
	let coverage: (StreamCoverage & {startBlock: number}) | undefined;
	let seq = 0;

	return {
		get rows() {
			return rows;
		},
		/** A byte comparison, so "the re-fold wrote nothing" is not a row count. */
		snapshot: () => JSON.stringify({rows, coverage}),
		/**
		 * Move the stream's OWN start block up, which is what a SEEDED stream looks
		 * like: it opens at the capture's `fromBlock` rather than at the source's first
		 * block. A follower resuming from a fresh checkpoint then asks from lower than
		 * the stream reaches, which is the shape ADR-0070 exists for.
		 */
		opensAt(startBlock: number): void {
			if (coverage) coverage = {...coverage, startBlock};
		},
		append(write: EmissionWrite): void {
			coverage = coverage
				? {...write.coverage, startBlock: coverage.startBlock}
				: {...write.coverage, startBlock: write.coverage.lastFromBlock};
			for (const emission of write.emissions) {
				seq++;
				const {blockNumber, blockHash, logIndex, transactionHash, transactionIndex, address, topics, data, removed} =
					emission as EmittedLog & {removed?: boolean};
				rows.push({
					seq,
					log: {
						blockNumber,
						blockHash,
						logIndex,
						transactionHash,
						transactionIndex,
						address,
						topics,
						data,
						removed: removed ? true : false,
					} as unknown as EmittedLog,
				});
			}
		},
		/**
		 * WHERE THE STREAM'S OWN POSITION IS READ, in the shape `@etherfold/server`
		 * implements over SQL (ADR-0087).
		 *
		 * The WRITER's half of these same rows: the coverage claim, and the TAIL above
		 * the reorg window that the unconfirmed window is walked out of. NOTHING where no
		 * batch has ever been stored, which is the documented ABSENCE of a stream and is
		 * what keeps the first save of a fresh deployment permissive.
		 */
		cursor(): StreamCursorSource {
			return {
				async readStreamCursor({finality}): Promise<StreamCursorRead | undefined> {
					if (!coverage) return undefined;
					const from = Math.max(0, coverage.lastToBlock - finality);
					return {
						latestBlock: coverage.latestBlock,
						lastFromBlock: coverage.lastFromBlock,
						lastToBlock: coverage.lastToBlock,
						tail: eventsOf(rows.filter((row) => blockOf(row) >= from)) as unknown as StoredLogEvent[],
					};
				},
			};
		},
		/**
		 * The BOUNDED read, in the shape `@etherfold/server` implements over SQL: a
		 * budget in emissions, cut on a BLOCK boundary (a block is the indivisible unit
		 * of a `seq`-ordered stream carrying reorgs) and never at or below what the fold
		 * already covers (or a fold inside the reorg window would never advance).
		 */
		source(): ReplaySource<TestABI> {
			return {
				async readChunk({fromBlock, foldedThrough, maxEmissions}): Promise<ReplayRead<TestABI>> {
					// the two answers this double used to collapse into `undefined`, which is
					// why nothing caught the port collapsing them either (ADR-0070)
					if (!coverage) return {status: 'absent'};
					if (coverage.startBlock > fromBlock) {
						return {status: 'does-not-reach-back', startBlock: coverage.startBlock};
					}
					const highWater = rows.length === 0 ? 0 : (rows[rows.length - 1] as StoredRow).seq;
					const above = rows
						.filter((row) => blockOf(row) >= fromBlock)
						.sort((a, b) => blockOf(a) - blockOf(b) || a.seq - b.seq);
					const floor = Math.max(foldedThrough + 1, fromBlock);
					const budgetCut =
						above.length > maxEmissions ? blockOf(above[maxEmissions] as StoredRow) - 1 : coverage.lastToBlock;
					const lastToBlock = Math.min(coverage.lastToBlock, Math.max(budgetCut, floor));
					return {
						status: 'chunk',
						eventStream: eventsOf(above.filter((row) => blockOf(row) <= lastToBlock)),
						lastFromBlock: fromBlock,
						lastToBlock,
						latestBlock: coverage.latestBlock,
						truncated: lastToBlock < coverage.lastToBlock,
						highWater,
					};
				},
			};
		},
	};
}

function blockOf(row: StoredRow): number {
	return (row.log as unknown as {blockNumber: number}).blockNumber;
}

function eventsOf(rows: readonly StoredRow[]): LogEvent<TestABI>[] {
	return [...rows].sort((a, b) => a.seq - b.seq).map((row) => ({...row.log}) as unknown as LogEvent<TestABI>);
}

// ---------------------------------------------------------------------------------------------------
// THE SUBSTRATE: one named indexer's records, and a state store per NAMESPACE
// ---------------------------------------------------------------------------------------------------

export type MemoryStore = {rows: string[]; lastSync?: LastSync<TestABI>};

/**
 * The one entity name the folds in this world report touching.
 *
 * A CONSTANT on purpose: the entity set is produced one package down, from real
 * mutations, and is asserted where it is produced
 * (`@etherfold/conformance-workload-stratagems`). What this world exists to ask
 * is the CONTAINER's half -- which reports become notifications, for which
 * generation, and what the token does -- so the folds here report a name of
 * their own and the generation digest is what tells two of them apart.
 */
export const REPORTED_ENTITY = 'row';

/**
 * A fold whose state is a list of emission ids and whose REVERT IS EXACT, so
 * "the re-fold reproduces the original state" is a real claim rather than one an
 * approximate revert could pass by luck.
 *
 * It persists its cursor WITH its state, which is the whole of the checkpoint:
 * the driver keeps no position of its own, and a store that wrote one without
 * the other is exactly what ADR-0027 puts behind the storage seam to prevent.
 */
function foldingProcessor(marker: string, store: MemoryStore, weight: number): EventProcessor<TestABI, string[]> {
	let reporter: FoldReporter | undefined;
	return {
		getCodeFingerprint: () => undefined,
		load: async () => (store.lastSync ? {state: store.rows, lastSync: clone(store.lastSync)} : undefined),
		process: async (eventStream, lastSync) => {
			// REPORTED from inside `process()`, in the order and at the place the shipped
			// entity fold reports from: the retraction ONCE, at the fork point, before
			// anything is applied, then one report per block applied.
			const fork = forkPointOf(eventStream);
			if (fork !== undefined) reporter?.({kind: 'retracted', forkPoint: fork});
			for (const event of eventStream) {
				const mark = `${idOf(event)}x${weight}`;
				if (event.removed) {
					const at = store.rows.lastIndexOf(mark);
					if (at >= 0) store.rows.splice(at, 1);
				} else {
					store.rows.push(mark);
				}
			}
			for (const block of appliedBlocksOf(eventStream)) {
				reporter?.({kind: 'applied', block: block.number, entities: [REPORTED_ENTITY]});
			}
			// the state and the CHECKPOINT, together, which is what makes a kill between
			// two chunks resume rather than re-apply or skip
			store.lastSync = clone(lastSync);
			return store.rows;
		},
		reset: async () => {
			store.rows.length = 0;
			store.lastSync = undefined;
		},
		clear: async () => {
			store.rows.length = 0;
			store.lastSync = undefined;
		},
		setFoldReporter: (next) => {
			reporter = next;
		},
	};
}

/**
 * Through the repo's own codec, because a replayed window holds DECODED events
 * and every `uint256` in them is a BigInt that `JSON.stringify` throws on.
 */
function clone(lastSync: LastSync<TestABI>): LastSync<TestABI> {
	return JSON.parse(JSON.stringify(lastSync, taggedBnReplacer), taggedBnReviver) as LastSync<TestABI>;
}

/** One named indexer's DURABLE world: the registry records, the stream, and a store per namespace. */
export function world() {
	// The HOST supplies both STATE seams, because the host is what named the
	// namespaces (ADR-0053) and this substrate holds only the records: how a
	// generation's store is dropped, and how far the fold in it got. The second is
	// what a promotion compares, and it is answered for a generation NOBODY HOLDS A
	// FOLD FOR -- which is the restart shape, and the one the container itself could
	// never have answered.
	const port: GenerationRegistryPort = createMemoryGenerationRegistryPort({
		readStateCursor: async (id) => stores.get(generationDigestOf(id))?.lastSync?.lastToBlock,
	});
	const stream = storedStream();
	const stores = new Map<string, MemoryStore>();

	function rowsUnder(processorIdentity: string, streamDigest: string): string[] {
		return storeFor(generationDigestOf({stream: streamDigest, processor: processorIdentity})).rows;
	}

	function storeFor(namespace: string): MemoryStore {
		let store = stores.get(namespace);
		if (!store) {
			store = {rows: []};
			stores.set(namespace, store);
		}
		return store;
	}

	/**
	 * A fold, as the container builds one: the state FIRST, then the processor over
	 * it (ADR-0043), under the identity its ARRIVAL supplied.
	 *
	 * `marker` names some synthetic BYTES rather than a declared version (ADR-0086:
	 * an author cannot state an identity), and `identityOf` is what a deployment
	 * handed those bytes would have derived. It is the SAME expression in both
	 * factories, because ADR-0053's namespace is named before the processor exists
	 * and must be the namespace the registered generation owns.
	 */
	function specFor(marker: string, weight: number) {
		weights.set(marker, weight);
		return {
			createState: (context: {stream: string}) =>
				storeFor(generationDigestOf({stream: context.stream, processor: identityOf(marker)})),
			createProcessor: (state: MemoryStore) => foldingProcessor(marker, state, weight),
			// the identity AND the bytes it names, as a Node deployment's arrival hands them
			// over: registering stores the bundle beside the generation (ADR-0092)
			...arrivalOf(marker),
		};
	}

	/**
	 * EVERY REORG ANY FOLD IN THIS WORLD CONCLUDED, in the order it was counted.
	 *
	 * The counters are per NAMED INDEXER and shared across its generations (ADR-0050),
	 * so this is the one place a double count would show up.
	 */
	const reorgs: {blockNumber: number}[] = [];

	/** The weight each marker's fold was first built with, so a fold INSTANTIATED from its bytes folds the same way. */
	const weights = new Map<string, number>();

	/**
	 * THE HOST'S HALF OF ADR-0092 in this world: how STORED BYTES become a fold.
	 *
	 * The bytes are `bundleBytes(marker)`, so the marker is read back out of them --
	 * which is this world's loader, standing where `loadProcessorArtifact` stands on a
	 * Node deployment. Every call is recorded, so a suite can say WHEN a generation was
	 * instantiated and from WHICH bytes.
	 */
	const instantiated: {processor: string; bundle: Uint8Array}[] = [];
	async function instantiateFromBundle(
		id: {stream: string; processor: string},
		bundle: Uint8Array,
	): Promise<ReturnType<typeof specFor>> {
		instantiated.push({processor: id.processor, bundle});
		const marker = /marker:"([^"]*)"/.exec(new TextDecoder().decode(bundle))?.[1];
		if (marker === undefined) throw new Error(`these bytes are not a processor this world can build`);
		return specFor(marker, weights.get(marker) ?? 1);
	}

	/** A CONTAINER over this world: a new object graph every time, over the same durable rows. */
	function open(
		marker: string,
		weight: number,
		extra: Partial<ReceivingIndexerOptions<TestABI, string[], MemoryStore>> = {},
	): Promise<ReceivingIndexer<TestABI, string[], MemoryStore>> {
		return openReceivingIndexer<TestABI, string[], MemoryStore>({
			port,
			source: SOURCE,
			stream: {finality: FINALITY},
			// THE STREAM'S THREE ENDS, which is what a host supplies now: where it is
			// STORED, where it REACHES (which is what positions the fetch), and how it is READ
			// BACK so every generation over it can re-fold it.
			appendEmissions: (write) => stream.append(write),
			streamCursor: stream.cursor(),
			replay: stream.source(),
			recordReorg: async (reorg) => {
				reorgs.push({blockNumber: reorg.blockNumber});
			},
			generation: specFor(marker, weight),
			...extra,
		});
	}

	return {
		port,
		instantiateFromBundle,
		instantiated,
		stream,
		stores,
		specFor,
		open,
		reorgs,
		/** The rows a fold built from `bundleBytes(marker)` folded into. */
		rowsIn: (marker: string, streamDigest: string) => rowsUnder(identityOf(marker), streamDigest),
		/** The same rows, addressed by the IDENTITY itself, which is what a registry record carries. */
		rowsUnder,
	};
}

export type World = ReturnType<typeof world>;

/**
 * THE REPORT FOR ONE GENERATION, picked out of what `rebuildMore` answered.
 *
 * `rebuildMore` reports one entry per FOLD HELD, and since ADR-0087 that is every
 * generation this container holds rather than the followers alone: no generation
 * fetches, so every one of them advances by re-folding the stream the deployment
 * stored. `reports[0]` therefore names whichever fold was added first, which is
 * almost never the one a catch-up assertion is about -- so a test names the
 * generation it means.
 */
export function reportFor(reports: readonly RebuildReport[], marker: string): RebuildReport | undefined {
	return reports.find((report) => report.generation.processor === identityOf(marker));
}

export function batch(
	indexer: ReceivingIndexer<TestABI, string[], MemoryStore>,
	over: {toBlock: number; latestBlock: number; logs: LogEvent<TestABI>[]},
	fromBlock: number,
): WireBatch<TestABI> {
	return {
		context: indexer.ingestion.context,
		fromBlock,
		toBlock: over.toBlock,
		latestBlock: over.latestBlock,
		logs: over.logs.map((event) => ({...event})),
	};
}

// The fixture: a history, a REORG that retracts a block and replaces it, and a
// QUIET range that carries no logs at all and still moves the coverage claim.
export const AT_101 = transfer(101, '0xa101', 1n);
export const DEAD_104 = transfer(104, '0xa104', 2n);
export const REORGED_104 = transfer(104, '0xb104', 3n);
export const AT_106 = transfer(106, '0xa106', 4n);

/** A world whose incumbent has folded the fixture and stored its emission stream. */
export async function anIncumbentThatHasFolded(): Promise<{
	world: World;
	incumbent: ReceivingIndexer<TestABI, string[], MemoryStore>;
}> {
	const w = world();
	const incumbent = await w.open('v1', 1);
	const push = async (over: {toBlock: number; latestBlock: number; logs: LogEvent<TestABI>[]}) => {
		const fromBlock = await incumbent.ingestion.expectedFromBlock();
		await incumbent.ingestion.receive(batch(incumbent, over, fromBlock));
	};
	// [100, 105]: the history
	await push({toBlock: 105, latestBlock: 105, logs: [AT_101, DEAD_104]});
	// [102, 106]: 104 comes back with a different hash -- a contradiction, so the dead
	// block is retracted and the replacement applied
	await push({toBlock: 106, latestBlock: 106, logs: [REORGED_104, AT_106]});
	// [103, 110]: the window re-delivered unchanged and nothing new. The cursor moves
	// to 110 and the stream gains no row.
	await push({toBlock: 110, latestBlock: 110, logs: [REORGED_104, AT_106]});
	return {world: w, incumbent};
}

/** The state the CANONICAL generation answers from, resolved through the pointer (ADR-0053). */
export async function canonicalAnswers(
	w: World,
	indexer: ReceivingIndexer<TestABI, string[], MemoryStore>,
): Promise<string[]> {
	const canonical = await indexer.canonical();
	if (!canonical) throw new Error('no canonical generation');
	// By IDENTITY, because that is what the record carries: nothing may map a
	// registered identity back to the marker that produced it except a test that
	// already knows the marker.
	return [...w.rowsUnder(canonical.processor, canonical.stream)];
}
