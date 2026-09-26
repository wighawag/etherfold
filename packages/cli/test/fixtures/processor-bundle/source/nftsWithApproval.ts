import {abi, CONTRACT, START_BLOCK, tokenKey} from './abi.js';

/**
 * `nfts.ts` WITH A NEW EVENT: the same contract, the same `Transfer` handler, and an
 * `Approval` event its ABI now carries with a handler that needs it.
 *
 * The ordinary "add an event" deploy, and the reason it exists as an ARTIFACT: its
 * CONTRACT DATA differs from the other two bundles', so the source it carries is a
 * different STREAM (a new `topic0` in the fetch filter) while everything else about
 * the deployment is the same. A node started with an explicit source must refuse to
 * be handed it; a node whose source came from its processor module registers it as
 * a successor on its new stream, exactly as a re-read after a filter change does.
 */

/** The ERC-721 `Approval` event, beside the `Transfer` the shared ABI already carries. */
const approval = {
	anonymous: false,
	inputs: [
		{indexed: true, internalType: 'address', name: 'owner', type: 'address'},
		{indexed: true, internalType: 'address', name: 'approved', type: 'address'},
		{indexed: true, internalType: 'uint256', name: 'tokenId', type: 'uint256'},
	],
	name: 'Approval',
	type: 'event',
} as const;

/** The write seam a handler is handed: as much of a `MutationContext` as this reads. */
export type Mutations = {
	set(entity: string, id: {readonly [field: string]: unknown}, values: {readonly [field: string]: unknown}): void;
	get<T>(entity: string, id: {readonly [field: string]: unknown}): Promise<T | undefined>;
};

/** One decoded `Transfer`, as much of it as this handler reads. */
export type TransferEvent = {args: {from: string; to: string; id: bigint}};

/** One decoded `Approval`, as much of it as this handler reads. */
export type ApprovalEvent = {args: {owner: string; approved: string; tokenId: bigint}};

export const contractsDataPerChain = {'1': [{abi: [...abi, approval], address: CONTRACT, startBlock: START_BLOCK}]};

/** The AUTHORING object: declarations plus handlers, naming no backend (ADR-0037). */
export const NFTProcessor = {
	entities: [
		{name: 'nft', id: ['tokenID'], fields: {owner: 'text'}},
		{name: 'counter', id: ['name'], fields: {value: 'integer'}},
		{name: 'approval', id: ['tokenID'], fields: {approved: 'text'}},
	],
	async onTransfer(state: Mutations, event: TransferEvent): Promise<void> {
		state.set('nft', {tokenID: tokenKey(event.args.id)}, {owner: event.args.to.toLowerCase()});
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
	async onApproval(state: Mutations, event: ApprovalEvent): Promise<void> {
		state.set('approval', {tokenID: tokenKey(event.args.tokenId)}, {approved: event.args.approved.toLowerCase()});
	},
};

/** What a host calls, and what the artifact loader looks for. */
export const createProcessor = () => NFTProcessor;
