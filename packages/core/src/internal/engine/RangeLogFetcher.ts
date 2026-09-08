import {EIP1193Account, EIP1193DATA, EIP1193ProviderWithoutEvents} from 'eip-1193';
import {logs} from 'named-logs';
import {ArchiveRefusedError} from '../../errors.js';
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

/**
 * Whether a piece of provider text is complaining about a RANGE at all.
 *
 * This gate looks redundant and is not: `-32602` and `-32000` are GENERIC codes,
 * so a refusal arriving under one may be about anything. The case it earns its
 * keep on is a real one -- `ethereum-rpc.publicnode.com` refuses history with
 * `-32602 "Archive requests require a personal token..."`, which mentions
 * neither marker -- and the cost of getting it wrong is not a missed hint but a
 * BOGUS one: a bracketed pair lifted out of an unrelated message becomes a
 * `toBlock` the fetcher then retries against, for a refusal no range size can
 * ever satisfy. Widening the accepted CODES (below) is therefore not a licence
 * to widen these two markers. That same archive refusal is now also RECOGNISED,
 * by {@link archiveRefusalFromError}, and reported as terminal instead of being
 * halved at; this gate is what keeps the two from ever reading it as a range.
 *
 * Pinned by `packages/core/test/rangeLogFetcher.test.ts`.
 */
function looksLikeRangeHint(text: unknown): text is string {
	return typeof text === 'string' && (text.indexOf('results') !== -1 || text.indexOf('block range') !== -1);
}

/**
 * The `toBlock` a provider SUGGESTED in prose, as `[0x..., 0x...]`.
 *
 * `"query returned more than 10000 results. Try with this block range [0xEC23E8, 0xEC23F5]."`
 * -> `0xEC23F5`. Only ever called on text that passed {@link looksLikeRangeHint},
 * or under a code that means nothing else.
 */
function suggestedToBlockFromProse(text: string): number | undefined {
	const regex = /\[.*\]/gm;
	const result = regex.exec(text);
	if (!result || !result[0]) {
		return undefined;
	}
	const values = result[0]
		.slice(1, result[0].length - 1)
		.split(', ')
		.map((v) => parseInt(v.slice(2), 16));
	return isNaN(values[1]) ? undefined : values[1];
}

/**
 * The `toBlock` a provider stated as STRUCTURED data: `{from, to, limit}`.
 *
 * Infura sends exactly this alongside the same information in English
 * (`{"code":-32005,"data":{"from":"0xBDE5F8","limit":10000,"to":"0x102DBCC"},...}`,
 * quoted verbatim in ethers-io/ethers.js#4703), and it is the one shape that says
 * what to do next without a regex over prose.
 *
 * `limit` is REQUIRED even though only `to` is read, and that is the gate of this
 * path rather than a formality: `limit` is the node's own cap, so an object
 * carrying it is DESCRIBING A REFUSAL, while an object carrying a bare `to` might
 * just as well be a provider echoing the request back (some do put the request
 * body in `data`). Reading `to` out of an echo would hand the retry the very
 * range that was refused. `from` is not needed and is not required.
 */
function suggestedToBlockFromStructuredData(data: any): number | undefined {
	if (!data || typeof data !== 'object') {
		return undefined;
	}
	if (typeof data.to !== 'string' || typeof data.limit !== 'number') {
		return undefined;
	}
	const to = parseInt(data.to.slice(0, 2).toLowerCase() === '0x' ? data.to.slice(2) : data.to, 16);
	return isNaN(to) ? undefined : to;
}

/**
 * How far a refused `eth_getLogs` range should shrink, according to the node that
 * refused it, or `undefined` when the node said nothing usable and the caller
 * should fall back to halving.
 *
 * A node REFUSES an oversized query rather than truncating it, and it bounds the
 * method in one of two incompatible ways -- a BLOCK SPAN or a RESULT COUNT -- which
 * is why no fixed page size works and why the caller adapts. What it says while
 * refusing is read from the most reliable place first:
 *
 * 1. `error.data` as a `{from, to, limit}` descriptor (Infura), which is the
 *    answer without a regex;
 * 2. `error.data` as PROSE, which is where Nethermind puts the whole hint while
 *    leaving the message at a bare `"invalid params"` (Gnosis, Fraxtal), so a
 *    reader that only looked at the message discarded it entirely;
 * 3. the message.
 *
 * Three codes are accepted. `-32005` (limit exceeded) means one thing, so it needs
 * no gate. `-32602` (invalid params) and `-32000` (a widely used generic server
 * error, which several providers put range complaints behind: Polygon zkEVM,
 * PulseChain, Merlin, Immutable) are GENERIC, so each piece of text is read only
 * if it passes {@link looksLikeRangeHint} ON ITS OWN -- never on the strength of
 * the other, or a hint in `data` would license lifting a bracketed pair out of an
 * unrelated message. The STRUCTURED path takes no hint gate, because that gate is
 * for disambiguating PROSE and a `{to, limit}` descriptor is not prose; what
 * guards it is the required `limit`, above.
 *
 * Everything here is additive to the caller's halving fallback, which is what
 * makes the fetcher work against an endpoint that says nothing useful at all.
 *
 * Captured refusal shapes, their providers and their dates:
 * `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` and
 * `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/`.
 */
