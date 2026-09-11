import {InvalidBlockNumberError, StoreWriteRefusedError} from './errors.js';

/**
 * The numeric and textual contract of `BlockPointer`, normalised once.
 *
 * These live here rather than in any one backend because they define what the
 * SHARED type means. A hash that resolves in one store and not in another, a
 * timestamp read as hex by one and as decimal by another, or a block number one
 * backend accepts and another matches nothing against, would each be a
 * difference between backends in the one place the seam promises there is none.
 */

/**
 * What a block NUMBER is, in the one place that decides it: a whole,
 * non-negative number.
 *
 * The rule is deliberately narrow, because everything a block number is used for
 * here is an integer comparison against a version's `_lower` / `_upper`. `1.5`
 * is not a block, `-1` is not a block, and `'100'` is a string that compares
 * unequal to every one of them rather than a block written differently. A store
 * that let any of them through would answer the read with an empty match, which
 * reads as "the entity was absent then".
 *
 * It is exported because the addressing layer above the seam asks the same
 * question of its HEIGHT axis (`@etherfold/state-store-sqlite`), and one rule
 * spelled twice is a rule that drifts.
 */
export function isBlockNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Refuse an `at` that is not a block number, before any read is attempted.
 *
 * Called by `assertRetained`, which is the one function every backend whose
 * `getAsOf` / `listAsOf` takes a NUMBER already routes its historical reads
 * through, so the check is written once and inherited rather than copied into
 * each backend and left to drift. A backend with an addressing layer above it
 * resolves first and hands a number down, so this constrains it not at all.
 *
 * The failure is a caller BUG rather than a state of the store, which is why it
 * is a `TypeError` outside the `BlockUnavailableError` family: see
 * `InvalidBlockNumberError`.
 */
export function assertBlockNumber(at: unknown): asserts at is number {
	if (!isBlockNumber(at)) throw new InvalidBlockNumberError(at);
}

/**
 * THE REFUSALS A STORE GIVES A BLOCK IT WILL NOT RECORD, in the one place that
 * spells them.
 *
 * All three say the same kind of thing -- the CALLER is wrong about the store it
 * is writing to, and the remedy is to revert first or to stop -- which is why
 * they share one type. `StoreWriterChangedError` is deliberately NOT one of
 * them: it means the opposite (a race this caller could not have avoided, whose
 * correct response is to demote itself to a reader), and telling the two apart
 * is what a caller does with them.
 *
 * They live here, with the rest of what `BlockPointer` MEANS, because every
 * backend owes the same refusal and a message copied into four of them is a
 * message that drifts into four. The SQL backend composes the tip refusal after
 * its batch rather than inside it (`remote-sql` has no read inside a
 * transaction), which changes when both numbers are in hand and not what the
 * caller is told.
 *
 * **They are ERRORS rather than message strings so they can carry
 * `retryable: false`**, and that is not decoration: a host loop that retries on
 * a timer cannot otherwise tell a rate limit from a refusal that will be
 * repeated identically for ever, and a store does not move on its own. Treating
 * one of these as transient re-fetches a chain every cycle in order to be
 * refused by every write it makes.
 */
export function blockNotAboveTip(number: number, tip: number): StoreWriteRefusedError {
	return new StoreWriteRefusedError(
		`block ${number} is not above the recorded tip ${tip}: a store's blocks only ever move forward, so a writer ` +
			`offering a height the tip has passed is working from a position that stopped being true. A reorged height ` +
			`must be REVERTED before its replacement is applied, and a writer that lost the store must stop writing.`,
	);
}

/** The refusal for a height this store already holds a block at. */
export function blockAlreadyRecorded(number: number): StoreWriteRefusedError {
	return new StoreWriteRefusedError(
		`block ${number} is already recorded: applying the same block twice is a caller bug, ` +
			`and a reorged height must be reverted before its replacement is applied.`,
	);
}

/** The refusal for a hash this store already holds, at whatever height it holds it. */
export function blockHashAlreadyRecorded(hash: string, at: number | string | undefined): StoreWriteRefusedError {
	return new StoreWriteRefusedError(`block hash ${hash} is already recorded, at height ${String(at)}.`);
}

/**
 * Fold a block hash to one canonical spelling: lower case.
 *
 * Hex case carries no meaning in a block hash (unlike an EIP-55 address), but
 * string comparison is case-sensitive in every store we target, so a hash that
 * has travelled through a consumer's storage and come back upper-cased would
 * fail to resolve. That failure would read as "reorged out", which is the one
 * answer a store must never give wrongly. Folding on write and on lookup removes
 * the possibility.
 */
export function normalizeBlockHash(hash: unknown): string {
	if (typeof hash !== 'string' || hash.length === 0) {
		throw new Error(`invalid block hash: ${JSON.stringify(hash)}. Expected a non-empty string.`);
	}
	return hash.toLowerCase();
}

/**
 * Read `blockTimestamp` off a log into seconds since the epoch.
 *
 * The timestamp comes from the log itself (`blockTimestamp`, standardised in
 * `execution-apis#639`, served by current clients), so addressing by time needs
 * no extra block-by-number round-trip. It arrives inconsistently encoded: the
 * spec says a QUANTITY is 0x-prefixed hex, and at least one client returned it
 * in decimal.
 *
 * The prefix is the ONLY signal, and the ambiguity is not recoverable without
 * it: `'1705366720'` is a valid hex string as well as a valid decimal one, and
 * the two readings are ~2,300 years apart. So `0x` means hex, bare digits mean
 * decimal, and anything else throws rather than defaulting to 0 (a timestamp of
 * 0 would sort before every block and quietly poison time addressing).
 *
 * This lives at the seam because `BlockPointer.timestamp` is where the numeric
 * contract is defined. The ingestion side calls it once, when it turns a log
 * into a `BlockPointer`, rather than re-deriving the same rule.
 */
export function normalizeBlockTimestamp(value: string | number | bigint): number {
	const seconds = toSeconds(value);
	if (!Number.isInteger(seconds) || seconds < 0 || !Number.isSafeInteger(seconds)) {
		throw new Error(
			`invalid block timestamp: ${JSON.stringify(String(value))}. Expected seconds since the epoch as a ` +
				`non-negative integer, a 0x-prefixed hex quantity, or a decimal string.`,
		);
	}
	return seconds;
}

const HEX_QUANTITY = /^0[xX][0-9a-fA-F]+$/;
const DECIMAL_QUANTITY = /^[0-9]+$/;

function toSeconds(value: string | number | bigint): number {
	if (typeof value === 'number') return value;
	if (typeof value === 'bigint') return Number(value);
	if (typeof value === 'string') {
		const text = value.trim();
		if (HEX_QUANTITY.test(text)) return parseInt(text, 16);
		if (DECIMAL_QUANTITY.test(text)) return Number(text);
		return Number.NaN;
	}
	return Number.NaN;
}
