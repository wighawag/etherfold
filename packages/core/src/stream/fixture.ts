import type {Abi} from 'abitype';
import type {EventProcessor, IndexingSource, LastSync, LogEvent, UsedStreamConfig} from '../types.js';
import {taggedBnReplacer, taggedBnReviver} from '../utils/bigint.js';

/**
 * The on-disk format version of a captured stream.
 *
 * A fixture is a SNAPSHOT, so it is read long after it was written, by code that
 * has moved on. The version is what lets a reader refuse a shape it does not
 * understand instead of half-parsing it.
 *
 * ## Why it is 2
 *
 * Format 1 wrote BigInts as `"123n"`, which is also a legal string for a
 * contract to emit, so a reader could not tell a `uint256` argument from a
 * string argument that read like one. Format 2 tags them (`utils/bigint.ts`).
 * The bump is what makes that change SAFE: a format-1 file parsed by this reader
 * would come back with every BigInt silently turned into a string, and it is
 * refused below instead. The two fixtures committed in this repo were
 * re-encoded; see `docs/spikes/tagged-bigint-codec-across-storage-adapters/`.
 */
export const STREAM_FIXTURE_FORMAT = 2;

/**
 * Where a fixture came from, in enough detail that a reader can judge it.
 *
 * Free-form beyond the four fields that are always knowable at capture time,
 * because what makes a capture trustworthy is domain-specific: which contracts
 * repo and commit the addresses came from, which node served the logs, who ran
 * it. Those go in as extra keys rather than being guessed at here.
 *
 * Two of those extra keys are TYPED below and stay OPTIONAL, which is the whole
 * of the concession. A seed PRODUCER needs both of them (`StreamSeed` types them
 * as required fields of the envelope and takes them as typed inputs), and the
 * committed captures already carry them, so typing them here lets a producer
 * READ them instead of casting an `unknown` out of the index signature. Making
 * either REQUIRED is a different thing and is refused: `captureStream` writes
 * this shape and every committed capture already matches it, so a required field
 * would force a fixture-format bump, and ADR-0063 is explicit that
 * `STREAM_FIXTURE_FORMAT` is untouched by the seeding work. A producer therefore
 * treats them as a convenience and never as a guarantee.
 */
export type StreamFixtureProvenance = {
	/** ISO-8601, when the capture ran. */
	capturedAt: string;
	chainId: string;
	fromBlock: number;
	toBlock: number;
	/** The chain head the capture OBSERVED, which is what a capture-depth check needs. */
	chainHeadAtCapture?: number;
	/** What ran the capture, in enough detail that a reader can go and look at it. */
	capturedBy?: string;
	[key: string]: unknown;
};

/**
 * A captured event stream: everything needed to replay an indexing run with no
 * node in the loop.
 *
 * `source` travels WITH the events on purpose. The events are already decoded,
 * so the ABI is not needed to read them back, but it IS needed to know what was
 * asked for: a stream captured over two contracts and one captured over three
 * are different inputs even when they happen to contain the same logs, and a
 * fixture that cannot say which it is cannot be compared against another run.
 */
export type StreamFixture<ABI extends Abi> = {
	format: typeof STREAM_FIXTURE_FORMAT;
	provenance: StreamFixtureProvenance;
	source: IndexingSource<ABI>;
	/** The cursor as it stood at the end of the capture. */
	lastSync: LastSync<ABI>;
	/** Every event captured, in stream order (block, then log index). */
	eventStream: LogEvent<ABI>[];
};

/** One block's worth of a fixture, as `blocksOf` groups it. */
export type FixtureBlock<ABI extends Abi> = {
	number: number;
	hash: string;
	/** Seconds since the epoch, when the node put it on the logs; absent if it did not. */
	timestamp?: number;
	events: LogEvent<ABI>[];
};

