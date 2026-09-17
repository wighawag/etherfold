import {sha256, stringToHex} from 'viem';
import type {GenerationId} from './registry.js';
import {canonical_form} from '../utils/hash.js';

/**
 * WHAT A GENERATION IS, as ONE value: its stream, plus the fold over it.
 *
 * `GenerationId` is the identity and this is the RENDERING of it, for the one
 * job an identity has when it leaves the process: being REPORTED to somebody who
 * compares it against the last one they saw. The registry keeps the two halves
 * apart because it KEYS on them (a composite key compared element by element
 * cannot confuse one component's rendering with another's); a report is not a
 * key, and a reader that is handed two named fields will read one of them.
 *
 * ## It is OPAQUE, and that is the whole point
 *
 * The same call `feed/cursor.ts` makes for the cursor, and for the same reason:
 * what a client can read, a client comes to depend on. A consumer told
 * `{stream, processor}` will one day branch on the processor half, and then
 * WHAT a generation is composed of can never change -- while this project fully
 * expects it to (the stream digest itself replaced `{source, config}`, and a
 * generation carrying more than a version hash is a plausible future). A digest
 * has nothing to reach into, so the composition stays ours.
 *
 * It is deliberately NOT a hiding measure. There is no key here and the rule is
 * written above: anyone determined can recompute one from a stream digest and a
 * version hash. What it stops is ACCIDENTAL dependence, which is the failure
 * that actually happens.
 */

/** How many characters a rendered generation is, always. 128 bits as lowercase hex. */
export const GENERATION_DIGEST_LENGTH = 32;

/**
 * A version tag inside the preimage, so a later change to the RULE -- what
 * enters the digest, or how it is rendered -- is a different digest by
 * construction rather than by luck.
 *
 * A consumer sees such a change as a generation change, which is honest: it
 * cannot tell, and it is not meant to, and the answer it is meant to take from
 * a change ("re-read what you derived, or decide not to") is the correct one
 * either way.
 */
const GENERATION_DIGEST_RULE = 'etherfold/generation/1';

/**
 * The digest that IDENTIFIES one generation: `streamDigestOf` plus the identity
 * the processor's ARRIVAL supplied (ADR-0086), rolled up.
 *
 * BOTH halves are in it, and neither alone would do. The processor hash alone
 * would make two indexers folding different streams with one processor look like
 * one generation -- so a consumer that re-subscribed after a stream mismatch
 * would be told nothing had changed at the exact moment everything had. The
 * stream alone would miss the case this value exists for: SAME logs, DIFFERENT
 * fold, which no cursor check can see.
 *
 * Rendered like a stream digest (`sha256`, truncated to 128 bits, fixed-length
 * lowercase hex, no `0x`) because it is the same kind of thing and there is no
 * reason for two renderings; and 128 bits because a collision here is a change a
 * consumer is never told about.
 */
export function generationDigestOf(id: GenerationId): string {
	const preimage = canonical_form({rule: GENERATION_DIGEST_RULE, stream: id.stream, processor: id.processor});
	return sha256(stringToHex(preimage)).slice(2, 2 + GENERATION_DIGEST_LENGTH);
}
