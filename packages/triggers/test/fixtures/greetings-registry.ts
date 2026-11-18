import type {Abi, LogEvent} from '@etherfold/core';
import {encodeAbiParameters, encodeEventTopics} from 'viem';

// ---------------------------------------------------------------------------
// jolly-roger's GreetingsRegistry, as far as its indexer folds it: the one
// event (`contracts/src/GreetingsRegistry/GreetingsRegistry.sol`,
// `event MessageChanged(address indexed user, string message)`), with no count
// in it, and a log of it as a node reports it.
// ---------------------------------------------------------------------------

export const greetingsRegistryAbi = [
	{
		type: 'event',
		name: 'MessageChanged',
		anonymous: false,
		inputs: [
			{indexed: true, name: 'user', type: 'address'},
			{indexed: false, name: 'message', type: 'string'},
		],
	},
] as const satisfies Abi;

export type GreetingsRegistryABI = typeof greetingsRegistryAbi;

export const GREETINGS_REGISTRY = '0x000000000000000000000000000000000000c0de' as const;

let transactionCounter = 0;

/** One `MessageChanged` log: `user` set their greeting to `message`. */
export function messageChanged(log: {
	block: number;
	hash: `0x${string}`;
	user: string;
	message: string;
	logIndex?: number;
}): LogEvent<GreetingsRegistryABI> {
	transactionCounter++;
	return {
		blockNumber: log.block,
		blockHash: log.hash,
		blockTimestamp: 1_700_000_000 + log.block * 12,
		transactionIndex: 0,
		removed: false,
		address: GREETINGS_REGISTRY,
		data: encodeAbiParameters([{type: 'string'}], [log.message]),
		topics: encodeEventTopics({
			abi: greetingsRegistryAbi,
			eventName: 'MessageChanged',
			args: {user: log.user as `0x${string}`},
		}),
		transactionHash: `0x${transactionCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex: log.logIndex ?? 0,
		extra: undefined,
		eventName: 'MessageChanged',
		args: {user: log.user, message: log.message},
	} as unknown as LogEvent<GreetingsRegistryABI>;
}