/**
 * A fixture as text.
 *
 * BigInts go out TAGGED (`taggedBnReplacer`, the one convention this repo has),
 * because decoded `uint256` arguments are ordinary, `JSON.stringify` throws on
 * them, and a fixture of a real chain is exactly where a string argument that
 * reads like a BigInt turns up beside a real one.
 */
export function serializeStreamFixture<ABI extends Abi>(fixture: StreamFixture<ABI>, indent = 0): string {
	return JSON.stringify(fixture, taggedBnReplacer, indent);
}

/**
 * Read a fixture back, refusing anything that is not one.
 *
 * The checks are deliberately shallow: enough that a truncated file, a
 * newer-format file or an unrelated JSON document fails HERE, with a message
 * naming the fixture, rather than three layers down as `undefined is not
 * iterable` inside a processor.
 *
 * An OLDER format is refused for a different reason and the refusal is the whole
 * point of it: a format-1 file encoded its BigInts as `"123n"`, which this
 * reader does not interpret, so accepting it would hand back a fixture whose
 * every `uint256` argument had quietly become a string. There is no in-between:
 * either the file is re-encoded (a one-off, see `STREAM_FIXTURE_FORMAT`) or it
 * is not read.
 */
export function parseStreamFixture<ABI extends Abi>(text: string): StreamFixture<ABI> {
	const parsed = JSON.parse(text, taggedBnReviver) as Partial<StreamFixture<ABI>>;
	if (!parsed || typeof parsed !== 'object') {
		throw new Error(`not a stream fixture: expected an object`);
	}
	if (parsed.format !== STREAM_FIXTURE_FORMAT) {
		throw new Error(`unsupported stream fixture format: ${parsed.format} (this build reads ${STREAM_FIXTURE_FORMAT})`);
	}
	if (!parsed.source || !parsed.lastSync || !Array.isArray(parsed.eventStream)) {
		throw new Error(`not a stream fixture: missing source, lastSync or eventStream`);
	}
	return parsed as StreamFixture<ABI>;
}

/**
 * The fixture's events grouped into blocks, in order.
 *
 * One block is the unit a processor applies atomically, so it is the unit a
 * replay hands over, and the unit a benchmark should time. Blocks with no
 * events do not appear, because the capture never saw them.
 */
export function blocksOf<ABI extends Abi>(fixture: StreamFixture<ABI>): FixtureBlock<ABI>[] {
	const blocks: FixtureBlock<ABI>[] = [];
	let current: FixtureBlock<ABI> | undefined;
	for (const event of fixture.eventStream) {
		if (!current || current.hash !== event.blockHash) {
			current = {
				number: event.blockNumber,
				hash: event.blockHash,
				...(event.blockTimestamp === undefined ? {} : {timestamp: event.blockTimestamp}),
				events: [],
			};
			blocks.push(current);
		}
		current.events.push(event);
	}
	return blocks;
}

/**
 * A READER over a captured fixture: fetch, and nothing else.
 *
 * ## Why this is NOT the keeper seam (`ExistingStream`)
 *
 * A fixture and a stream KEEPER hold different things. A keeper stores what the
 * NODE said, so the decoded half of an event (`args`, `eventName`) has no
 * business in it: it is what some ABI made of the raw bytes, it is the only half
 * that can go STALE, and it is re-derived on read. A fixture is the opposite by
 * design -- its events are decoded ONCE, at capture, so a replay does not re-run
 * the decoder, and that decoded half is exactly what makes it a reusable test
 * INPUT.
 *
 * They shared `ExistingStream` for as long as nothing made them differ. Once the
 * keeper seam speaks a STORED (raw-only) event, a fixture cannot satisfy it and
 * should not: nothing wires a fixture as the indexer's `keepStream`, so the two
 * never met at runtime anyway. Declaring its own reader type is what lets each
 * say what it actually is.
 *
 * ## Why there is no write half
 *
 * A fixture is immutable BY DEFINITION -- a replay that appended to it would stop
 * being a replay of the thing whose provenance is recorded at the top of the
 * file. That used to be a `saveNewEvents` that SWALLOWED the write
 * (`readOnlyStream`, ADR-0044). With no seam to satisfy there is nothing to
 * swallow: the write is not expressible, so "writing through a fixture does not
 * change what it serves" is a compile-time fact rather than a behaviour a test
 * has to watch. `readOnlyStream` keeps its one meaning, read-only on the KEEPER
 * seam, and keeps its callers there.
 *
 * `fetchFrom` always ANSWERS, where a keeper's may report ABSENT: a fixture is a
 * stream that is present by construction. What it will not do is serve a chain
 * it was not captured on, which is a mistake and not an absence.
 */
