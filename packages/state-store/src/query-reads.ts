import type {BlockPointer} from './types.js';

/**
 * ## The query layer's reads, beyond the seam (ADR-0099)
 *
 * What a query layer asks of the store it reads, and a handler never does: the
 * TIP it pins, the recorded block at a height and the one a HASH names (so an
 * answer can name its block's hash, and a query can be pinned to one), and the
 * REVERT SEQUENCE a query reads at its start and at its end, so that it is never
 * answered from two branches.
 *
 * None of them is part of `StateStore`: they are members of the backends that
 * answer queries (`@etherfold/state-store-sqlite`, `@etherfold/state-store-indexeddb`),
 * and every handle that WRAPS a store (`openForWriting`'s claimed handle,
 * `openSnapshotAware`'s) forwards them by feature detection, exactly as it
 * forwards the accessor, so a host holding a wrapped store still answers
 * queries from it. `openForReading` wraps nothing, so a reader has whatever the
 * store it was given has.
 */
export type QueryReads = {
	/** The highest recorded block's number, or `undefined` before the first. */
	tip(): Promise<number | undefined>;
	/** The block recorded at a height, or `undefined` when none is. */
	blockAt(number: number): Promise<BlockPointer | undefined>;
	/**
	 * The recorded block a HASH names, or `undefined` when none is. The hash is
	 * normalised as the store normalises it on write (`normalizeBlockHash`, ADR-0015),
	 * so an echoed-back upper-case hash still resolves.
	 */
	blockOf(hash: string): Promise<BlockPointer | undefined>;
	/**
	 * How many times this store has reverted: a monotonic count, persisted, and
	 * incremented in the SAME transaction as every `revertTo`. `0` before the first.
	 */
	revertSequence(): Promise<number>;
};

const QUERY_READS = ['tip', 'blockAt', 'blockOf', 'revertSequence'] as const satisfies readonly (keyof QueryReads)[];

/**
 * The query reads a store underneath has, bound to it, for a WRAPPER to expose
 * as its own: each one present exactly when the inner store has it.
 *
 * @internal Shared by the claimed and the snapshot-aware handles.
 */
export function forwardedQueryReads(inner: object): Partial<QueryReads> {
	const reads: Partial<Record<keyof QueryReads, unknown>> = {};
	for (const name of QUERY_READS) {
		const member = (inner as Record<string, unknown>)[name];
		if (typeof member === 'function') reads[name] = (...args: unknown[]) => member.apply(inner, args);
	}
	return reads as Partial<QueryReads>;
}
