import type {Abi} from 'abitype';
import {beforeEach, describe, expect, it} from 'vitest';
import {IndexerGeneration} from '../src/indexer.js';
import {InvalidBatchError, UnexpectedFromBlockError, WireContextMismatchError} from '../src/errors.js';
import {StreamBuilder, parseWireBatch, serializeWireBatch} from '../src/streamBuilder.js';
import type {ReorgDetection} from '../src/index.js';
import type {EmittedLog, EventProcessor, IndexingSource, LastSync, LogEvent, WireBatch} from '../src/types.js';

// ---------------------------------------------------------------------------
// THE RECEIVING SIDE OF THE WIRE (ADR-0004)
// ---------------------------------------------------------------------------
// `StreamBuilder` is the half of the split deployment that owns the cursor: it
// holds no provider, derives every reorg itself, and refuses a batch that does
// not start where it says it must. What is asserted here is the CONTRACT, and
// in particular the two properties an HTTP layer on top can only preserve, never
// create:
//
//   1. a batch starting anywhere but `expectedFromBlock` applies NOTHING, and
//   2. the stream it derives is the SAME one `IndexerGeneration` derives from the
//      same logs, because both go through `generateStreamToAppend`.
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

const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const START_BLOCK = 100;
const FINALITY = 3;

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

let logCounter = 0;

function transfer(blockNumber: number, blockHash: string, id: bigint, logIndex = 0): LogEvent<TestABI> {
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
		logIndex,
		extra: undefined,
		eventName: 'Transfer',
		args: {from: CONTRACT, to: CONTRACT, id},
	} as unknown as LogEvent<TestABI>;
}

/**
 * An `EventProcessor` that keeps its cursor in memory and records every stream
 * it is handed.
 *
 * It is the smallest thing that can play the part: the builder only ever asks it
 * for a persisted cursor and hands it a stream, so anything more would be
 * asserting a store rather than the wire.
 */
function recordingProcessor(versionHash = 'v1') {
	const streams: LogEvent<TestABI>[][] = [];
	let stored: LastSync<TestABI> | undefined;
	let cleared = 0;
	const processor: EventProcessor<TestABI, void> = {
		getVersionHash: () => versionHash,
		getCodeFingerprint: () => undefined,
		load: async () => (stored ? {state: undefined as void, lastSync: stored} : undefined),
		process: async (eventStream, lastSync) => {
			streams.push(eventStream);
			stored = lastSync;
		},
		reset: async () => {
			streams.length = 0;
			stored = undefined;
			cleared++;
		},
		clear: async () => processor.reset(),
	};
	return {
		processor,
		streams,
		get cleared() {
			return cleared;
		},
		get lastSync() {
			return stored;
		},
		set lastSync(value: LastSync<TestABI> | undefined) {
			stored = value;
		},
		/** Every event ever handed over, in order: the derived stream, concatenated. */
		flat: () => streams.flat(),
	};
}

function builderOn(processor: EventProcessor<TestABI, void>): StreamBuilder<TestABI, void> {
	return new StreamBuilder(processor, SOURCE, {stream: {finality: FINALITY}});
}

function batch(
	builder: StreamBuilder<TestABI, void>,
	over: Partial<WireBatch<TestABI>> & Pick<WireBatch<TestABI>, 'fromBlock' | 'toBlock' | 'latestBlock'>,
): WireBatch<TestABI> {
	return {context: builder.context, logs: [], ...over};
}