export type StreamFixtureReader<ABI extends Abi> = {
	fetchFrom: (
		source: IndexingSource<ABI>,
		fromBlock: number,
	) => Promise<{lastSync: LastSync<ABI>; eventStream: LogEvent<ABI>[]}>;
};

/**
 * Serve a captured fixture from disk, as a reader that cannot be written to.
 *
 * The cursor it hands back is the capture's own, whose unconfirmed window is
 * EMPTY (ADR-0035): the window is read from the entity path's serialized cursor,
 * and a stream's copy of it is read by nobody.
 */
export function replayStream<ABI extends Abi>(fixture: StreamFixture<ABI>): StreamFixtureReader<ABI> {
	return {
		fetchFrom: async (source: IndexingSource<ABI>, fromBlock: number) => {
			if (source.chainId !== fixture.source.chainId) {
				throw new Error(`stream fixture is for chain ${fixture.source.chainId}, asked for chain ${source.chainId}`);
			}
			return {
				eventStream: fixture.eventStream.filter((event) => event.blockNumber >= fromBlock),
				lastSync: fixture.lastSync,
			};
		},
	};
}

export type ReplayOptions<ABI extends Abi> = {
	/**
	 * What each per-block `LastSync` reports as the chain tip.
	 *
	 * `'live'` (the default) says the block being applied IS the tip, which is
	 * what it was when the events first arrived, and therefore what keeps a
	 * processor's reorg-eligible path doing the work it did live. `'final'` says the capture's own last
	 * block is the tip, so every block is already past finality and a processor
	 * may take its cheaper, no-history path.
	 */
	chainTip?: 'live' | 'final';
	/** Called after each block has been applied. */
	onBlock?(block: FixtureBlock<ABI>, index: number): void | Promise<void>;
};

/**
 * Replay a fixture through a processor, one block at a time, with no node.
 *
 * One block is one `process` call because that is how blocks arrive and how
 * they are applied: batching several into one call would measure a batch size
 * that never occurs at the tip, and splitting one across two calls would let a
 * half-applied block be observed, which live indexing never does.
 *
 * The caller is expected to have configured the processor already (`configure`);
 * this drives `load` and then `process`, and returns the cursor as it stands at
 * the end.
 */
export async function replayFixtureInto<ABI extends Abi, ProcessResultType>(
	processor: EventProcessor<ABI, ProcessResultType>,
	fixture: StreamFixture<ABI>,
	streamConfig: UsedStreamConfig,
	options: ReplayOptions<ABI> = {},
): Promise<LastSync<ABI>> {
	const {chainTip = 'live', onBlock} = options;
	await processor.load(fixture.source, streamConfig);

	const blocks = blocksOf(fixture);
	let lastSync: LastSync<ABI> = {
		...fixture.lastSync,
		lastFromBlock: fixture.lastSync.lastFromBlock,
		lastToBlock: 0,
		unconfirmedBlocks: [],
	};
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		lastSync = {
			context: fixture.lastSync.context,
			latestBlock: chainTip === 'live' ? block.number : fixture.lastSync.latestBlock,
			lastFromBlock: block.number,
			lastToBlock: block.number,
			unconfirmedBlocks: [],
		};
		await processor.process(block.events, lastSync);
		if (onBlock) {
			await onBlock(block, i);
		}
	}
	return lastSync;
}