export function getNewToBlockFromError(error: any): number | undefined {
	if (!error) {
		return undefined;
	}
	const code = error.code;
	if (code !== -32005 && code !== -32602 && code !== -32000) {
		return undefined;
	}
	// -32005 says "limit exceeded" and nothing else; the other two are generic codes
	// that carry a range complaint only when the text says so.
	const needsAHint = code !== -32005;

	const message: string | undefined = error.message;
	if (message && message.startsWith('query returned more than 10000 results.')) {
		// query returned more than 10000 results. Try with this block range [0xEC23E8, 0xEC23F5].
		namedLogger.error(message);
	}

	const structured = suggestedToBlockFromStructuredData(error.data);
	if (structured !== undefined) {
		return structured;
	}

	// `data` before `message`: a provider that fills both in says the same thing
	// twice, and a provider that fills in only `data` (Nethermind) says it only there.
	for (const text of [error.data, message]) {
		if (typeof text !== 'string') {
			continue;
		}
		if (needsAHint && !looksLikeRangeHint(text)) {
			continue;
		}
		const toBlock = suggestedToBlockFromProse(text);
		if (toBlock !== undefined) {
			return toBlock;
		}
	}
	return undefined;
}

/**
 * The ENTITLEMENT half of an archive refusal: the words a provider uses when it
 * is saying that history is behind a credential or a plan, rather than that its
 * archive is having a bad day.
 *
 * Required IN ADDITION to the word `archive`, and that conjunction is the whole
 * width of the classifier. `archive` alone is too eager: "archive node is
 * syncing" and "archive backend temporarily unavailable" are TRANSIENT, and
 * calling either terminal stops an indexer for a blip -- which is a worse
 * failure than the grinding this exists to fix, because grinding is slow and
 * visible while a false terminal is fast and wrong. An entitlement word alone is
 * too eager in the other direction: `rpc.ankr.com` refuses an unauthenticated
 * request with "You must authenticate your request with an API key", which is
 * about the endpoint rather than about serving history, and every deployment
 * that briefly loses its key would become terminal.
 */
const ARCHIVE_ACCESS_GATE = /\b(tokens?|api ?keys?|plans?|upgrade|unsupported|not supported|not enabled)\b/;

/** Whether one piece of provider text says history is GATED rather than unavailable. */
function looksLikeArchiveRefusal(text: unknown): text is string {
	if (typeof text !== 'string') {
		return false;
	}
	const lowered = text.toLowerCase();
	return lowered.indexOf('archive') !== -1 && ARCHIVE_ACCESS_GATE.test(lowered);
}

/**
 * The provider's own words, when it refused because the HISTORY asked for needs
 * an archive node it will not give this connection -- and `undefined` for every
 * refusal that is anything else, including every refusal we merely cannot
 * classify.
 *
 * The companion of {@link getNewToBlockFromError}, and the two never overlap by
 * construction: this reads a refusal that is not about a range at all, which is
 * why `looksLikeRangeHint` already REJECTS the captured archive body (a `-32602`
 * mentioning neither `results` nor `block range`). A hit here is TERMINAL for the
 * endpoint -- `RangeLogFetcher.getLogs` stops rather than halving, and
 * `ArchiveRefusedError` says so with `retryable: false` -- so the bar for a hit
 * is a refusal that IDENTIFIES ITSELF (see {@link ARCHIVE_ACCESS_GATE}) and
 * everything ambiguous is left to the halving path it has always taken.
 *
 * The text is read from `data` before the message, exactly as the range hint is,
 * because that is where a Nethermind-style node puts its whole complaint while
 * leaving the message at a bare `"invalid params"`. It is returned rather than
 * merely detected so the refusal can be quoted back to the operator verbatim,
 * instead of the fetcher paraphrasing a node.
 *
 * No error CODE is required, and that is deliberate: the captured refusal is a
 * `-32602`, but the codes providers put this behind are as inconsistent as the
 * ones they put range complaints behind (the spike found range refusals under
 * seven different codes), and the identifying evidence here is the text.
 *
 * Captured refusal shapes, their providers and their dates:
 * `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` and
 * `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/`.
 */
export function archiveRefusalFromError(error: any): string | undefined {
	if (!error) {
		return undefined;
	}
	for (const text of [error.data, error.data?.message, error.message]) {
		if (looksLikeArchiveRefusal(text)) {
			return text;
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
			const archiveRefusal = archiveRefusalFromError(err);
			if (archiveRefusal !== undefined) {
				// Checked BEFORE the retry budget and before any hint is read: this is the one
				// refusal a smaller range cannot answer, so halving into it burns the budget and
				// then reports the wrong cause. It is checked on the LAST attempt too, so an
				// endpoint that starts gating history mid-backfill still names the real reason.
				throw new ArchiveRefusedError(fromBlock, toBlock, archiveRefusal);
			}
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