describe('the receiver owns the cursor', () => {
	let target: ReturnType<typeof recordingProcessor>;
	let builder: StreamBuilder<TestABI, void>;

	beforeEach(() => {
		target = recordingProcessor();
		builder = builderOn(target.processor);
	});

	it('expects the source start block before anything has been indexed', async () => {
		expect(await builder.expectedFromBlock()).toBe(START_BLOCK);
	});

	it('applies a batch starting exactly there, advancing state and the cursor together', async () => {
		const result = await builder.receive(
			batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105, logs: [transfer(102, '0xa102', 1n)]}),
		);

		expect(result.applied).toBe(1);
		expect(result.retracted).toBe(0);
		expect(target.flat()).toHaveLength(1);
		expect(target.lastSync?.lastToBlock).toBe(105);
		// the next one must re-scan the unconfirmed window: latestBlock - finality
		expect(result.expectedFromBlock).toBe(102);
		expect(await builder.expectedFromBlock()).toBe(102);
	});

	it('refuses a batch starting anywhere else, applying nothing', async () => {
		await builder.receive(batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105}));

		const gap = batch(builder, {fromBlock: 106, toBlock: 110, latestBlock: 110, logs: [transfer(107, '0xa107', 9n)]});
		await expect(builder.receive(gap)).rejects.toBeInstanceOf(UnexpectedFromBlockError);

		const before = target.lastSync;
		await builder.receive(gap).catch((err: UnexpectedFromBlockError) => {
			expect(err.expectedFromBlock).toBe(102);
			expect(err.receivedFromBlock).toBe(106);
		});
		// nothing moved: the cursor is where the refusal said it was
		expect(target.lastSync).toEqual(before);
		expect(target.flat()).toHaveLength(0);
	});

	it('refuses a re-sent batch rather than applying it twice, which is why there is no dedupe table', async () => {
		const first = batch(builder, {
			fromBlock: 100,
			toBlock: 105,
			latestBlock: 105,
			logs: [transfer(102, '0xa102', 1n)],
		});
		await builder.receive(first);
		expect(target.flat()).toHaveLength(1);

		// the acknowledgement was lost and the fetcher re-sent: the cursor IS the
		// idempotency key, so this fails the check and is corrected
		const err = await builder.receive(first).catch((e) => e);
		expect(err).toBeInstanceOf(UnexpectedFromBlockError);
		expect(err.expectedFromBlock).toBe(102);
		expect(target.flat()).toHaveLength(1);
	});

	it('is refused by the underlying primitive too, so the two cannot drift apart', async () => {
		// `expectedFromBlock` and `generateStreamToAppend` both read `getFromBlock`,
		// and this is what pins that they are the same answer: the builder's refusal
		// is not a second, parallel check that could disagree with the engine's.
		await builder.receive(batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105}));
		const expected = await builder.expectedFromBlock();

		const indexer = new IndexerGeneration<TestABI, void>(noChain(), recordingProcessor().processor, SOURCE, {
			stream: {finality: FINALITY},
		});
		await indexer.feed([], {
			context: {source: builder.context.source, config: builder.context.config, processor: 'v1'},
			latestBlock: 105,
			lastFromBlock: START_BLOCK,
			lastToBlock: 105,
			unconfirmedBlocks: [],
		});
		expect(indexer.expectedFromBlock).toBe(expected);
	});
});

describe('the receiver says WHICH GENERATION it is', () => {
	// a HOST is who reports an answer's identity outward -- `@etherfold/server`
	// advertises it on every feed response -- and the processor is the one thing a
	// host cannot see: it hands one over at construction and then holds an
	// interface that never mentions it again
	it('is the stream it folds, plus the fold over it', () => {
		const target = recordingProcessor('v1');
		const builder = builderOn(target.processor);

		expect(builder.generation).toEqual({stream: builder.streamDigest, processor: 'v1'});
	});

	it('reads the fold LIVE, so a processor reconfigured after construction is not misreported', () => {
		// `getVersionHash()` covers a processor's CONFIG as well as its version, and
		// `configure()` can move it after this object was built. A value snapshotted in
		// the constructor would advertise a fold that is no longer running, which is
		// worse than advertising nothing.
		let version = 'v1';
		const target = recordingProcessor();
		const builder = builderOn({...target.processor, getVersionHash: () => version});
		expect(builder.generation.processor).toBe('v1');

		version = 'v2';

		expect(builder.generation.processor).toBe('v2');
		expect(builder.generation.stream).toBe(builder.streamDigest);
	});
});

