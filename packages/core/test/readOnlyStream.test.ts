import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {readOnlyStream} from '../src/stream/readOnly.js';
import {resolveStreamConfig} from '../src/internal/engine/utils.js';
import type {ExistingStream, UsedStreamConfig} from '../src/types.js';
import {makeLog, memoryStream, SOURCE} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------
// A READ-ONLY STREAM VIEW: the seam that makes a pure reader EXPRESSIBLE.
// ---------------------------------------------------------------------------
// Read and write share ONE `ExistingStream`, so a generation handed the stream
// to fold is handed the thing that also appends -- and `promiseToSave` calls
// `saveNewEvents` unconditionally. "A generation that merely reads" is therefore
// not something a caller can express by declining to write; it is a VIEW whose
// write operations do not reach the keeper at all.
//
// What it wraps is always a KEEPER of the stream: a follower over the stream
// another generation is indexing, and the server's stored emission stream read
// back. A captured FIXTURE is not one of them -- it serves decoded events from
// disk and answers to nobody's seam (`streamFixture.test.ts`), so its
// immutability is a property of its own type rather than a swallowed write here.
// ---------------------------------------------------------------------------

describe('a read-only stream view', () => {
	it('serves what the underlying stream holds', async () => {
		const stream = memoryStream();
		await stream.keeper.saveNewEvents(SOURCE, {
			eventStream: [makeLog(100, '0xa100'), makeLog(102, '0xa102')],
			lastSync: {
				context: {source: [], config: 'c', processor: 'p'},
				latestBlock: 105,
				lastFromBlock: 100,
				lastToBlock: 102,
				unconfirmedBlocks: [],
			},
		});

		const view = readOnlyStream<Abi>(stream.keeper);
		const served = await view.fetchFrom(SOURCE, 100);

		expect(served?.eventStream.map((event) => event.blockNumber)).toEqual([100, 102]);
	});

	it('does NOT reach the keeper on a save: the write is a no-op, not a refusal', async () => {
		const stream = memoryStream();
		const view = readOnlyStream<Abi>(stream.keeper);

		await view.saveNewEvents(SOURCE, {
			eventStream: [makeLog(100, '0xa100')],
			lastSync: {
				context: {source: [], config: 'c', processor: 'p'},
				latestBlock: 105,
				lastFromBlock: 100,
				lastToBlock: 100,
				unconfirmedBlocks: [],
			},
		});

		// a refusal would wedge the engine, which does not process a batch it could
		// not write: the one-writer rule is expressed by writing NOWHERE, silently
		expect(stream.writes).toHaveLength(0);
		expect(stream.events).toHaveLength(0);
		expect(await view.fetchFrom(SOURCE, 0)).toBeUndefined();
	});

	it('does NOT reach the keeper on a clear either', async () => {
		const stream = memoryStream();
		await stream.keeper.saveNewEvents(SOURCE, {
			eventStream: [makeLog(100, '0xa100')],
			lastSync: {
				context: {source: [], config: 'c', processor: 'p'},
				latestBlock: 105,
				lastFromBlock: 100,
				lastToBlock: 100,
				unconfirmedBlocks: [],
			},
		});

		const view = readOnlyStream<Abi>(stream.keeper);
		await view.clear(SOURCE);

		// the load path clears on every shape it cannot use, and a follower takes
		// those branches over a stream ANOTHER generation is still indexing into
		expect(stream.clears).toBe(0);
		expect(stream.events).toHaveLength(1);
	});

	it('passes the stream CONFIG through, so the view addresses the same stream', async () => {
		const seen: UsedStreamConfig[] = [];
		const keeper: ExistingStream<Abi> = {
			fetchFrom: async () => undefined,
			saveNewEvents: async () => {},
			clear: async () => {},
			setStreamConfig: (streamConfig) => seen.push(streamConfig),
		};

		const config = resolveStreamConfig({finality: 7});
		readOnlyStream<Abi>(keeper).setStreamConfig?.(config);

		expect(seen).toEqual([config]);
	});

	it('has no `setStreamConfig` when the reader addresses nothing', () => {
		expect(readOnlyStream<Abi>({fetchFrom: async () => undefined}).setStreamConfig).toBeUndefined();
	});
});
