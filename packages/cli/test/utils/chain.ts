import type {IndexingSource} from '@etherfold/core';
import type {EntityProcessor} from '@etherfold/processor-entities';
import {declareEntities} from '@etherfold/state-store';

// ---------------------------------------------------------------------------------------------------
// A CHAIN AND A PROCESSOR MODULE
// ---------------------------------------------------------------------------------------------------
// Everything the CLI tests need to drive `etherfold build` without a node: raw
// ERC-721 `Transfer` logs served by a fake provider, and the module shape the
// command loads.
// ---------------------------------------------------------------------------------------------------

export const abi = [
	{
		anonymous: false,
		inputs: [
			{indexed: true, internalType: 'address', name: 'from', type: 'address'},
			{indexed: true, internalType: 'address', name: 'to', type: 'address'},
			{indexed: true, internalType: 'uint256', name: 'id', type: 'uint256'},
		],
		name: 'Transfer',
		type: 'event',
	},
] as const;

/** Digits only, so the decoder's EIP-55 checksum casing cannot change what an assertion must quote. */
export const CONTRACT = '0x0000000000000000000000000000000000000099';
export const ALICE = '0x0000000000000000000000000000000000000011';
export const BOB = '0x0000000000000000000000000000000000000022';
export const CAROL = '0x0000000000000000000000000000000000000033';
export const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Realistic block numbers, deliberately.
 *
 * The unconfirmed window reaches `latestBlock - finality` (17 by default), so a
 * chain living at block 100 would put every resume back at block 0 and make
 * "did this run resume?" unanswerable. A start block well above the finality
 * depth is what makes the resumed fetch observable.
 */
export const START_BLOCK = 1_000_000;

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export type RawLog = {
	blockNumber: string;
	blockHash: string;
	transactionIndex: string;
	removed: boolean;
	address: string;
	data: string;
	topics: string[];
	transactionHash: string;
	logIndex: string;
	blockTimestamp: string;
};

const hex = (value: number | bigint) => `0x${value.toString(16)}`;
export const addressTopic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

/** A plausible timestamp for a block: 12s slots from a fixed epoch, so a store can record blocks. */
export const timestampOf = (blockNumber: number) => 1_600_000_000 + blockNumber * 12;

let logCounter = 0;

export function transfer(
	blockNumber: number,
	blockHash: string,
	from: string,
	to: string,
	id: bigint,
	logIndex = 0,
): RawLog {
	logCounter++;
	return {
		blockNumber: hex(blockNumber),
		blockHash,
		transactionIndex: '0x0',
		removed: false,
		address: CONTRACT,
		// every argument is indexed on this ABI, so the data is empty and the id rides in topic 3
		data: '0x',
		topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to), `0x${id.toString(16).padStart(64, '0')}`],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: hex(logIndex),
		blockTimestamp: hex(timestampOf(blockNumber)),
	};
}

/** A node that serves one branch of one chain at a time, and remembers what it was asked. */
export function fakeChain(chainId = 1) {
	const calls: {method: string; params?: any}[] = [];
	let served: RawLog[] = [];
	let tip = 0;
	return {
		calls,
		/** Every `eth_getLogs` this chain was asked for, in order. */
		get logRanges(): {from: number; to: number}[] {
			return calls
				.filter((call) => call.method === 'eth_getLogs')
				.map((call) => ({
					from: parseInt(call.params[0].fromBlock.slice(2), 16),
					to: parseInt(call.params[0].toBlock.slice(2), 16),
				}));
		},
		serve(logs: RawLog[], latestBlock: number) {
			served = logs;
			tip = latestBlock;
			return this;
		},
		provider: {
			async request(args: {method: string; params?: any}): Promise<any> {
				calls.push(args);
				switch (args.method) {
					case 'eth_chainId':
						return hex(chainId);
					case 'eth_blockNumber':
						return hex(tip);
					case 'eth_getLogs': {
						const from = parseInt(args.params[0].fromBlock.slice(2), 16);
						const to = parseInt(args.params[0].toBlock.slice(2), 16);
						return served.filter((log) => {
							const blockNumber = parseInt(log.blockNumber.slice(2), 16);
							return blockNumber >= from && blockNumber <= to;
						});
					}
				}
				throw new Error(`unexpected method ${args.method}`);
			},
		} as any,
	};
}

/** A provider that answers nothing, so a test can assert a refusal cost no RPC call. */
export function noChain() {
	const calls: string[] = [];
	return {
		calls,
		provider: {
			async request(args: {method: string}): Promise<never> {
				calls.push(args.method);
				throw new Error(`the CLI called ${args.method} before it had refused an impossible configuration`);
			},
		} as any,
	};
}

// ---------------------------------------------------------------------------------------------------
// the processors
// ---------------------------------------------------------------------------------------------------

/**
 * ONE description of the data, for the storage AND for the reads.
 *
 * `declareEntities` is an identity function that keeps the literals an
 * annotation would widen away, so the SAME array goes to the processor below and
 * to `createReadSurface` / `createQuerySurface` -- which is what lets a test
 * compare two deployments through the surface GENERATED from the declarations,
 * rather than through a second, hand-written description of the same rows.
 */
export const nftEntities = declareEntities([
	{name: 'nft', id: ['tokenID'], fields: {owner: 'text'}},
	{name: 'counter', id: ['name'], fields: {value: 'integer'}},
]);

/**
 * "Who owns this token", plus a counter that a reorg must be able to bring DOWN.
 *
 * It declares NOTHING about which fold it is, because an author cannot (ADR-0086):
 * every suite here hands its fold the identity its ARRIVAL derived
 * (`utils/processorIdentity.ts`).
 */
export const nftProcessor: EntityProcessor<typeof abi> = {
	entities: nftEntities,
	async onTransfer(state, event) {
		const tokenID = event.args.id.toString().padStart(78, '0');
		const to = event.args.to.toLowerCase();
		if (to === ZERO) {
			state.delete('nft', {tokenID});
		} else {
			state.set('nft', {tokenID}, {owner: to});
		}
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
};

const contractsDataPerChain = {'1': [{abi, address: CONTRACT, startBlock: START_BLOCK}]};

/**
 * What a deployment indexes, as an EXPLICIT source.
 *
 * The same object both halves of a split deployment must reach, since the wire
 * identity is derived from the source and the stream config together: a sender
 * gets it as `INDEXING_SOURCE` or as a deployments folder, and a chain-free
 * receiver can get it no other way.
 */
export const SOURCE: IndexingSource<typeof abi> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

/**
 * The module a deployment ships: `createProcessor` returns the AUTHORING object.
 *
 * Declarations plus handlers, and no store, because WHERE the state lives is the
 * deployment's choice: the CLI builds the runtime around what comes back. It
 * used to return a `{kind, processor}` tag, which is gone with the second
 * authoring path it discriminated (ADR-0037).
 */
export const entityModule = {
	createProcessor: () => nftProcessor,
	contractsDataPerChain,
};

/** A module still returning the retired KIND TAG, which must be refused rather than unwrapped. */
export const taggedModule = {
	createProcessor: () => ({kind: 'entities', processor: nftProcessor}) as const,
	contractsDataPerChain,
};