describe('the context is validated on every batch', () => {
	it('refuses a batch belonging to another source, loudly and distinctly', async () => {
		const target = recordingProcessor();
		const builder = builderOn(target.processor);

		const foreign = {
			...batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105, logs: [transfer(101, '0xa101', 1n)]}),
			context: {source: [{startBlock: 0, hash: 'someone-elses'}], config: builder.context.config},
		};
		const err = await builder.receive(foreign).catch((e) => e);
		expect(err).toBeInstanceOf(WireContextMismatchError);
		// distinct from the cursor refusal, which a sender RECOVERS from by re-sending
		expect(err).not.toBeInstanceOf(UnexpectedFromBlockError);
		expect(target.flat()).toHaveLength(0);
	});

	it('refuses a batch belonging to another stream config', async () => {
		const target = recordingProcessor();
		const builder = builderOn(target.processor);
		const foreign = {
			...batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105}),
			context: {source: builder.context.source, config: 'someone-elses'},
		};
		await expect(builder.receive(foreign)).rejects.toBeInstanceOf(WireContextMismatchError);
	});

	it('checks the context BEFORE the cursor, so a foreign batch is never told to resume', async () => {
		const target = recordingProcessor();
		const builder = builderOn(target.processor);
		const foreign = {
			...batch(builder, {fromBlock: 999, toBlock: 1000, latestBlock: 1000}),
			context: {source: builder.context.source, config: 'someone-elses'},
		};
		await expect(builder.receive(foreign)).rejects.toBeInstanceOf(WireContextMismatchError);
	});

	it('discards a persisted cursor that belongs to another source, instead of resuming on top of it', async () => {
		// the hole `docs/reviews/todo-triage.md` found in every persistence layer:
		// a stored `lastSync` adopted without checking whose it is.
		const target = recordingProcessor();
		target.lastSync = {
			context: {source: [{startBlock: 0, hash: 'another-source'}], config: 'another-config', processor: 'v1'},
			latestBlock: 5000,
			lastFromBlock: 4000,
			lastToBlock: 5000,
			unconfirmedBlocks: [],
		};
		const builder = builderOn(target.processor);

		expect(await builder.expectedFromBlock()).toBe(START_BLOCK);
		expect(target.cleared).toBe(1);
	});

	it('discards a persisted cursor written by another processor version', async () => {
		const target = recordingProcessor('v2');
		const builder = builderOn(target.processor);
		await builder.receive(batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105}));
		expect(await builder.expectedFromBlock()).toBe(102);

		// same source and config, different processor: the state means something else
		const upgraded = new StreamBuilder<TestABI, void>({...target.processor, getVersionHash: () => 'v3'}, SOURCE, {
			stream: {finality: FINALITY},
		});
		expect(await upgraded.expectedFromBlock()).toBe(START_BLOCK);
		expect(target.cleared).toBe(1);
	});
});

describe('the envelope is checked before anything is applied', () => {
	let target: ReturnType<typeof recordingProcessor>;
	let builder: StreamBuilder<TestABI, void>;

	beforeEach(() => {
		target = recordingProcessor();
		builder = builderOn(target.processor);
	});

	it('refuses a range that runs backwards', async () => {
		await expect(
			builder.receive(batch(builder, {fromBlock: 100, toBlock: 99, latestBlock: 105})),
		).rejects.toBeInstanceOf(InvalidBatchError);
	});

	it('refuses a range claiming blocks above the chain tip it reports', async () => {
		await expect(
			builder.receive(batch(builder, {fromBlock: 100, toBlock: 110, latestBlock: 105})),
		).rejects.toBeInstanceOf(InvalidBatchError);
	});

	it('refuses a payload whose blocks do not ascend, rather than dropping the late one', async () => {
		// The receiver reads the payload IN ORDER: with an empty window the first
		// group's number becomes the boundary above which events are new, so a lower
		// block arriving later is silently discarded and the window it builds is left
		// unordered for the next cycle too. Refused rather than sorted, because a node
		// answers `eth_getLogs` in ascending order and anything else means something
		// upstream reordered them.
		await expect(
			builder.receive(
				batch(builder, {
					fromBlock: 100,
					toBlock: 110,
					latestBlock: 115,
					logs: [transfer(105, '0xC', 2n), transfer(101, '0xA', 1n)],
				}),
			),
		).rejects.toThrow(/log at block 101 after one at block 105/);
		expect(target.streams).toEqual([]);
	});

	it('accepts repeats WITHIN one block, which is ordinary', async () => {
		await expect(
			builder.receive(
				batch(builder, {
					fromBlock: 100,
					toBlock: 110,
					latestBlock: 115,
					logs: [transfer(101, '0xA', 1n, 0), transfer(101, '0xA', 2n, 1), transfer(105, '0xC', 3n)],
				}),
			),
		).resolves.toBeDefined();
	});

	it('refuses a log outside the range it claims to cover', async () => {
		// completeness is an invariant, not a flag: a payload holds every log in
		// [fromBlock, toBlock] and nothing else, and truncation is a LOWER toBlock.
		const err = await builder
			.receive(batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105, logs: [transfer(106, '0xa106', 1n)]}))
			.catch((e) => e);
		expect(err).toBeInstanceOf(InvalidBatchError);
		expect(target.flat()).toHaveLength(0);
	});

	it('refuses a log already marked removed: no reorg information crosses the wire', async () => {
		const removed = {...transfer(101, '0xa101', 1n), removed: true} as LogEvent<TestABI>;
		await expect(
			builder.receive(batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105, logs: [removed]})),
		).rejects.toBeInstanceOf(InvalidBatchError);
	});
});

