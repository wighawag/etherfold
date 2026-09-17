/**
 * The ERC-721 `Transfer` event, as runtime data.
 *
 * A sibling module, so the artifact built beside it is genuinely a BUNDLE: a
 * deployment ships a dependency CLOSURE flattened into one file, and an entry
 * point with nothing to flatten would prove only that bytes evaluate.
 *
 * The same shape `test/utils/chain.ts` serves logs for, written out again here
 * rather than imported from it: this directory is BUILD INPUT for a committed
 * artifact and not part of the test program, so an import reaching back into the
 * suite would put the suite's own module graph into the bundled bytes.
 */
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

/** The contract those logs come from, and the block the deployment starts at. */
export const CONTRACT = '0x0000000000000000000000000000000000000099';
export const START_BLOCK = 1_000_000;

/** The id an `nft` row is keyed by, widened so it sorts as text. */
export function tokenKey(id: bigint): string {
	return id.toString().padStart(78, '0');
}
