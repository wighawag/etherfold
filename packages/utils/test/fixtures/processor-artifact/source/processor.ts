import {tokenKey} from './tokenKey.js';

/**
 * The narrowest processor that can be OBSERVED folding: a declaration and one
 * handler that writes through a mutation seam.
 *
 * Deliberately dependency-free apart from its sibling module. What is under test
 * is the ARTIFACT -- hash it, admit it, instantiate it -- so a fixture pulling in
 * `viem` or `@etherfold/processor-entities` would make the bundle large, tie the
 * committed bytes to a lockfile refresh, and prove nothing the sibling import
 * does not already prove.
 *
 * The two types below are LOCAL for the same reason. A real author writes
 * `EntityProcessor<typeof abi>` from `@etherfold/processor-entities`; that is a
 * TYPE-only dependency which the bundler erases, so importing it would change
 * nothing about the bytes while making this fixture's source depend on a package
 * this one does not.
 */

/** The write seam a handler is handed: the narrow half of a `MutationContext`. */
export type Mutations = {
	set(entity: string, id: string, values: {readonly [field: string]: unknown}): void;
};

/** One decoded `Transfer`, as much of it as this handler reads. */
export type TransferEvent = {args: {to: string; tokenID: bigint}};

/** The AUTHORING object: declarations plus handlers, naming no backend. */
export const NFTProcessor = {
	/**
	 * Still DECLARED, because this is the expand step: the entity runtimes refuse
	 * a processor without one until the contract task deletes the field
	 * (ADR-0086). It is NOT what identifies this artifact -- that is the hash of
	 * the bytes -- and nothing in the artifact unit reads it.
	 */
	entities: [{name: 'nft', id: ['tokenID'], fields: {owner: 'text'}}],
	onTransfer(state: Mutations, event: TransferEvent): void {
		state.set('nft', tokenKey(event.args.tokenID), {owner: event.args.to});
	},
};

/** What a host calls, and what the artifact loader looks for. */
export const createProcessor = () => NFTProcessor;
