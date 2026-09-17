import {abi, CONTRACT, START_BLOCK, tokenKey} from './abi.js';

/**
 * `nfts.ts` WITH ONE HANDLER LINE CHANGED, and nothing else changed at all.
 *
 * The `version` is the same, the entity declarations are the same and the
 * contract data is the same, so `getVersionHash()` cannot tell the two apart --
 * which is the whole point of the pair. The only difference is inside
 * `onTransfer`: the `nft` row is credited to the SENDER rather than to the
 * recipient, which is the shape of edit an author makes, forgets to declare, and
 * used to have served back to them for ever (ADR-0086).
 *
 * It is a whole second file rather than a parameter of the first because the
 * fixture is a pair of ARTIFACTS: what is committed beside it is two bundles, and
 * a reader comparing them wants two sources they can diff.
 */

/** The write seam a handler is handed: as much of a `MutationContext` as this reads. */
export type Mutations = {
	set(entity: string, id: {readonly [field: string]: unknown}, values: {readonly [field: string]: unknown}): void;
	get<T>(entity: string, id: {readonly [field: string]: unknown}): Promise<T | undefined>;
};

/** One decoded `Transfer`, as much of it as this handler reads. */
export type TransferEvent = {args: {from: string; to: string; id: bigint}};

export const contractsDataPerChain = {'1': [{abi, address: CONTRACT, startBlock: START_BLOCK}]};

/** The AUTHORING object: declarations plus handlers, naming no backend (ADR-0037). */
export const NFTProcessor = {
	/** The SAME declared version as `nfts.ts`, deliberately (see the note there). */
	version: '1.0.0',
	entities: [
		{name: 'nft', id: ['tokenID'], fields: {owner: 'text'}},
		{name: 'counter', id: ['name'], fields: {value: 'integer'}},
	],
	async onTransfer(state: Mutations, event: TransferEvent): Promise<void> {
		// THE ONE EDITED LINE: `from` where `nfts.ts` reads `to`.
		state.set('nft', {tokenID: tokenKey(event.args.id)}, {owner: event.args.from.toLowerCase()});
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
};

/** What a host calls, and what the artifact loader looks for. */
export const createProcessor = () => NFTProcessor;
