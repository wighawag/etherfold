/**
 * WHAT IDENTIFIES THE FOLD A HOST HANDED OVER, and the one refusal that goes with
 * it now that there is nothing else a fold could be called.
 *
 * ADR-0086's invariant is that an author cannot STATE a processor's identity and
 * that the engine is HANDED one and never asks where it came from. So an identity
 * ARRIVES: a deployment that read a self-contained BUNDLE off disk names its fold
 * by the SHA-256 of those octets, a browser tab handed a module with no bytes
 * derives one from its handler sources, and an edited handler is a different fold
 * whether or not anybody remembered to say so.
 *
 * Core takes the value and does nothing else with it. `GenerationId.processor` is
 * a string the registry COMPARES for equality and RENDERS into messages, and
 * nothing in this tree parses it -- which is what lets several derivations coexist
 * without core knowing there are several. There is deliberately no helper here
 * asking whether an identity "looks like a hash": that would be the first parser.
 *
 * ## Why the ABSENT case is a refusal rather than a fallback
 *
 * It used to be the common case: a caller that supplied none got the processor's
 * own author-DECLARED `getVersionHash()`, and this function chose between the two.
 * That declared identity is gone (`the-declared-version-and-the-drift-report-are-deleted`),
 * so there is nothing left to choose: a spec that supplies no identity is a
 * generation with NO NAME, and the only alternatives to refusing are inventing one
 * (which is the author-declared identity under another spelling) or writing
 * `undefined` into a registry record and a persisted cursor. Both are the silent
 * failure ADR-0086 exists to delete, so this refuses instead, BEFORE anything is
 * registered.
 *
 * It says nothing about WHY an arrival produced no identity, because it cannot
 * know: the arrival can. `@etherfold/browser` refuses a module whose handlers have
 * no readable source in its own words, and the CLI refuses a path that named no
 * bundle in its; this is the structural backstop under both.
 */
export function requireProcessorIdentity(supplied: string | undefined): string {
	if (typeof supplied === 'string' && supplied.length > 0) {
		return supplied;
	}
	throw new Error(
		`a generation must be handed the identity its ARRIVAL derived, and this one supplied ` +
			`${JSON.stringify(supplied)}. A processor's identity is derived from what it IS -- the SHA-256 of a ` +
			`bundle's bytes, or a derivation over the handler sources where there are no bytes (ADR-0086) -- and ` +
			`there is no author-declared version left to fall back on, so a fold with no name cannot be registered.`,
	);
}
