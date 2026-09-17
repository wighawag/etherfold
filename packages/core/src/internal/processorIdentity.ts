/**
 * WHAT IDENTIFIES THE FOLD A HOST HANDED OVER, in the one expression every
 * engine in this package asks.
 *
 * ADR-0086's invariant is that an author cannot STATE a processor's identity and
 * that the engine is HANDED one and never asks where it came from. So an
 * identity ARRIVES: a deployment that read a self-contained BUNDLE off disk names
 * its fold by the SHA-256 of those octets, and an edited handler is a different
 * fold whether or not anybody remembered to say so.
 *
 * Core takes the value and does nothing else with it. `GenerationId.processor` is
 * a string the registry COMPARES for equality and RENDERS into messages, and
 * nothing in this tree parses it -- which is exactly what lets two derivations
 * coexist while ADR-0086's migration runs. There is deliberately no helper here
 * asking whether an identity "looks like a hash": that would be the first parser.
 *
 * ## Why the second argument exists, and when it stops existing
 *
 * ABSENT is a real answer and still the common one. This is the MIGRATE step of a
 * wide refactor (`work/protocol/TASKING-PROTOCOL.md` 3a): the sibling packages
 * that build folds have not moved yet, and until they do a caller supplies no
 * identity and the fold keeps the author-DECLARED one its processor computes.
 * `the-declared-version-and-the-drift-report-are-deleted` is what removes the
 * fallback, and at that point this function has nothing left to choose between
 * and goes with it.
 *
 * It is NOT the caller-declared version hash ADR-0043 rejected. That one was a
 * caller RESTATING a value the processor also computes, so the two could silently
 * disagree; this is a value derived from something the processor cannot see
 * (bytes it was never given) and it REPLACES the computation rather than sitting
 * beside it, so there are still never two live answers.
 *
 * ## Why it is asked at each site rather than captured once
 *
 * Because the DECLARED half is not a constant: `getVersionHash()` covers a
 * processor's config as well as its version, and `configure()` can move it after
 * construction -- which is why `StreamBuilder.generation` and
 * `IndexerGeneration.promiseToLoad` read it on every call today. A value snapped
 * at construction would advertise a fold that is no longer running. An identity
 * the arrival supplied IS a constant, because the config a bundle was built with
 * is IN the bundle, so asking again simply answers the same thing.
 */
export function processorIdentityOf(processor: {getVersionHash(): string}, supplied: string | undefined): string {
	return supplied ?? processor.getVersionHash();
}