describe('reorgs are derived here, from raw logs alone', () => {
	async function upTo105(target: ReturnType<typeof recordingProcessor>, builder: StreamBuilder<TestABI, void>) {
		await builder.receive(
			batch(builder, {
				fromBlock: 100,
				toBlock: 105,
				latestBlock: 105,
				logs: [transfer(101, '0xa101', 1n), transfer(104, '0xa104', 2n)],
			}),
		);
		expect(target.flat()).toHaveLength(2);
	}

	it('reports a hash replacement as a CONTRADICTION and retracts the dead branch', async () => {
		const target = recordingProcessor();
		const builder = builderOn(target.processor);
		await upTo105(target, builder);

		const result = await builder.receive(
			batch(builder, {fromBlock: 102, toBlock: 106, latestBlock: 106, logs: [transfer(104, '0xb104', 3n)]}),
		);

		expect(result.reorg).toMatchObject({cause: 'contradiction', blockNumber: 104, blockHash: '0xa104'});
		expect(result.retracted).toBe(1);
		expect(result.applied).toBe(1);
	});

	it('reports a vanished block as an ABSENCE, which is an inference and not proof', async () => {
		const target = recordingProcessor();
		const builder = builderOn(target.processor);
		await upTo105(target, builder);

		// the re-fetched range simply does not contain block 104 any more
		const result = await builder.receive(batch(builder, {fromBlock: 102, toBlock: 106, latestBlock: 106, logs: []}));

		expect(result.reorg).toMatchObject({cause: 'absence', blockNumber: 104, blockHash: '0xa104'});
		expect(result.retracted).toBe(1);
		expect(result.applied).toBe(0);
	});

	it('derives the SAME stream the engine derives from the same logs', async () => {
		// ADR-0004's reason for keeping reorg logic on one side: the receiver must
		// reach the engine's answer, not its own approximation of it. Both paths go
		// through `generateStreamToAppend`, and this is what pins that they do.
		const viaWire = recordingProcessor();
		const builder = builderOn(viaWire.processor);
		const viaEngine = recordingProcessor();
		const indexer = new IndexerGeneration<TestABI, void>(noChain(), viaEngine.processor, SOURCE, {
			stream: {finality: FINALITY},
		});

		const rounds: {fromBlock: number; toBlock: number; latestBlock: number; logs: LogEvent<TestABI>[]}[] = [
			{
				fromBlock: 100,
				toBlock: 105,
				latestBlock: 105,
				logs: [transfer(101, '0xa101', 1n), transfer(104, '0xa104', 2n)],
			},
			{fromBlock: 102, toBlock: 106, latestBlock: 106, logs: [transfer(104, '0xb104', 3n)]},
			{fromBlock: 103, toBlock: 108, latestBlock: 108, logs: [transfer(104, '0xb104', 3n)]},
		];

		for (const round of rounds) {
			await builder.receive(batch(builder, round));
			await indexer.feed(round.logs, {
				context: {source: builder.context.source, config: builder.context.config, processor: 'v1'},
				latestBlock: round.latestBlock,
				lastFromBlock: round.fromBlock,
				lastToBlock: round.toBlock,
				unconfirmedBlocks: [],
			});
		}

		const identity = (events: LogEvent<TestABI>[]) =>
			events.map((e) => `${e.removed ? '-' : '+'}${e.blockNumber}:${e.blockHash}:${e.transactionHash}`);
		expect(identity(viaWire.flat())).toEqual(identity(viaEngine.flat()));
	});
});

