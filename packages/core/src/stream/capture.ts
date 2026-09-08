import type {Abi} from 'abitype';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {LogEventFetcher} from '../internal/decoding/LogEventFetcher.js';
import {sourceHashesOf} from '../internal/engine/eventRanges.js';
import {streamConfigHashOf} from '../internal/engine/utils.js';
import type {FetchConfig, IndexingSource, LogEvent, LogParseConfig, ProvidedStreamConfig} from '../types.js';
import {declaredMethodsOnly} from '../providerSurface.js';
import {STREAM_FIXTURE_FORMAT, type StreamFixture} from './fixture.js';

export type CaptureStreamOptions = {
	/** Defaults to the earliest `startBlock` declared by the source's contracts. */
	fromBlock?: number;
	/**
	 * The last block to capture, inclusive. REQUIRED, and it must be a number
	 * rather than `'latest'`: a fixture is a snapshot, and one whose upper bound
	 * was "whenever it ran" cannot be re-captured to compare against itself.
	 */
	toBlock: number;
	fetch?: FetchConfig;
	parse?: LogParseConfig;
	/**
	 * RESOLVED and then hashed into the fixture's cursor, so a replay can tell a
	 * config change from a data change -- and so a capture that left `finality`
	 * unset still replays into an indexer that filled the default in.
	 */
	streamConfig?: ProvidedStreamConfig;
	/** Merged into the fixture's provenance: contracts repo + commit, node, whatever a reader needs. */
	provenance?: Record<string, unknown>;
	/** Reports each fetched range, so a long capture is not a silent one. */
	onProgress?(progress: {fromBlock: number; toBlock: number; events: number; totalEvents: number}): void;
};

function earliestStartBlock<ABI extends Abi>(source: IndexingSource<ABI>): number {
	const contracts = source.contracts;
	if (!Array.isArray(contracts)) {
		return (contracts as {startBlock?: number}).startBlock ?? 0;
	}
	let earliest: number | undefined;
	for (const contract of contracts as readonly {startBlock?: number}[]) {
		const startBlock = contract.startBlock ?? 0;
		if (earliest === undefined || startBlock < earliest) {
			earliest = startBlock;
		}
	}
	return earliest ?? 0;
}

/**
 * Fetch a range of logs once and return it as a replayable fixture.
 *
 * This is the ONLY part of the replay path that talks to a node, and that is the
 * point: a measurement or a regression test that fetches per run is slow,
 * rate-limited, and unfair between two things being compared, because each of
 * them sees different bytes. Capture once, commit the result, replay it forever.
 *
 * Events are decoded here (by the same `LogEventFetcher` the live path uses), so
 * a fixture holds `LogEvent`s rather than raw logs and a replay does not re-run
 * the decoder. The ABI still travels along inside `source`, because it is part of
 * WHAT WAS ASKED FOR, not merely of how the answer was decoded.
 */
export async function captureStream<ABI extends Abi>(
	provider: EIP1193ProviderWithoutEvents,
	source: IndexingSource<ABI>,
	options: CaptureStreamOptions,
): Promise<StreamFixture<ABI>> {
	const fromBlock = options.fromBlock ?? earliestStartBlock(source);
	const toBlock = options.toBlock;
	if (!Number.isInteger(toBlock)) {
		throw new Error(`captureStream needs a concrete numeric toBlock, got ${toBlock}`);
	}
	if (toBlock < fromBlock) {
		throw new Error(`captureStream: toBlock ${toBlock} is below fromBlock ${fromBlock}`);
	}

	const contractsData = Array.isArray(source.contracts)
		? (source.contracts as readonly {address: `0x${string}`; abi: ABI}[])
		: ({abi: (source.contracts as {abi: ABI}).abi} as {abi: ABI});
	// The one place in the replay path that talks to a node, and it talks to it
	// through the same declared surface the live path does (ADR-0073): a capture is
	// still the engine asking, so `eth_getLogs` is still the whole of what it asks.
	const fetcher = new LogEventFetcher<ABI>(
		declaredMethodsOnly(provider),
		contractsData as any,
		options.fetch ?? {},
		options.parse,
	);

	const passThrough = <T>(promise: Promise<T>) => promise;
	const eventStream: LogEvent<ABI>[] = [];
	let next = fromBlock;
	while (next <= toBlock) {
		const {events, toBlockUsed} = await fetcher.getLogEvents({fromBlock: next, toBlock}, passThrough);
		eventStream.push(...events);
		options.onProgress?.({
			fromBlock: next,
			toBlock: toBlockUsed,
			events: events.length,
			totalEvents: eventStream.length,
		});
		if (toBlockUsed < next) {
			throw new Error(`captureStream made no progress at block ${next}`);
		}
		next = toBlockUsed + 1;
	}

	return {
		format: STREAM_FIXTURE_FORMAT,
		provenance: {
			capturedAt: new Date().toISOString(),
			chainId: source.chainId,
			fromBlock,
			toBlock,
			...options.provenance,
		},
		source,
		lastSync: {
			context: {
				// The SAME producer the indexer uses, so a fixture captured from a source
				// that declares event block ranges is still recognised when it is replayed
				// through `replayStream`.
				source: sourceHashesOf(source),
				// Through the one resolve-then-hash step, like every other site: a fixture
				// captured with `finality` left unset must replay into an indexer that
				// resolved the same default, or the load path reads the stream as belonging
				// to another config and clears it.
				config: streamConfigHashOf(options.streamConfig),
				// A stream is processor-independent: the same logs feed any processor,
				// and which one will read this fixture is not knowable at capture time.
				// It is left empty rather than filled with a plausible-looking digest,
				// because `sourceInvalidationOf` does not consult it and a fake one would only
				// mislead a human reading the file.
				processor: '',
			},
			latestBlock: toBlock,
			lastFromBlock: fromBlock,
			lastToBlock: toBlock,
			unconfirmedBlocks: [],
		},
		eventStream,
	};
}
