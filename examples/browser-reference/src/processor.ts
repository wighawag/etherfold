import type {EntityProcessor} from '@etherfold/processor-entities';

/**
 * ONE contract, ONE event, ONE processor. The whole subject of the reference.
 *
 * A counter contract, because the interesting parts of this example are not in
 * the reducer: what matters is that `transfers` is a number a HANDLER decides,
 * so "did the edited logic take effect" and "was the old state thrown away" are
 * both answerable by reading it.
 */

export const abi = [
	{
		type: 'event',
		name: 'Transfer',
		anonymous: false,
		inputs: [
			{indexed: true, name: 'from', type: 'address'},
			{indexed: true, name: 'to', type: 'address'},
			{indexed: false, name: 'id', type: 'uint256'},
		],
	},
] as const;

export type TokenABI = typeof abi;

/**
 * The version is REQUIRED by the type and it NAMES NOTHING. Do not reach for it.
 *
 * ## AN AUTHOR DOES NOT STATE THEIR PROCESSOR'S IDENTITY (ADR-0086)
 *
 * An engine is HANDED one and never asks where it came from, and which derivation
 * produced it belongs to the ARRIVAL. A deployment that reads a self-contained
 * BUNDLE off disk -- a server, a CLI -- is named by the SHA-256 of those octets,
 * so an edited handler is a different fold whether or not anybody remembered to
 * say so. A TAB is the one arrival with no bytes to hash, because a dev server
 * serves unbundled ESM modules and hands the page a module OBJECT: it is named by
 * a derivation over the HANDLER SOURCES instead, which `@etherfold/browser` does
 * for itself. This app deliberately supplies NO identity of its own -- that would
 * be the author-declared identity re-entering through the one door left open, and
 * it would be silent whenever it was wrong.
 *
 * ## What that means for you TODAY
 *
 * Edit the reducer below, save, and the edit RUNS: a different handler source is a
 * different fold, so the hot reload swaps it in and rebuilds the state under it
 * (`browser/main.ts`, "axis one"). Save a file you did not change and nothing is
 * discarded, which the outcome says. There is no string here to remember.
 *
 * What the derivation cannot see is a change the handler SOURCE TEXT does not
 * carry: a helper you edited in another module, an entity declaration you
 * changed, or behaviour decided by a value the handler captured. Pass
 * `{force: true}` when you know better; it costs the same rebuild.
 */
export const PROCESSOR_VERSION = '1.0.0';

export const tokenProcessor: EntityProcessor<TokenABI> = {
	version: PROCESSOR_VERSION,
	entities: [
		{name: 'token', id: ['id'], fields: {owner: 'text'}},
		{name: 'counter', id: ['name'], fields: {value: 'integer'}},
	],
	async onTransfer(state, event) {
		state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
};