// ---------------------------------------------------------------------------
// THE STREAM IS WRITTEN HERE, BEFORE THE STATE ADVANCES (ADR-0052)
// ---------------------------------------------------------------------------
// The stored EMISSION STREAM (ADR-0006) used to be written by the HTTP ingest
// route, which made it a fact about the TRANSPORT in exactly the way the reorg
// count below was: a combined process folds through `createDirectIngestion`,
// reaches no route, and produced a database whose `_emissions` table was EMPTY.
// So the append is a port on this receiver, supplied by whoever owns the store.
//
// It is the SIBLING of the recorder below and NOT its twin, and the difference
// is the whole of what is asserted here. A count is best-effort: it is taken
// after the fold and a failure is caught, because losing a number is better than
// rolling back the state it describes. An EMISSION is not: a state that advanced
// past events the stream never received is a HOLE -- silent, permanent,
// self-consistent and invisible to the gap check, because the rows that would
// prove it are the ones that never arrived (`CONTEXT.md`, "hole" versus "gap";
// ADR-0038). So the append comes FIRST and a batch whose append failed is NOT
// processed.
// ---------------------------------------------------------------------------

describe('the stream is written before the state advances', () => {
	/** An appender that records what it was handed, in the order the fold called it. */
	function journal() {
		const order: string[] = [];
		const appended: {stream: string; emissions: readonly EmittedLog[]}[] = [];
		return {
			order,
			appended,
			append: async (write: {stream: string; emissions: readonly EmittedLog[]}) => {
				order.push(`append:${write.emissions.length}`);
				appended.push(write);
			},
		};
	}

	/**
	 * A processor that says when it was called, so the ORDER of the two writes is
	 * asserted rather than assumed.
	 */
	function watchedProcessor(order: string[]) {
		const target = recordingProcessor();
		const process = target.processor.process;
		target.processor.process = async (eventStream, lastSync) => {
			order.push(`process:${eventStream.length}`);
			return process(eventStream, lastSync);
		};
		return target;
	}

	it('appends what it is about to fold, BEFORE it folds it, under its own stream digest', async () => {
		const writes = journal();
		const target = watchedProcessor(writes.order);
		const builder = new StreamBuilder<TestABI, void>(target.processor, SOURCE, {
			stream: {finality: FINALITY},
			appendEmissions: writes.append,
		});

		const result = await builder.receive(
			batch(builder, {
				fromBlock: 100,
				toBlock: 105,
				latestBlock: 105,
				logs: [transfer(101, '0xa101', 1n), transfer(104, '0xa104', 2n)],
			}),
		);

		// the ORDER is the contract: the stream is on disk before the state moves past
		// the events it holds, which is what makes a lost append a refusal rather than a
		// hole
		expect(writes.order).toEqual(['append:2', 'process:2']);
		// the SAME emissions the outcome reports, so a host cannot store a second
		// opinion of what the fold concluded
		expect(writes.appended).toEqual([{stream: builder.streamDigest, emissions: result.emissions}]);
	});

	it('appends the RETRACTIONS with the applications, in one write per batch', async () => {
		const writes = journal();
		const target = recordingProcessor();
		const builder = new StreamBuilder<TestABI, void>(target.processor, SOURCE, {
			stream: {finality: FINALITY},
			appendEmissions: writes.append,
		});
		await builder.receive(
			batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105, logs: [transfer(104, '0xa104', 2n)]}),
		);

		await builder.receive(
			batch(builder, {fromBlock: 102, toBlock: 106, latestBlock: 106, logs: [transfer(104, '0xb104', 3n)]}),
		);

		// the reorg batch: the retraction of the dead block AND the replacement, handed
		// over together, because a store that saw only one of them would be a stream
		// that disagrees with the fold
		expect(
			writes.appended.map((write) => write.emissions.map((e) => `${e.removed ? '-' : '+'}${e.blockHash}`)),
		).toEqual([['+0xa104'], ['-0xa104', '+0xb104']]);
	});

	it('does NOT process a batch whose append failed, and leaves the cursor where it was', async () => {
		// THE POINT. A count that cannot be written is a logged miscount; a stream that
		// cannot be written is a HOLE the next rebuild folds around silently. So this
		// one raises, and it raises BEFORE the processor has seen anything.
		const order: string[] = [];
		const target = watchedProcessor(order);
		let refuse = true;
		const builder = new StreamBuilder<TestABI, void>(target.processor, SOURCE, {
			stream: {finality: FINALITY},
			appendEmissions: async () => {
				if (refuse) throw new Error('no such table: _emissions');
				order.push('append');
			},
		});

		const refused = batch(builder, {
			fromBlock: 100,
			toBlock: 105,
			latestBlock: 105,
			logs: [transfer(101, '0xa101', 1n), transfer(104, '0xa104', 2n)],
		});
		await expect(builder.receive(refused)).rejects.toThrow(/_emissions/);

		// nothing was folded and nothing was persisted: the state did not advance past
		// events the stream never received
		expect(order).toEqual([]);
		expect(target.flat()).toEqual([]);
		expect(target.lastSync).toBeUndefined();
		// ...so the receiver still asks for the same range, and this is what "no hole"
		// means concretely: the state and the stream agree about how far they got,
		// which here is nowhere
		expect(await builder.expectedFromBlock()).toBe(START_BLOCK);
	});

	it('re-derives the SAME delta on the next cycle, and lands it once the store accepts it', async () => {
		const order: string[] = [];
		const target = watchedProcessor(order);
		const appended: readonly EmittedLog[][] = [];
		let refuse = true;
		const builder = new StreamBuilder<TestABI, void>(target.processor, SOURCE, {
			stream: {finality: FINALITY},
			appendEmissions: async ({emissions}) => {
				if (refuse) throw new Error('the database went away');
				(appended as EmittedLog[][]).push([...emissions]);
			},
		});

		const cycle = () =>
			builder.receive(
				batch(builder, {
					fromBlock: 100,
					toBlock: 105,
					latestBlock: 105,
					logs: [transfer(101, '0xa101', 1n), transfer(104, '0xa104', 2n)],
				}),
			);

		await expect(cycle()).rejects.toThrow(/went away/);
		refuse = false;
		const result = await cycle();

		// the same two events, applied exactly once, and stored exactly once: the
		// refused cycle left nothing behind for this one to skip or to duplicate
		expect(result.applied).toBe(2);
		expect(target.flat()).toHaveLength(2);
		expect(appended.map((emissions) => emissions.length)).toEqual([2]);
		expect(target.lastSync?.lastToBlock).toBe(105);
	});

	it('appends nothing for a batch that emitted nothing, so an empty cycle costs no write', async () => {
		const writes = journal();
		const target = recordingProcessor();
		const builder = new StreamBuilder<TestABI, void>(target.processor, SOURCE, {
			stream: {finality: FINALITY},
			appendEmissions: writes.append,
		});

		await builder.receive(batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105, logs: []}));

		// the fold still advanced (the cursor moves on an empty range), and the stream
		// has nothing to say about it
		expect(writes.appended).toEqual([]);
		expect(target.lastSync?.lastToBlock).toBe(105);
	});

	it('folds exactly the same with no appender at all, which is a host that stores no stream', async () => {
		const writes = journal();
		const storing = recordingProcessor();
		const withAppender = new StreamBuilder<TestABI, void>(storing.processor, SOURCE, {
			stream: {finality: FINALITY},
			appendEmissions: writes.append,
		});
		const blind = recordingProcessor();
		const withoutAppender = builderOn(blind.processor);

		for (const round of [
			{fromBlock: 100, toBlock: 105, latestBlock: 105, logs: [transfer(104, '0xa104', 2n)]},
			{fromBlock: 102, toBlock: 106, latestBlock: 106, logs: [transfer(104, '0xb104', 3n)]},
		]) {
			await withAppender.receive(batch(withAppender, round));
			await withoutAppender.receive(batch(withoutAppender, round));
		}

		const identity = (events: LogEvent<TestABI>[]) =>
			events.map((e) => `${e.removed ? '-' : '+'}${e.blockNumber}:${e.blockHash}`);
		expect(identity(blind.flat())).toEqual(identity(storing.flat()));
		// ...and only one of them could be replayed afterwards
		expect(writes.appended).toHaveLength(2);
	});

	it('hashes no appender into the wire identity: where a stream is stored is not what a sender asserts', () => {
		const plain = builderOn(recordingProcessor().processor);
		const storing = new StreamBuilder<TestABI, void>(recordingProcessor().processor, SOURCE, {
			stream: {finality: FINALITY},
			appendEmissions: async () => undefined,
		});
		expect(storing.context).toEqual(plain.context);
	});
});

