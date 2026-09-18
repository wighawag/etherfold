import type {EntityProcessor} from '@etherfold/processor-entities';
import eip721 from './eip721.js';

/**
 * The same question as `index.ts` -- who owns which token -- written against the
 * STORAGE SEAM instead of against a free-form object.
 *
 * This is the processor the browser demo in `browser/` runs, and it is the whole
 * point of the example: it names no backend. The deployment decides where the
 * state lives (versioned rows in IndexedDB in a tab, SQLite on a server, the
 * light patch store for a tab that only wants the tip), and nothing below
 * changes when it does.
 *
 * `index.ts` keeps the free-form `JSProcessor` version of the same logic. Two
 * processors in one example is deliberate and is the one place in this
 * repository where the SAME indexing question is written in both authoring
 * styles, so the cost of porting one to the other is readable in a diff. The
 * shapes are almost identical on purpose: `on<EventName>(state, event, config)`
 * either way, and only the WRITES differ -- `data.nfts.push(...)` against a draft
 * object here becomes `state.set(entity, id, values)` against a
 * `MutationContext`.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * The token id, as an id COLUMN.
 *
 * Padded to a fixed width because a listing is ordered lexicographically over
 * the stringified id (ADR-0021), so an unpadded decimal would sort `10` before
 * `9`. 78 digits is `uint256`'s decimal width; nothing is lost, and the display
 * side strips the zeros back off.
 */
function tokenKey(id: bigint): string {
	return id.toString().padStart(78, '0');
}

/** The inverse, for a UI. */
export function readableTokenID(key: string): string {
	return key.replace(/^0+(?=\d)/, '');
}

export const NFTProcessor: EntityProcessor<typeof eip721> = {
	// REQUIRED by the entity runtimes, on its way out (ADR-0086), and DO NOT REACH
	// FOR IT: nothing on this example's command-line path is named by it any more.
	// WHICH FOLD this is comes from the ARRIVAL that delivered it, and the arrival
	// `etherfold build` and `etherfold run` are given here is the self-contained
	// BUNDLE this package emits (`pnpm build:bundle` -> `dist/cli.bundle.js`), so the
	// fold is named by the SHA-256 of those octets and an edited handler is a
	// different fold with no author action at all -- which is the whole reason the
	// field is going. There is deliberately no instruction here to bump it: doing so
	// would change nothing about which generation this example folds into, and the
	// bundle already moved when the handler did.
	//
	// The TAB in `browser/` hands `@etherfold/browser` a module OBJECT, which has no
	// bytes at all because a dev server serves unbundled ESM; how THAT arrival derives
	// an identity is `a-module-handed-to-a-tab-is-identified-by-its-handler-sources`,
	// and it is not this field either.
	// `the-declared-version-and-the-drift-report-are-deleted` removes it.
	version: '1.0.0',

	/**
	 * `{name, id, fields}` per entity, and that is the whole schema an author
	 * writes: the store owns the layout, the version columns, the as-of read and
	 * the reorg revert.
	 *
	 * `nft` is keyed by `(tokenAddress, tokenID)`, which makes "the tokens of this
	 * collection" a PREFIX of the id and therefore one indexed range scan on every
	 * backend -- the seam's only set read.
	 */
	entities: [
		/**
		 * "Who owns this token", keyed by the token.
		 *
		 * `(tokenAddress, tokenID)` makes "the tokens of ONE collection" a prefix of
		 * the id, which is the seam's one set read.
		 */
		{name: 'nft', id: ['tokenAddress', 'tokenID'], fields: {owner: 'text'}},
		/**
		 * "Which tokens does this account own", keyed by the OWNER first.
		 *
		 * This is the entity that makes an account's collection answerable, and it
		 * exists because the seam's only set read is a PREFIX of the declared id plus
		 * a required limit (ADR-0021). `nft` above has `owner` as a FIELD, so "every
		 * token owned by X" is not a prefix of it and could only be answered by
		 * scanning every token that ever moved -- the accidental full scan the bound
		 * exists to make impossible.
		 *
		 * So the answer is a second entity keyed the way the question is asked. It
		 * carries no fields: the id IS the fact, and its existence is the ownership.
		 * A transfer closes the old owner's row and opens the new one, which is the
		 * same close-then-insert the store does for every version.
		 */
		{name: 'ownership', id: ['owner', 'tokenAddress', 'tokenID'], fields: {}},
		{name: 'counter', id: ['name'], fields: {value: 'integer'}},
	],

	async onTransfer(state, event) {
		// lower-cased on the way in so a caller can query the prefix without having
		// to reproduce viem's EIP-55 checksum casing
		const tokenAddress = event.address.toLowerCase();
		const tokenID = tokenKey(event.args.id);
		const to = event.args.to.toLowerCase();

		// The PREVIOUS owner is read back rather than taken from `event.args.from`:
		// a mint's `from` is the zero address, and on a partial index the token may
		// have been first seen mid-history, so what this store actually holds is the
		// only truth about which `ownership` row is currently open.
		const previous = await state.get<{owner: string}>('nft', {tokenAddress, tokenID});
		if (previous) {
			state.delete('ownership', {owner: previous.owner, tokenAddress, tokenID});
		}

		if (to === ZERO_ADDRESS) {
			// burnt: the live version is closed and no new one opened
			state.delete('nft', {tokenAddress, tokenID});
		} else {
			state.set('nft', {tokenAddress, tokenID}, {owner: to});
			state.set('ownership', {owner: to, tokenAddress, tokenID}, {});
		}

		// read-your-writes inside the block: two transfers in one block compose
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},

	/**
	 * An ERC-20 transfer, almost certainly.
	 *
	 * `Transfer(address,address,uint256)` hashes to the SAME topic0 for ERC-20 and
	 * ERC-721, so a filter on that signature over every address -- which is what
	 * indexing one ACCOUNT's tokens means -- necessarily catches both. They differ
	 * only in arity: ERC-721 indexes the token id (4 topics), ERC-20 leaves the
	 * value in data (3 topics). `decodeEventLog` therefore FAILS on the mismatch
	 * rather than mis-reading a balance as a token id, the core records the failure
	 * on the event, and the engine routes it here instead of to `onTransfer`.
	 *
	 * Counting them is the honest thing to display: it says out loud that the
	 * collision happened and was rejected, rather than leaving a reader to wonder
	 * why a token they hold is missing.
	 */
	async handleUnparsedEvent(state, _event) {
		const counter = await state.get<{value: number}>('counter', {name: 'undecodable'});
		state.set('counter', {name: 'undecodable'}, {value: (counter?.value ?? 0) + 1});
	},
};

/** The ABI, re-exported so an app names one import for the processor and its events. */
export {default as abi} from './eip721.js';
