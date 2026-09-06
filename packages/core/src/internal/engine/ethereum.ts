import {
	EIP1193Account,
	EIP1193Block,
	EIP1193DATA,
	EIP1193GenericRequest,
	EIP1193Log,
	EIP1193ProviderWithoutEvents,
	EIP1193TransactionReceipt,
} from 'eip-1193';

import {logs} from 'named-logs';
import type {IncludedEIP1193Log} from '../../types.js';
import {UnlessCancelledFunction} from '../utils/promises.js';
const namedLogger = logs('@etherfold/core:ethereum');

/**
 * Data from the tx that emitted the log.
 * It is not automatically added to the log as this require fetching extra information.
 */
export type LogTransactionData = {
	/**
	 * tx.origin, signer of the tx.
	 */
	from: string;
	/**
	 * Gas amount used by the tx.
	 */
	gasUsed: number;
	/**
	 * The sum of the base fee and tip paid per unit of gas by the tx.
	 * (In hex format)
	 */
	effectiveGasPrice: `0x${string}`;
};

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

export async function getTransactionData(
	provider: EIP1193ProviderWithoutEvents,
	hash: EIP1193DATA,
): Promise<LogTransactionData> {
	const transactionReceiptWithHexStringFields = await provider.request({
		method: 'eth_getTransactionReceipt',
		params: [hash],
	});

	if (!transactionReceiptWithHexStringFields) {
		throw new Error(`could not fetch receipt`);
	}

	return {
		from: transactionReceiptWithHexStringFields.from,
		gasUsed: parseInt(transactionReceiptWithHexStringFields.gasUsed.slice(2), 16),
		effectiveGasPrice: transactionReceiptWithHexStringFields.effectiveGasPrice,
	};
}

export async function getTransactionDataFromMultipleHashes(
	provider: EIP1193ProviderWithoutEvents,
	hashes: string[],
): Promise<LogTransactionData[]> {
	const requests: EIP1193GenericRequest[] = [];
	for (const hash of hashes) {
		requests.push({
			method: 'eth_getTransactionReceipt',
			params: [hash],
		});
	}
	const transactionReceiptsWithHexStringFields = <EIP1193TransactionReceipt[]>(
		await (provider as ExtendedEIP1193Provider).request({method: 'eth_batch', params: requests})
	);

	return transactionReceiptsWithHexStringFields.map((transaction) => {
		return {
			from: transaction.from,
			gasUsed: parseInt(transaction.gasUsed.slice(2), 16),
			effectiveGasPrice: transaction.effectiveGasPrice,
			// value: transaction.value
		};
	});
}

type LogRequest = {topics: (`0x${string}` | `0x${string}`[])[]; contractAddresses: `0x${string}`[] | null};
/**
 * The `eth_getLogs` calls that together cover every topic0, filtered and
 * unfiltered.
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
 * That is exactly what the shared request used to be built as: the topic0s with
 * no argument filter were pushed FLAT into one array, so configuring a filter on
 * ONE event silently unrequested every other event whenever two or more of them
 * were left over. With a single leftover topic0 the flat form is accidentally
 * identical to the nested one, which is part of why it survived.
 */
export function generateLogRequestForTopicsAndFiltersCombinations(
	contractAddresses: `0x${string}`[] | null,
	eventNameTopics: EIP1193DATA[],
	filters?: {
		[topicSignature: `0x${string}`]: {contractAddresses?: `0x${string}`[]; list: (`0x${string}` | `0x${string}`[])[][]};
	},
): LogRequest[] {
	if (!filters) {
		return [{topics: [eventNameTopics], contractAddresses}];
	} else {
		// the topic0s NOBODY filtered, which belong in ONE slot as an OR list -- the
		// same shape the no-filter path above emits, and for the same reason
		const sharedTopic0s: EIP1193DATA[] = [];
		const moreRequests: LogRequest[] = [];
		for (const eventNameTopic of eventNameTopics) {
			const filtersPerEventTopic = filters[eventNameTopic];
			if (filtersPerEventTopic) {
				for (const filter of filtersPerEventTopic.list) {
					moreRequests.push({
						topics: [eventNameTopic, ...filter],
						contractAddresses: filtersPerEventTopic.contractAddresses || contractAddresses,
					});
				}
			} else {
				sharedTopic0s.push(eventNameTopic);
			}
		}
		// TODO optimise further and combine eventNameTopic's filters who share the same filter
		if (sharedTopic0s.length > 0) {
			return [{topics: [sharedTopic0s], contractAddresses}, ...moreRequests];
		} else {
			return moreRequests;
		}
	}
}

export type ExtraFilters = {
	[topicSignature: `0x${string}`]: {contractAddresses?: `0x${string}`[]; list: (`0x${string}` | `0x${string}`[])[][]};
};
export async function getLogsWithVariousFilters(
	provider: EIP1193ProviderWithoutEvents,
	contractAddresses: EIP1193Account[] | null,
	eventNameTopics: EIP1193DATA[] | null,
	filters: ExtraFilters | null,
	options: {fromBlock: number; toBlock: number},
	unlessCancelled: UnlessCancelledFunction,
): Promise<IncludedEIP1193Log[]> {
	if (!eventNameTopics) {
		return getLogs(provider, contractAddresses, eventNameTopics ? [eventNameTopics] : null, options);
	}
	const requestList = generateLogRequestForTopicsAndFiltersCombinations(
		contractAddresses,
		eventNameTopics,
		filters ? filters : undefined,
	);

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
	topics: (EIP1193DATA | EIP1193DATA[])[] | null,
	options: {fromBlock: number; toBlock: number},
): Promise<IncludedEIP1193Log[]> {
	const logs: EIP1193Log[] = await provider.request({
		method: 'eth_getLogs',
		params: [
			{
				address: contractAddresses ? contractAddresses : undefined,
				fromBlock: ('0x' + options.fromBlock.toString(16)) as EIP1193DATA,
				toBlock: ('0x' + options.toBlock.toString(16)) as EIP1193DATA,
				topics: topics ? topics : undefined,
			},
		],
	});
	return logs.filter((v) => v.blockNumber !== null) as IncludedEIP1193Log[];
}
