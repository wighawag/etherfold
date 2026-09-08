import {EIP1193Account, EIP1193DATA, EIP1193Log, EIP1193ProviderWithoutEvents} from 'eip-1193';

import {logs} from 'named-logs';
import type {ArgumentFilter, IncludedEIP1193Log} from '../../types.js';
import {UnlessCancelledFunction} from '../utils/promises.js';
const namedLogger = logs('@etherfold/core:ethereum');

export async function getBlockNumber(provider: EIP1193ProviderWithoutEvents): Promise<number> {
	const blockAsHexString = await provider.request({method: 'eth_blockNumber'});
	return parseInt(blockAsHexString.slice(2), 16);
}

export async function getChainId(provider: EIP1193ProviderWithoutEvents): Promise<string> {
	const blockAsHexString = await provider.request({method: 'eth_chainId'});
	return parseInt(blockAsHexString.slice(2), 16).toString();
}

export type LogRequest = {
	topics: (`0x${string}` | `0x${string}`[] | null)[];
	contractAddresses: `0x${string}`[] | null;
};

/**
 * ONE resolved instruction about ONE `topic0`, already reduced against the
 * source: which addresses it applies to, and whether it constrains anything.
 *
 * `ExtraFilters` is a LIST rather than a map keyed by `topic0` because two rules
 * can now target one `topic0` (one scoped to the NFT, one to the token) and a
 * map could hold only the last of them. Resolution happens ONCE, in
 * `LogEventFetcher`'s constructor, which is the only place that knows which
 * addresses declare what; the planner below does no ABI reasoning at all.
 */
export type ExtraFilter =
	| {
			/** Ask for this `topic0` at these addresses, constrained by `match`. */
			kind: 'match';
			topic0: `0x${string}`;
			/** `null` means the whole source: an address-less source has no address to scope by. */
			contractAddresses: `0x${string}`[] | null;
			/** ONE entry of a rule's `match`. The OR across entries is one of these each. */
			match: ArgumentFilter;
	  }
	| {
			/**
			 * Ask for this `topic0` UNFILTERED, at the addresses no rule reached.
			 *
			 * This is "an address nobody filtered is not filtered" made a value. An
			 * empty address list is emitted by nobody: a `topic0` every rule covers has
			 * no leftover entry at all.
			 */
			kind: 'leftover';
			topic0: `0x${string}`;
			/** `null` means the whole source, which is what an UNTOUCHED `topic0` gets. */
			contractAddresses: `0x${string}`[] | null;
	  };

export type ExtraFilters = ExtraFilter[];

/** The address scope of a request, as a key a group can be collected under. */
function addressScopeKey(contractAddresses: `0x${string}`[] | null): string {
	return contractAddresses === null ? '*' : contractAddresses.join(',');
}

/**
 * Trailing wildcards constrain nothing, so they are dropped before the request
 * is written: `[me, null, null]` and `[me]` are the same question, and asking it
 * two ways would make two requests out of one.
 */
function withoutTrailingWildcards(match: ArgumentFilter): ArgumentFilter {
	let end = match.length;
	while (end > 0 && match[end - 1] === null) {
		end--;
	}
	return match.slice(0, end);
}

/**
 * The `eth_getLogs` calls that together cover every live `topic0`, filtered and
 * unfiltered. THE one request planner.
 *
 * ## A topics array is POSITIONAL, so slot 0 is the only place a topic0 goes
 *
 * `topics[i]` constrains the log's `topics[i]`: slot 0 is the event selector and
 * every later slot is an INDEXED ARGUMENT. Within a slot an array is an OR list;
 * ACROSS slots it is a conjunction. So several topic0s are expressed as ONE
 * nested slot (`[[t0a, t0b]]`) and never as several slots (`[t0a, t0b]`), which
 * asks instead for a log whose FIRST INDEXED ARGUMENT equals another event's
 * selector. Nothing satisfies that, so such a request returns nothing, quietly,
 * for ever.
 *
 * ## A filter restricts a (contract, topic0) pair, never a topic0
 *
 * Per live `topic0` T: one request per `match` entry reaching T, scoped to that
 * rule's addresses; and T joins a LEFTOVER group for the addresses no rule
 * reached. Leftover groups are collected by ADDRESS SET, so the topic0s nobody
 * filtered still travel together in one nested slot, and a `topic0` no rule
 * mentions at all is unscoped and lands in the group holding every address.
 *
 * With NO rule configured every `topic0` is untouched, so this emits exactly one
 * request over the whole address list with every `topic0` nested in slot 0 --
 * byte for byte what the no-filter path has always produced.
 *
 * Emitting MORE requests is always safe for correctness, because
 * `getLogsWithVariousFilters` unions and de-duplicates them; it costs round
 * trips and nothing else. The leftover groups come FIRST, so the ordering is
 * stable.
 */
