import {EIP1193Account, EIP1193DATA, EIP1193ProviderWithoutEvents} from 'eip-1193';
import {logs} from 'named-logs';
import {IncludedEIP1193Log} from '../../types.js';
import {UnlessCancelledFunction} from '../utils/promises.js';
import {canOccurIn, type TopicBlockRanges} from './eventRanges.js';
import {ExtraFilters, getLogsWithVariousFilters} from './ethereum.js';

const namedLogger = logs('@etherfold/core');

type InternalLogFetcherConfig = {
	numBlocksToFetchAtStart: number;
	maxBlocksPerFetch: number;
	percentageToReach: number;
	maxEventsPerFetch: number;
	numRetry: number;
};

export type LogsResult = {logs: IncludedEIP1193Log[]; toBlockUsed: number};

export type LogFetcherConfig = {
	numBlocksToFetchAtStart?: number;
	maxBlocksPerFetch?: number;
	percentageToReach?: number;
	maxEventsPerFetch?: number;
	numRetry?: number;
	filters?: ExtraFilters;
};

export function getNewToBlockFromError(error: any): number | undefined {
	const message: string | undefined = error.message;
	// -32005: limit exceeded (provider returned too many results)
	// -32602: invalid params, but some providers use it to signal a too-large range.
	//   We only treat it as a range hint when the message actually mentions a result/range limit,
	//   otherwise a generic "invalid params" error could be mis-parsed into a bogus toBlock.
	const looksLikeRangeHint = !!message && (message.indexOf('results') !== -1 || message.indexOf('block range') !== -1);
	if (error.code === -32005 || (error.code === -32602 && looksLikeRangeHint)) {
		if (message && message.startsWith('query returned more than 10000 results.')) {
			// query returned more than 10000 results. Try with this block range [0xEC23E8, 0xEC23F5].
			namedLogger.error(message);
		}
		const regex = /\[.*\]/gm;
		const result = message ? regex.exec(message) : null;
		let values: number[] | undefined;
		if (result && result[0]) {
			values = result[0]
				.slice(1, result[0].length - 1)
				.split(', ')
				.map((v) => parseInt(v.slice(2), 16));
		}

		if (values && !isNaN(values[1])) {
			return values[1];
		}
	}
	return undefined;
}

/**
 * `eth_getLogs` over a block range, adapting the range to what the node will
 * actually answer.
 *
 * Named for what it is (ONE range, fetched adaptively) rather than for the
 * component: the **log-fetcher** of ADR-0003 is the public `LogFetcher`, which
 * is a deployable that asks a receiver where to start, fetches and pushes. This
 * is the primitive underneath it, shared with the single-process
 * `IndexerGeneration`.
 *
 * The property both of them are built on is `toBlockUsed`: when a node caps a
 * result set, the range SHRINKS and the answer says how far it really got. A
 * caller that ignored it would treat a short answer as a complete one, which on
 * the wire means a receiver reading missing logs as a reorg and deleting state.
 */
export class RangeLogFetcher {
	protected readonly config: InternalLogFetcherConfig;
	protected numBlocksToFetch: number;
	protected foundNumBlockToHigh: number | undefined;
	protected safeNumBlock: number | undefined;
	constructor(
		protected provider: EIP1193ProviderWithoutEvents,
		protected contractAddresses: EIP1193Account[] | null,
		protected eventNameTopics: EIP1193DATA[] | null,
		readonly conf: LogFetcherConfig = {},
		/**
		 * The DECLARED live ranges of each topic, so a block range asks only for the
		 * events that can occur in it. Empty (the default) narrows nothing.
		 */
		protected readonly topicBlockRanges: TopicBlockRanges = new Map(),
	) {
		this.config = Object.assign(
			{
				numBlocksToFetchAtStart: 50,
				percentageToReach: 80,
				maxEventsPerFetch: 10000,
				maxBlocksPerFetch: 100000,
				numRetry: 3,
			},
			conf,
		);
		this.numBlocksToFetch = Math.min(this.config.numBlocksToFetchAtStart, this.config.maxBlocksPerFetch);
	}

	/**
	 * The topics that can occur in `[fromBlock, toBlock]`, or `null` when nothing
	 * narrows and the fetcher must ask for exactly what it has always asked for.
	 *
	 * This is the ONE place a topic is REMOVED from a request, and an unrequested
	 * topic produces no error, no log and no fetch: afterwards a chain that had
	 * none and a request nobody made look identical. So an omission may follow
	 * from a DECLARED range and nothing else -- not an observed first appearance,
	 * not a contract's `startBlock`, not the fact that an event has never been
	 * seen. An event with no `lastBlock` is open-ended and is never dropped above
	 * its `firstBlock`.
	 */
	protected topicsThatCanOccurIn(fromBlock: number, toBlock: number): EIP1193DATA[] | null {
		if (!this.eventNameTopics || this.topicBlockRanges.size === 0) {
			return null;
		}
		return this.eventNameTopics.filter((topic) =>
			canOccurIn(this.topicBlockRanges.get(topic as `0x${string}`), fromBlock, toBlock),
		);
	}