// ---------------------------------------------------------------------------
// THE COUNT IS TAKEN HERE, ONCE, AND CANNOT TAKE THE FOLD DOWN (ADR-0050)
// ---------------------------------------------------------------------------
// The reorg counters used to be written by the HTTP ingest route, which made an
// operational counter a fact about the TRANSPORT: `etherfold run` folds through
// `createDirectIngestion`, reaches no route, and reported
// `{absence: 0, contradiction: 0}` for ever. A revert is concluded HERE, so it is
// counted here -- once per concluded revert, whichever entrance the batch came
// in through -- and persisted by whoever owns the store.
// ---------------------------------------------------------------------------

describe('a concluded reorg is counted exactly once, by whoever owns the store', () => {
	function recorder() {
		const seen: ReorgDetection[] = [];
		return {seen, record: (reorg: ReorgDetection) => void seen.push(reorg)};
	}

	async function upTo105(builder: StreamBuilder<TestABI, void>) {
		await builder.receive(
			batch(builder, {
				fromBlock: 100,
				toBlock: 105,
				latestBlock: 105,
				logs: [transfer(101, '0xa101', 1n), transfer(104, '0xa104', 2n)],
			}),
		);
	}

	it('reports the revert to the recorder ONCE, with what it reported to the caller', async () => {
		const target = recordingProcessor();
		const journal = recorder();
		const builder = new StreamBuilder<TestABI, void>(target.processor, SOURCE, {
			stream: {finality: FINALITY},
			recordReorg: journal.record,
		});
		await upTo105(builder);
		expect(journal.seen).toHaveLength(0);

		const result = await builder.receive(
			batch(builder, {fromBlock: 102, toBlock: 106, latestBlock: 106, logs: [transfer(104, '0xb104', 3n)]}),
		);

		// once, and the SAME detection the outcome carries. A caller that counted
		// `outcome.reorg` as well would double-count the shape that both concludes and
		// receives, which is why the outcome is reported and never delegated.
		expect(journal.seen).toEqual([result.reorg]);
	});

	it('counts nothing on a batch that concluded nothing, however many arrive', async () => {
		const target = recordingProcessor();
		const journal = recorder();
		const builder = new StreamBuilder<TestABI, void>(target.processor, SOURCE, {
			stream: {finality: FINALITY},
			recordReorg: journal.record,
		});
		await upTo105(builder);
		await builder.receive(
			batch(builder, {fromBlock: 102, toBlock: 108, latestBlock: 108, logs: [transfer(104, '0xa104', 2n)]}),
		);
		expect(journal.seen).toEqual([]);
	});

	it('applies the batch and answers the sender even when the counter cannot be written', async () => {
		// The guarantee `recordReorgSafely` gave on the route, now owed by every shape:
		// the state and the cursor already moved atomically, so a failed operational
		// counter is a logged miscount and never a refusal that tells a sender to
		// re-send a batch which was in fact applied.
		const target = recordingProcessor();
		const builder = new StreamBuilder<TestABI, void>(target.processor, SOURCE, {
			stream: {finality: FINALITY},
			recordReorg: () => {
				throw new Error('no such table: _meta');
			},
		});
		await upTo105(builder);

		const result = await builder.receive(
			batch(builder, {fromBlock: 102, toBlock: 106, latestBlock: 106, logs: [transfer(104, '0xb104', 3n)]}),
		);

		expect(result.reorg).toMatchObject({cause: 'contradiction', blockNumber: 104});
		expect(result.retracted).toBe(1);
		expect(result.applied).toBe(1);
		expect(target.lastSync?.lastToBlock).toBe(106);
	});

	it('rejects nothing when a recorder rejects ASYNCHRONOUSLY either', async () => {
		const target = recordingProcessor();
		const builder = new StreamBuilder<TestABI, void>(target.processor, SOURCE, {
			stream: {finality: FINALITY},
			recordReorg: async () => {
				throw new Error('the database went away');
			},
		});
		await upTo105(builder);

		await expect(
			builder.receive(batch(builder, {fromBlock: 102, toBlock: 106, latestBlock: 106, logs: []})),
		).resolves.toMatchObject({reorg: {cause: 'absence'}});
	});

	it('folds exactly the same with no recorder at all, which is a host with nowhere to write', async () => {
		const counted = recordingProcessor();
		const journal = recorder();
		const withRecorder = new StreamBuilder<TestABI, void>(counted.processor, SOURCE, {
			stream: {finality: FINALITY},
			recordReorg: journal.record,
		});
		const blind = recordingProcessor();
		const withoutRecorder = builderOn(blind.processor);

		for (const round of [
			{fromBlock: 100, toBlock: 105, latestBlock: 105, logs: [transfer(104, '0xa104', 2n)]},
			{fromBlock: 102, toBlock: 106, latestBlock: 106, logs: [transfer(104, '0xb104', 3n)]},
		]) {
			await withRecorder.receive(batch(withRecorder, round));
			await withoutRecorder.receive(batch(withoutRecorder, round));
		}

		const identity = (events: LogEvent<TestABI>[]) =>
			events.map((e) => `${e.removed ? '-' : '+'}${e.blockNumber}:${e.blockHash}`);
		expect(identity(blind.flat())).toEqual(identity(counted.flat()));
		// ...and only one of them could say so afterwards
		expect(journal.seen).toHaveLength(1);
	});

	it('hashes no recorder into the wire identity: where a count goes is not what a sender asserts', () => {
		const plain = builderOn(recordingProcessor().processor);
		const counting = new StreamBuilder<TestABI, void>(recordingProcessor().processor, SOURCE, {
			stream: {finality: FINALITY},
			recordReorg: () => undefined,
		});
		expect(counting.context).toEqual(plain.context);
	});
});