export function generateLogRequestForTopicsAndFiltersCombinations(
	contractAddresses: `0x${string}`[] | null,
	eventNameTopics: EIP1193DATA[],
	filters?: ExtraFilters,
): LogRequest[] {
	if (!filters || filters.length === 0) {
		return [{topics: [eventNameTopics], contractAddresses}];
	}

	const live = new Set(eventNameTopics);
	const scopedRequests: LogRequest[] = [];
	// leftover topic0s, grouped by the ADDRESS SET they are left over at
	const leftoverGroups = new Map<string, {contractAddresses: `0x${string}`[] | null; topic0s: `0x${string}`[]}>();
	const mentioned = new Set<`0x${string}`>();

	const leftoverFor = (scope: `0x${string}`[] | null) => {
		const key = addressScopeKey(scope);
		let group = leftoverGroups.get(key);
		if (!group) {
			group = {contractAddresses: scope, topic0s: []};
			leftoverGroups.set(key, group);
		}
		return group;
	};

	for (const filter of filters) {
		mentioned.add(filter.topic0);
		if (!live.has(filter.topic0)) {
			// narrowed away by a declared block range: this range cannot contain it, so
			// its whole round trip goes with it
			continue;
		}
		if (filter.kind === 'leftover') {
			leftoverFor(filter.contractAddresses).topic0s.push(filter.topic0);
		} else {
			scopedRequests.push({
				topics: [filter.topic0, ...withoutTrailingWildcards(filter.match)],
				contractAddresses: filter.contractAddresses,
			});
		}
	}

	// A topic0 no rule mentions is UNSCOPED: an address nobody filtered is not
	// filtered, and nobody filtered any of them.
	for (const topic0 of eventNameTopics) {
		if (!mentioned.has(topic0 as `0x${string}`)) {
			leftoverFor(contractAddresses).topic0s.push(topic0 as `0x${string}`);
		}
	}

	const sharedRequests: LogRequest[] = [];
	for (const group of leftoverGroups.values()) {
		if (group.topic0s.length === 0) {
			continue;
		}
		sharedRequests.push({topics: [group.topic0s], contractAddresses: group.contractAddresses});
	}
	return [...sharedRequests, ...scopedRequests];
}
/**
 * How many of the planner's `eth_getLogs` calls may be in flight at once.
 *
 * A STATED number rather than the length of the request list, because that
 * length is CALLER-CONTROLLED: it is one request per (rule, `match` entry) plus
 * the leftover groups, so a configuration with twenty filters would otherwise
 * become a twenty-way burst at whatever endpoint the deployment points at, and a
 * public provider answers a burst with a rate limit -- which arrives as a
 * refusal the fetcher then reads as a range hint and halves against.
 *
 * Four is deliberately conservative. A browser allows six connections per origin
 * on HTTP/1.1 and the engine has three other methods to get down the same pipe
 * (the tip, the chain identity and the genesis probe), so this leaves headroom
 * rather than filling it, while still collapsing the common filtered
 * configurations -- two or three requests -- into a single round trip of
 * latency. It is a CONSTANT and not a `LogFetcherConfig` knob: nothing has
 * reported a deployment this number is wrong for, and a knob is a user-visible
 * default nobody can choose better than this one until something measures it.
 */
export const MAX_CONCURRENT_LOG_REQUESTS = 4;

/**
 * Issue the planner's request list CONCURRENTLY but BOUNDED, and hand back one
 * result array per request IN REQUEST ORDER.
 *
 * Order is by request and never by arrival, so the array the union is built from
 * is the array the sequential loop built, whatever order the node answers in.
 *
 * ## A partial answer is never returned
 *
 * The sequential loop threw out of `getLogsWithVariousFilters` on the first
 * rejection, and that is not incidental behaviour to be re-derived from whatever
 * a gather happens to do: under ADR-0004 a range delivered with logs missing is
 * read by the receiver as an ABSENCE, an absence is concluded as a REORG, and a
 * reorg reverts state. So a failure fails the whole fetch.
 *
 * Three things follow, and none of them is what a bare `Promise.all` does:
 *
 *   - the error that surfaces is the LOWEST-INDEXED failure, which is the one the
 *     sequential loop would have thrown, and it matters because the caller READS
 *     it for hints (`RangeLogFetcher.getLogs` parses a range cap, a result cap
 *     and an archive refusal out of it);
 *   - no NEW request is started once a failure is known, exactly as the loop
 *     never reached the requests after the failing one;
 *   - the requests already in flight are AWAITED before the error is rethrown, so
 *     nothing is orphaned and no rejection is left with nowhere to go.
 */
