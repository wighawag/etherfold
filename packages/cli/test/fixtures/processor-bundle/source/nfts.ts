import {abi, CONTRACT, START_BLOCK, tokenKey} from './abi.js';

/**
 * THE PROCESSOR A DEPLOYMENT BUNDLES: "who owns this token", plus a counter, over
 * the one contract this fixture indexes.
 *
 * It exports what a host looks for and nothing else it does not need:
 * `createProcessor`, and the `contractsDataPerChain` the CLI resolves its
 * indexing source from -- so a deployment configured with the artifact built from
 * this file needs no `--deployments` folder and exercises the ordinary source
 * resolution on its way to a fold.
 *
 * `nftsEdited.ts` beside it is THE SAME FILE with ONE HANDLER LINE CHANGED, which
 * is what makes "an edited handler names a different generation" an assertion
 * about bytes rather than about a declared field.
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
	/**
	 * Still DECLARED, because this is the EXPAND step: the entity runtimes refuse a
	 * processor without one until the contract task deletes the field (ADR-0086).
	 * It is NOT what identifies this artifact -- that is the hash of the bytes --
	 * and it is deliberately the SAME value in the edited variant, so a test that
	 * sees two identities has seen the bytes move and not this.
	 */
	entities: [
		{name: 'nft', id: ['tokenID'], fields: {owner: 'text'}},
		{name: 'counter', id: ['name'], fields: {value: 'integer'}},
	],
	async onTransfer(state: Mutations, event: TransferEvent): Promise<void> {
		state.set('nft', {tokenID: tokenKey(event.args.id)}, {owner: event.args.to.toLowerCase()});
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
};

/** What a host calls, and what the artifact loader looks for. */
export const createProcessor = () => NFTProcessor;
