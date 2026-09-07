import type {Abi} from 'abitype';
import {sha256, stringToHex} from 'viem';
import {sourceHashesOf} from '../internal/engine/eventRanges.js';
import type {IndexingSource, SourceHashEntry, UsedStreamConfig} from '../types.js';
import {canonical_form} from '../utils/hash.js';

/**
 * WHAT A STREAM IS, as a value: its FETCH FILTER plus its stream CONFIG.
 *
 * This is ADR-0006's `{source, config}` stream keying made concrete, narrowed on
 * the source side to the FETCH half per ADR-0034, and it is what fills the
 * `<streamDigest>` level of the stream address (ADR-0035). A stream is RESOLVED
 * by what it contains, so two generations with different filters never collide
 * and one with the same filter is reused.
 *
 * Deliberately NOT a fact about who indexed it: the `<indexer-name>` level of
 * the address is the tenancy discriminator and it already exists, so nothing
 * about an indexer, a processor or a caller belongs in here.
 */

/** How many characters a rendered digest is, always. 128 bits as lowercase hex. */
export const STREAM_DIGEST_LENGTH = 32;

/**
 * A version tag inside the preimage, so a later change to the RULE (what enters
 * the digest, or how it is rendered) is a different digest by construction
 * rather than by luck. Streams under an older tag are simply unreachable; the
 * sweep that disposes of them belongs to the generation registry, which is the
 * only place that can know which digests are registered.
 */
const STREAM_DIGEST_RULE = 'etherfold/stream/1';

/**
 * The digest that IDENTIFIES a stream, over the DEDUPLICATED `streamHash`
 * values SORTED BY THEMSELVES, plus the resolved stream config.
 *
 * ## Why sorted by THEMSELVES, and not taken in the entry list's order
 *
 * `sourceHashesOf` returns its entries sorted by `(startBlock, hash)`, and
 * `hash` covers the DECODING shape. So renaming a non-indexed parameter -- the
 * exact case the two-digest split exists for -- REORDERS that list while every
 * `streamHash` in it is unchanged. A digest rolled up over the list in that
 * order would move, fork a new stream, re-fetch the whole history and orphan the
 * old one, silently and with no error. Taking the `streamHash` values alone,
 * deduplicating them and sorting them by themselves is what makes the digest a
 * function of the SET of filter facts. `hash` and `legacyHash` are excluded for
 * the same reason: they are the fold's identity, not the stream's.
 *
 * Note what the set already contains: the block-0 SKELETON entry, whose
 * `streamHash` covers `chainId`, `genesisHash`, and each contract's address and
 * `startBlock`. That is why `chainId` is not an address level of its own -- it
 * is in here.
 *
 * ## Why the CONFIG is in it
 *
 * The filter is not the only thing that decides what a stream CONTAINS.
 * `alwaysFetchTimestamps`, `alwaysFetchTransactions` and `parse.filters` each
 * change WHAT IS STORED, and `sourceInvalidationOf` already invalidates the
 * STREAM half from block 0 whenever the config hash moves. Keyed on the filter
 * alone, two different configs would map to ONE stream and a generation would
 * adopt logs the verdict has already declared invalid -- with the only existing
 * remedy (clear the stream) destroying the stream the live generation is still
 * answering from.
 *
 * It takes the RESOLVED config (`resolveStreamConfig`), so an unset `finality`
 * and the default written out are one stream, exactly as they are one config
 * everywhere else. The config's canonical BYTES go in rather than its
 * `simple_hash`: that digest is 32 bits, and here a collision is not a missed
 * invalidation but two configs sharing one stream.
 *
 * ## Why this hash
 *
 * `viem`'s `sha256`, truncated to 128 bits. It is already a direct dependency
 * and it is SYNCHRONOUS, which `crypto.subtle` is not (it also needs a secure
 * context). ONE implementation, never a native fast path beside a pure-JS
 * fallback: two implementations that must agree byte for byte would give
 * different stream ADDRESSES on different browsers, which is the silent
 * history-orphaning this digest exists to prevent. 128 bits because this is a
 * KEY and not a change DETECTOR: `simple_hash`'s 32 bits are a coin-flip
 * collision around 65,000 distinct filters, and a collision here means one
 * generation silently adopting another's stream under a filter that does not
 * match it, so logs are missing and nothing reports it.
 *
 * Rendered as FIXED-LENGTH lowercase hex, with no `0x`: every substrate has to
 * carry it as a KEY ELEMENT (a string on IndexedDB, a column on SQL), and a
 * fixed length is what stops one digest's rendering being read as another's.
 */
export function streamDigestOf<ABI extends Abi>(source: IndexingSource<ABI>, streamConfig: UsedStreamConfig): string {
	return streamDigestOfSourceHashes(sourceHashesOf(source), streamConfig);
}

/**
 * The SAME digest, taken from the source hash ENTRIES instead of the source.
 *
 * The rule above is already defined over the entries: `sourceHashesOf` is the
 * whole of what the source contributes to it. This is that function with its
 * first step lifted out, for the one caller that HAS the entries and cannot have
 * the source -- a client checking a downloaded stream SEED, which carries its
 * publisher's entries in its stored `context` and deliberately ships no ABI
 * (ADR-0064: the client computes the publisher's digest and verifies the label,
 * rather than trusting a claim).
 *
 * It is a REPHRASING and not a second rule, which is what the parameter split
 * has to buy: nothing about what enters the digest, how wide it is or how it
 * renders is different here, and `streamDigestOf` is now defined in terms of it
 * so the two cannot drift apart into the silent history-orphaning the docstring
 * above describes.
 */
export function streamDigestOfSourceHashes(
	entries: readonly SourceHashEntry[],
	streamConfig: UsedStreamConfig,
): string {
	const filter = [
		...new Set(
			entries.map((entry) => entry.streamHash).filter((streamHash): streamHash is string => streamHash !== undefined),
		),
	].sort();
	const preimage = canonical_form({rule: STREAM_DIGEST_RULE, filter, config: streamConfig});
	return sha256(stringToHex(preimage)).slice(2, 2 + STREAM_DIGEST_LENGTH);
}