	async getLogs(
		options: {fromBlock: number; toBlock: number; retry?: number},
		unlessCancelled: UnlessCancelledFunction,
	): Promise<LogsResult> {
		let retry = options.retry !== undefined ? options.retry : this.config.numRetry;
		let logs: IncludedEIP1193Log[];

		const fromBlock = options.fromBlock;
		let toBlock = Math.min(options.toBlock, fromBlock + this.numBlocksToFetch - 1);
		// on the range actually REQUESTED, which the line above may have shrunk
		const narrowedTopics = this.topicsThatCanOccurIn(fromBlock, toBlock);
		const topicsToRequest = narrowedTopics ?? this.eventNameTopics;
		try {
			if (narrowedTopics && narrowedTopics.length === 0) {
				// No DECLARED event is live anywhere in this range, so there is nothing to
				// ask for -- and asking with an empty topic list would ask for EVERY log,
				// since a node reads an empty position as a wildcard. This branch must
				// survive every refactor of the planner below it: it is the ONE case where
				// the right number of calls is zero.
				logs = [];
			} else {
				// ONE path, filters or not. The planner decides how many requests that is,
				// and with nothing filtered it is the single call it has always been.
				logs = await getLogsWithVariousFilters(
					this.provider,
					this.contractAddresses,
					topicsToRequest,
					this.conf.filters || null,
					{
						fromBlock,
						toBlock,
					},
					unlessCancelled,
				);
			}
		} catch (err: any) {
			if (retry <= 0) {
				throw err;
			}
			let numBlocksToFetchThisTime = this.numBlocksToFetch;
			// ----------------------------------------------------------------------
			// compute the new number of block to fetch this time:
			// ----------------------------------------------------------------------
			const toBlockClue = getNewToBlockFromError(err);
			if (toBlockClue) {
				const totalNumOfBlocksToFetch = toBlockClue - fromBlock + 1;
				if (totalNumOfBlocksToFetch > 1) {
					numBlocksToFetchThisTime = Math.floor((totalNumOfBlocksToFetch * this.config.percentageToReach) / 100);
				}
			} else {
				const totalNumOfBlocksThatWasFetched = toBlock - fromBlock;
				// "block range too large"
				if (err.code === -32603 && err.data && err.data.message) {
					if (err.data.message.indexOf('block range is too wide') !== -1) {
						// found on polygon rpc
						this.foundNumBlockToHigh = Math.min(
							this.foundNumBlockToHigh || this.config.maxBlocksPerFetch,
							totalNumOfBlocksThatWasFetched,
						);
					} else if (err.data.message.indexOf('block range too large') !== -1) {
						// found on base rpc
						this.foundNumBlockToHigh = Math.min(
							this.foundNumBlockToHigh || this.config.maxBlocksPerFetch,
							totalNumOfBlocksThatWasFetched,
						);
					}
				}

				if (totalNumOfBlocksThatWasFetched > 1) {
					numBlocksToFetchThisTime = Math.floor(totalNumOfBlocksThatWasFetched / 2);
				} else {
					numBlocksToFetchThisTime = 1;
				}
			}
			// ----------------------------------------------------------------------

			this.numBlocksToFetch = numBlocksToFetchThisTime;
			if (this.foundNumBlockToHigh && this.foundNumBlockToHigh < this.numBlocksToFetch) {
				if (this.safeNumBlock) {
					this.numBlocksToFetch = Math.min(
						Math.floor((this.foundNumBlockToHigh - this.safeNumBlock) / 2),
						this.foundNumBlockToHigh - 1,
					);
				} else {
					this.numBlocksToFetch = this.foundNumBlockToHigh - 1;
				}
			}

			toBlock = fromBlock + this.numBlocksToFetch - 1;
			const result = await this.getLogs(
				{
					fromBlock,
					toBlock,
					retry: retry - 1,
				},
				unlessCancelled,
			);
			logs = result.logs;
			toBlock = result.toBlockUsed;
		}

		const targetNumberOfLog = Math.max(
			1,
			Math.floor((this.config.maxEventsPerFetch * this.config.percentageToReach) / 100),
		);
		const totalNumOfBlocksThatWasFetched = toBlock - fromBlock + 1;

		this.safeNumBlock = Math.max(this.safeNumBlock || 0, totalNumOfBlocksThatWasFetched);

		if (this.foundNumBlockToHigh) {
			if (this.safeNumBlock) {
				this.numBlocksToFetch = Math.min(
					this.safeNumBlock + Math.floor((this.foundNumBlockToHigh - this.safeNumBlock) / 2),
					this.foundNumBlockToHigh - 1,
				);
			} else {
				this.numBlocksToFetch = this.foundNumBlockToHigh - 1;
			}
		} else {
			if (logs.length === 0) {
				this.numBlocksToFetch = this.config.maxBlocksPerFetch;
			} else {
				this.numBlocksToFetch = Math.min(
					this.config.maxBlocksPerFetch,
					Math.max(1, Math.floor((targetNumberOfLog * totalNumOfBlocksThatWasFetched) / logs.length)),
				);
			}
		}

		return {logs, toBlockUsed: toBlock};
	}
}
