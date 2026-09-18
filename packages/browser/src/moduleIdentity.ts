import type {Abi, EventProcessor} from '@etherfold/core';

/**
 * WHAT NAMES A FOLD THAT ARRIVED AS A MODULE, which is the one arrival with no
 * bytes to hash.
 *
 * ADR-0086's invariant is that an author cannot STATE a processor's identity, and
 * that HOW one is derived belongs to the ARRIVAL. Every other arrival has octets:
 * a pushed artifact, a self-contained bundle read off disk, each named by the
 * SHA-256 of what it is. A browser dev server has none -- it serves unbundled ESM
 * and hands the page a module OBJECT -- so this arrival derives its identity from
 * the processor's own HANDLER SOURCES instead.
 *
 * That is the code fingerprint in a DIFFERENT ROLE from the one it was built for.
 * It used to be a second opinion sitting beside a declared identity, reported when
 * the two disagreed; here it IS the identity, because there is nothing else to be.
 * ADR-0086 deletes the first role and keeps this one, in as many words.
 *
 * ## THE APP DOES NOT GET TO SUPPLY ONE
 *
 * The tempting shortcut, having found that a module has no bytes, is to take a
 * hash from the caller. That is the author-declared identity ADR-0086 deletes,
 * re-entering through the one door left open, and it would be SILENT when wrong:
 * a value nobody can check against the code it claims to name. So nothing an
 * application passes reaches this function, and the only input is the processor
 * itself.
 *
 * ## WHY IT IS ASKED OF THE PROCESSOR RATHER THAN COMPUTED OVER IT
 *
 * What a tab holds is a fold BUILT OVER A STORE (`EntityEventProcessor` and its
 * kin), and the handlers a developer edits are on the author's object INSIDE it.
 * Fingerprinting the object in hand would therefore hash the library's own
 * methods, which are identical for every processor ever built this way: a
 * CONSTANT that no edit could ever move, which is precisely the silent lie this
 * exists to remove. `getCodeFingerprint()` is the seam each implementation
 * answers from the author's object, so it is what gets asked.
 *
 * ## WHAT IT SURVIVES, AND WHY THAT IS ACCEPTABLE **HERE** AND NOWHERE ELSE
 *
 * The derivation is `Function.prototype.toString()` over the handlers, whitespace
 * collapsed (`processorCodeFingerprint`, `@etherfold/core`, where the measurements
 * are recorded). So it:
 *
 * - **survives** a page reload, reformatting and re-indentation, and re-ordering
 *   the handlers on the object;
 * - **does NOT survive** minification (identifiers are renamed), a change of
 *   transpiler or target, or editing a comment inside a handler under a toolchain
 *   that keeps comments -- each of which renames a fold that did not change;
 * - **does not MOVE** for a change the source text does not carry: a handler whose
 *   behaviour is decided by a captured value, an imported helper that was edited,
 *   or an entity declaration that was changed. Those are CODE this derivation
 *   cannot see, and `updateProcessor(next, {force: true})` is what an integrator
 *   who knows better reaches for.
 *
 * None of the first two applies to the runtime this arrival happens in, and that
 * is the whole licence for using it: a module object reaches a tab only from a dev
 * server serving unbundled ESM, where the source text IS what the developer
 * edited. A PRODUCTION deployment arrives as a bundle and is named by the hash of
 * its octets, which is why the same code has a different identity as a module than
 * as a bundle -- correct rather than unfortunate, since a dev iteration and a
 * deployed build are different generations either way. Nothing here reaches a
 * non-browser runtime, and nothing here is a general rule.
 *
 * ## `undefined` IS A REAL ANSWER
 *
 * A processor whose handlers have no readable source (all bound, or behind a
 * proxy) cannot be named this way, and saying so is better than hashing
 * `[native code]` into a constant. The caller then falls back to the declared hash
 * exactly as it did before this arrival had a derivation of its own -- the last
 * place that fallback is reachable in this package, and one
 * `the-declared-version-and-the-drift-report-are-deleted` has to answer for when
 * it removes it.
 */
export function moduleProcessorIdentity<ABI extends Abi, ProcessResultType>(
	processor: EventProcessor<ABI, ProcessResultType>,
): string | undefined {
	return processor.getCodeFingerprint();
}