async function issueRequestsBounded(
	provider: EIP1193ProviderWithoutEvents,
	requestList: LogRequest[],
	options: {fromBlock: number; toBlock: number},
	unlessCancelled: UnlessCancelledFunction,
): Promise<IncludedEIP1193Log[][]> {
	const results: IncludedEIP1193Log[][] = new Array(requestList.length);
	// A LIST rather than a first-one-wins slot: several requests are in flight when
	// one fails, so more than one can fail, and which of them is reported is decided
	// below by INDEX and never by which rejected first.
	const failures: {index: number; error: any}[] = [];
	let nextIndex = 0;

	// Workers take the next unclaimed index, so the requests that have been STARTED
	// are always a prefix of the list -- which is what makes the lowest-indexed
	// failure the same error the sequential loop would have reported.
	async function worker(): Promise<void> {
		while (failures.length === 0 && nextIndex < requestList.length) {
			const index = nextIndex++;
			const request = requestList[index];
			try {
				results[index] = await unlessCancelled(getLogs(provider, request.contractAddresses, request.topics, options));
			} catch (err: any) {
				failures.push({index, error: err});
				return;
			}
		}
	}

	const workers: Promise<void>[] = [];
	for (let i = 0; i < Math.min(MAX_CONCURRENT_LOG_REQUESTS, requestList.length); i++) {
		workers.push(worker());
	}
	// A worker swallows its own rejection into `failures`, so this settles rather
	// than short-circuiting: every request that was issued is done by here.
	await Promise.all(workers);

	if (failures.length > 0) {
		throw failures.reduce((earliest, failure) => (failure.index < earliest.index ? failure : earliest)).error;
	}
	return results;
}

/**
 * The logs of one block range, over WHATEVER set of requests the planner asked
 * for: one when nothing is filtered, several when something is.
 *
 * This is the single path the fetcher takes, filters or not. A single request is
 * returned exactly as the node answered it, with no sort and no de-duplication:
 * that is what keeps the unfiltered case byte-for-byte the call it always was,
 * and it is also the honest answer, since only MULTIPLE overlapping filters can
 * hand back one log twice or out of order.
 *
 * SEVERAL requests are issued CONCURRENTLY, bounded by
 * {@link MAX_CONCURRENT_LOG_REQUESTS}: they are independent questions about one
 * block range, so N filters cost one round trip of latency instead of N. It
 * changes no answer, because the union below is fed the results in REQUEST order
 * either way.
 */
export async function getLogsWithVariousFilters(
	provider: EIP1193ProviderWithoutEvents,
	contractAddresses: EIP1193Account[] | null,
	eventNameTopics: EIP1193DATA[] | null,
	filters: ExtraFilters | null,
	options: {fromBlock: number; toBlock: number},
	unlessCancelled: UnlessCancelledFunction,
): Promise<IncludedEIP1193Log[]> {
	if (!eventNameTopics) {
		return unlessCancelled(getLogs(provider, contractAddresses, null, options));
	}
	const requestList = generateLogRequestForTopicsAndFiltersCombinations(
		contractAddresses,
		eventNameTopics,
		filters ? filters : undefined,
	);

	if (requestList.length === 1) {
		return unlessCancelled(getLogs(provider, requestList[0].contractAddresses, requestList[0].topics, options));
	}

	const logs: IncludedEIP1193Log[] = [];
	for (const perRequestLogs of await issueRequestsBounded(provider, requestList, options, unlessCancelled)) {
		logs.push(...perRequestLogs);
	}

	const sortedLogs = logs.sort((a, b) => {
		const aT = parseInt(a.blockNumber.slice(2), 16);
		const bT = parseInt(b.blockNumber.slice(2), 16);
		if (aT > bT) {
			return 1;
		} else if (aT < bT) {
			return -1;
		} else {
			const aL = parseInt(a.logIndex.slice(2), 16);
			const bL = parseInt(b.logIndex.slice(2), 16);
			if (aL > bL) {
				return 1;
			} else if (aL < bL) {
				return -1;
			} else {
				return 0;
			}
		}
	});

	const logsToReturn = [];
	let lastAdded: EIP1193Log | undefined;
	for (const sortedLog of sortedLogs) {
		if (lastAdded && sortedLog.blockHash === lastAdded.blockHash && sortedLog.logIndex === lastAdded.logIndex) {
			// since we use multiple filters, there is cases where the same log will appear multiple times
			// we remove the duplicates
			continue;
		}
		lastAdded = sortedLog;
		logsToReturn.push(sortedLog);
	}

	return logsToReturn;
}

export async function getLogs(
	provider: EIP1193ProviderWithoutEvents,
	contractAddresses: EIP1193Account[] | null,
	/**
	 * Positional, and `null` in a slot is the WILDCARD the method defines: match
	 * anything here. It reaches the node exactly as written.
	 */
	topics: (EIP1193DATA | EIP1193DATA[] | null)[] | null,
	options: {fromBlock: number; toBlock: number},
): Promise<IncludedEIP1193Log[]> {
	const logs: EIP1193Log[] = await provider.request({
		method: 'eth_getLogs',
		params: [
			{
				address: contractAddresses ? contractAddresses : undefined,
				fromBlock: ('0x' + options.fromBlock.toString(16)) as EIP1193DATA,
				toBlock: ('0x' + options.toBlock.toString(16)) as EIP1193DATA,
				// `eip-1193` types a topic slot as a topic or a list of topics, with no
				// `null` in it. The METHOD defines `null` as the match-anything wildcard
				// and every node serves it, so the type is narrower than the wire and the
				// cast is at the boundary where that is true, once.
				topics: topics ? (topics as (EIP1193DATA | EIP1193DATA[])[]) : undefined,
			},
		],
	});
	return logs.filter((v) => v.blockNumber !== null) as IncludedEIP1193Log[];
}