describe('the wire codec', () => {
	it('round-trips a batch whose event arguments are BigInts', () => {
		const target = recordingProcessor();
		const builder = builderOn(target.processor);
		const original = batch(builder, {
			fromBlock: 100,
			toBlock: 105,
			latestBlock: 105,
			logs: [transfer(101, '0xa101', 2n ** 200n)],
		});

		const revived = parseWireBatch<TestABI>(serializeWireBatch(original));
		expect(revived).toEqual(original);
		expect((revived.logs[0] as {args: {id: bigint}}).args.id).toBe(2n ** 200n);
	});

	it('leaves a string that merely LOOKS like a BigInt literal alone', () => {
		// the `"123n"` suffix convention has to guess, and a contract can emit a
		// string ending in `n`. The tag cannot be produced by accident.
		const target = recordingProcessor();
		const builder = builderOn(target.processor);
		const log = transfer(101, '0xa101', 1n) as unknown as {args: {from: string}};
		log.args.from = '123n';
		const original = batch(builder, {
			fromBlock: 100,
			toBlock: 105,
			latestBlock: 105,
			logs: [log as unknown as LogEvent<TestABI>],
		});

		const revived = parseWireBatch<TestABI>(serializeWireBatch(original));
		expect((revived.logs[0] as unknown as {args: {from: unknown}}).args.from).toBe('123n');
	});
});

/**
 * A provider that refuses every call.
 *
 * The receiving half has no chain (ADR-0003 keeps every chain call in the
 * log-fetcher), and `feed()` is the one `IndexerGeneration` entry point that makes
 * none. Handing it a refusing provider is how that stays true.
 */
function noChain() {
	return {
		async request(args: {method: string}): Promise<never> {
			throw new Error(`the receiving side called ${args.method}: it has no chain`);
		},
	} as never;
}
