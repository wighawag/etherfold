import {processorArtifactIdentity} from '@etherfold/utils';

// ---------------------------------------------------------------------------
// HOW A TEST GIVES A FOLD AN IDENTITY: it supplies BYTES.
// ---------------------------------------------------------------------------
// ADR-0086's invariant is that an author cannot STATE a processor's identity and
// that the engine is HANDED one and never asks where it came from. So a test
// here does what an ARRIVAL does: it has bytes, it hashes them, and it hands the
// result over. What it does NOT do is bump a `version` -- that is the declared
// path these suites are migrating off.
//
// The bytes are SYNTHETIC, and that is correct rather than a shortcut wherever
// nothing is INSTANTIATED. An identity is a hash of octets, the registry
// compares it for equality and renders it into messages, and NOTHING in the tree
// parses it (ADR-0086) -- so these suites, which assert on WHICH generation
// answered rather than on what the code inside one does, need exactly "different
// marker, different value". A test that shelled out to `esbuild` to get one
// would have misread the design. The suites that genuinely stand a deployment up
// from a path use the committed fixture instead
// (`test/fixtures/processor-bundle/`), because there the bytes have to RUN.
//
// HOW IT REACHES A DEPLOYMENT depends on how that deployment was stood up, and
// there are exactly two shapes in this package. A suite that builds a container
// itself passes it as `processorIdentity` on the generation spec and as
// `identity` on the processor. A suite that drives a COMMAND -- `run`, `build`,
// `index` -- substitutes its arrival through `deps.importModule` and names it
// through `deps.processorIdentity` beside it, which is one seam with two halves:
// stating what comes back for a path and stating what that thing is called. A
// command given the first and not the second has an arrival that derived NO
// identity, so it falls back on the author-DECLARED one, which is the remainder
// `no-suite-or-example-still-rests-on-the-declared-identity` removed and which
// the contract task is about to delete. Bytes on a disk always win over the
// injected value, so this can only supply a derivation and never overrule one.
//
// The derivation is IMPORTED rather than re-spelled, unlike the copies in
// `@etherfold/core`, `@etherfold/processor-entities` and
// `@etherfold/processor-sqlite`: this package already depends on
// `@etherfold/utils` and already reads its own deployments' identities through
// `processorArtifactIdentity`, so a second spelling here could disagree with the
// one the CLI actually uses.
// ---------------------------------------------------------------------------

/**
 * BYTES THAT STAND IN FOR A BUNDLE, distinct per marker.
 *
 * Shaped like the module a bundler emits so the value reads as what it stands
 * for, but nothing here ever evaluates or parses it: what matters is that two
 * markers are two byte strings and one marker is always the same one.
 */
export function bundleBytes(marker: string): Uint8Array {
	return new TextEncoder().encode(`export const createProcessor=()=>({marker:${JSON.stringify(marker)}});\n`);
}

/**
 * The identity of `bundleBytes(marker)`: what a deployment handed those bytes
 * would name its generation.
 *
 * This is what a suite supplies through `identity` / `processorIdentity` and what
 * it asserts a registered generation is called, so the two can never be spelled
 * differently.
 */
export function identityOf(marker: string): string {
	return processorArtifactIdentity(bundleBytes(marker));
}
