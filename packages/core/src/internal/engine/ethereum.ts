import {
	EIP1193Account,
	EIP1193Block,
	EIP1193DATA,
	EIP1193GenericRequest,
	EIP1193Log,
	EIP1193ProviderWithoutEvents,
} from 'eip-1193';

import {logs} from 'named-logs';
import type {ArgumentFilter, IncludedEIP1193Log} from '../../types.js';
import {UnlessCancelledFunction} from '../utils/promises.js';
const namedLogger = logs('@etherfold/core:ethereum');

export type ExtendedEIP1193Provider = EIP1193ProviderWithoutEvents &
	Partial<{
		request(args: {method: 'eth_batch'; params: EIP1193GenericRequest[]}): Promise<unknown[]>;
	}>;

export async function getBlockNumber(provider: EIP1193ProviderWithoutEvents): Promise<number> {
	const blockAsHexString = await provider.request({method: 'eth_blockNumber'});
	return parseInt(blockAsHexString.slice(2), 16);
}

export async function getChainId(provider: EIP1193ProviderWithoutEvents): Promise<string> {
	const blockAsHexString = await provider.request({method: 'eth_chainId'});
	return parseInt(blockAsHexString.slice(2), 16).toString();
}

// NOTE: only interested in the timestamp for now
export async function getBlockData(
	provider: EIP1193ProviderWithoutEvents,
	hash: EIP1193DATA,
): Promise<{timestamp: number}> {
	const blockWithHexStringFields = await provider.request({method: 'eth_getBlockByHash', params: [hash, false]});
	if (!blockWithHexStringFields) {
		throw new Error(`could not fetch block`);
	}
	return {
		timestamp: parseInt(blockWithHexStringFields.timestamp.slice(2), 16),
	};
}

// NOTE: only interested in the timestamp for now
export async function getBlockDataFromMultipleHashes(
	provider: EIP1193ProviderWithoutEvents,
	hashes: string[],
): Promise<{timestamp: number}[]> {
	const requests: EIP1193GenericRequest[] = [];
	for (const hash of hashes) {
		requests.push({
			method: 'eth_getBlockByHash',
			params: [hash, false],
		});
	}
	const blocksWithHexStringFields = await (provider as ExtendedEIP1193Provider).request({
		method: 'eth_batch',
		params: requests,
	});

	return (blocksWithHexStringFields as EIP1193Block[]).map((block) => ({
		timestamp: parseInt(block.timestamp.slice(2), 16),
	}));
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
 * The logs of one block range, over WHATEVER set of requests the planner asked
 * for: one when nothing is filtered, several when something is.
 *
 * This is the single path the fetcher takes, filters or not. A single request is
 * returned exactly as the node answered it, with no sort and no de-duplication:
 * that is what keeps the unfiltered case byte-for-byte the call it always was,
 * and it is also the honest answer, since only MULTIPLE overlapping filters can
 * hand back one log twice or out of order.
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
	for (const request of requestList) {
		const tmpLogs = await unlessCancelled(getLogs(provider, request.contractAddresses, request.topics, options));
		logs.push(...tmpLogs);
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
