import Token from '../contracts/Token.json' with {type: 'json'};
import deployment from './deployment.json' with {type: 'json'};

/**
 * THE PROCESSOR THIS EXAMPLE DEPLOYS: who owns each token, and how many transfers
 * there have been, for the one contract `pnpm deploy:contract` put on the local chain.
 *
 * It is bundled into ONE file (`pnpm build`) and UPLOADED to a running `etherfold node`
 * (`pnpm upload`). The bundle's sha256 is its identity, so every edit you save here is
 * a new generation: the node folds it beside the one answering reads and switches over
 * once it has caught up. It carries its own contracts (`contractsDataPerChain`), which
 * is how the node learns WHAT to index from the same file that says HOW.
 */

/** The events this processor folds. Add `'Approval'` here (and a handler below) to see an "add an event" deploy. */
const EVENTS = ['Transfer'];

const abi = Token.abi.filter((item) => item.type === 'event' && EVENTS.includes(item.name as string));

export const contractsDataPerChain = {
	[deployment.chainId]: [{abi, address: deployment.address, startBlock: deployment.startBlock}],
};

/** The write seam a handler is handed: as much of it as this reads. */
type Mutations = {
	set(entity: string, id: {readonly [field: string]: unknown}, values: {readonly [field: string]: unknown}): void;
	get<T>(entity: string, id: {readonly [field: string]: unknown}): Promise<T | undefined>;
};

type TransferEvent = {args: {from: string; to: string; tokenId: bigint}};

export const processor = {
	entities: [
		{name: 'nft', id: ['tokenId'], fields: {owner: 'text'}},
		{name: 'counter', id: ['name'], fields: {value: 'integer'}},
	],

	async onTransfer(state: Mutations, event: TransferEvent): Promise<void> {
		state.set('nft', {tokenId: event.args.tokenId.toString()}, {owner: event.args.to.toLowerCase()});
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
};

/** What a node looks for in the bundle. */
export const createProcessor = () => processor;
