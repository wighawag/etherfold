import {describe, expect, it} from 'vitest';
import {StreamHoleError} from '../src/errors.js';
import {StreamWriter, type StreamCursorRead, type StreamCursorSource} from '../src/stream/writer.js';
import type {EmissionWrite} from '../src/emissionStream.js';
import type {LogIngestion} from '../src/streamBuilder.js';
import {FINALITY, SOURCE, START_BLOCK, transfer, type TestABI} from './utils/receivingWorld.js';

// ---------------------------------------------------------------------------------------------------
// THE THING THAT FETCHES A STREAM IS THE THING THAT APPENDS TO IT
// ---------------------------------------------------------------------------------------------------
// `StreamWriter` is the one writer of one stream and it is NOT a generation
// (ADR-0087). What is asserted here is the pair of facts that makes moving the
// duty off the generation SAFE, at the seam rather than through a container:
//
//   THE POSITION    `expectedFromBlock` is the STREAM's own coverage claim and
//                   never a fold's cursor, so an empty-state successor cannot
//                   drag the fetch back over history the stream already holds;
//   THE HOLE GUARD  an append that would leave blocks nothing ever received,
//                   behind a coverage claim saying otherwise, is REFUSED.
//
// The guard is the one ADR-0087 first credited to
// `IndexerGeneration.streamCanReceive` and its own amendment moved here: that
// method sits over a stream the load path always reads first, while the
// append-only path reads nothing back and had no hole guard of any kind.
// ---------------------------------------------------------------------------------------------------

/** A stream whose position the test states outright, so the writer's arithmetic is the subject. */
function aStreamAt(position: StreamCursorRead | undefined): {
	cursor: StreamCursorSource;
	written: EmissionWrite[];
} {
	const written: EmissionWrite[] = [];
	return {
		written,
		cursor: {
			async readStreamCursor(): Promise<StreamCursorRead | undefined> {
				return position;
			},
		},
	};
}

function aWriter(
	stream: {cursor: StreamCursorSource; written: EmissionWrite[]},
	options?: {source?: typeof SOURCE},
): StreamWriter<TestABI> {
	return new StreamWriter<TestABI>(options?.source ?? SOURCE, {
		stream: {finality: FINALITY},
		cursor: stream.cursor,
		appendEmissions: (write) => {
			stream.written.push(write);
		},
	});
}

describe('where the next range starts is the STREAM`s answer and no fold`s', () => {
	it('asks from the source`s own first block where NO stream is stored', async () => {
		const stream = aStreamAt(undefined);
		const writer = aWriter(stream);

		expect(await writer.expectedFromBlock()).toBe(START_BLOCK);
	});

	it('resumes over the stored stream`s reorg window, whatever any fold has folded', async () => {
		// The number the whole change turns on. A fold with EMPTY state asks from
		// `START_BLOCK`; the stream asks from its own coverage reaching back over the
		// finality window, and there is nothing about a fold in this object at all.
		const stream = aStreamAt({latestBlock: 500, lastFromBlock: 400, lastToBlock: 500, tail: []});
		const writer = aWriter(stream);

		expect(await writer.expectedFromBlock()).toBe(500 - FINALITY);
	});
});

describe('an append that would punch a HOLE is refused', () => {
	it('refuses a range starting above what the stream claims to cover, naming the gap', async () => {
		// Reachable rather than contrived: a stored claim whose `latestBlock` is 0 makes
		// `getFromBlock` fall to the SOURCE's first block however far the rows reach, so
		// the position offered and the position stored disagree -- which is exactly the
		// shape "something other than the stream positioned this write" takes.
		const stream = aStreamAt({latestBlock: 0, lastFromBlock: 0, lastToBlock: START_BLOCK - 50, tail: []});
		const writer = aWriter(stream);
		const fromBlock = await writer.expectedFromBlock();
		expect(fromBlock).toBe(START_BLOCK);

		const refusal = (await writer
			.receive({
				context: writer.context,
				fromBlock,
				toBlock: START_BLOCK + 10,
				latestBlock: START_BLOCK + 10,
				logs: [transfer(START_BLOCK + 1, '0xa1', 1n)],
			})
			.catch((error: unknown) => error)) as StreamHoleError;

		expect(refusal).toBeInstanceOf(StreamHoleError);
		expect(refusal.coveredThrough).toBe(START_BLOCK - 50);
		expect(refusal.appendingFrom).toBe(START_BLOCK);
		expect(refusal.retryable).toBe(false);
		// NOTHING was appended: the refusal is before the write and not after it
		expect(stream.written).toEqual([]);
	});

	it('stays PERMISSIVE where there is no stream on disk, which is an ABSENCE and not an unknown', async () => {
		// The correction ADR-0087's own amendment makes: refusing on an absent stream
		// declines the FIRST SAVE of every fresh deployment. Nothing constrains the next
		// write when there is nothing to continue.
		const stream = aStreamAt(undefined);
		const writer = aWriter(stream);

		await writer.receive({
			context: writer.context,
			fromBlock: START_BLOCK,
			toBlock: START_BLOCK + 10,
			latestBlock: START_BLOCK + 10,
			logs: [transfer(START_BLOCK + 1, '0xa1', 1n)],
		});

		expect(stream.written).toHaveLength(1);
		expect(stream.written[0]?.coverage).toMatchObject({lastFromBlock: START_BLOCK, lastToBlock: START_BLOCK + 10});
		expect(stream.written[0]?.emissions).toHaveLength(1);
	});

	it('appends a range that CONTINUES the stream, claim and all, including one carrying no logs', async () => {
		const stream = aStreamAt({latestBlock: 500, lastFromBlock: 400, lastToBlock: 500, tail: []});
		const writer = aWriter(stream);

		await writer.receive({
			context: writer.context,
			fromBlock: await writer.expectedFromBlock(),
			toBlock: 520,
			latestBlock: 520,
			logs: [],
		});

		// an EMPTY batch is not a no-op: a range that carried no logs moved the stream's
		// reach, and the claim is the only thing that can say so (ADR-0055)
		expect(stream.written).toHaveLength(1);
		expect(stream.written[0]?.emissions).toEqual([]);
		expect(stream.written[0]?.coverage).toMatchObject({lastToBlock: 520, latestBlock: 520});
	});
});

describe('a stream`s address has no fold behind it', () => {
	it('reports no generation, because every generation over the stream reads what it stored', async () => {
		const writer = aWriter(aStreamAt(undefined));

		// filling this in with whichever fold happened to be first would be the retired
		// ELECTION wearing a reporting field's name (ADR-0087), so the class does not
		// declare it at all and `LogIngestion` makes it optional
		expect((writer as LogIngestion).generation).toBeUndefined();
		expect(writer.streamDigest).toEqual(expect.any(String));
	});
});
