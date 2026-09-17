import {createHash} from 'node:crypto';

// ---------------------------------------------------------------------------
// HOW A TEST GIVES A FOLD AN IDENTITY: it supplies BYTES.
// ---------------------------------------------------------------------------
// ADR-0086's invariant is that an author cannot STATE a processor's identity and
// that the engine is HANDED one and never asks where it came from. So a test
// here does what an ARRIVAL does: it has bytes, it hashes them, and it hands the
// result over. What it does NOT do is bump a `version` -- that is the declared
// path these suites are migrating off.
//
// The bytes are SYNTHETIC and that is correct rather than a shortcut. An
// identity is a hash of octets and nothing in this package parses it: it is
// compared for equality against a stored cursor's `context.processor` and
// rendered into messages, and these suites assert on WHICH fold answered, never
// on what the code inside a fold does. A test that shelled out to `esbuild` to
// get one would have misread the design.
//
// The counterparts are `@etherfold/processor-entities`'s and
// `@etherfold/core`'s, both spelling this same `sha256:<hex>` rendering
// (`@etherfold/utils`'s `processorArtifactIdentity`) for the same reason: what is
// under test is that a fold takes WHATEVER it is handed, so the derivation is
// the test's business and never the fold's. Duplicated rather than shared
// because a test folder is not a published surface.
// ---------------------------------------------------------------------------

/**
 * BYTES THAT STAND IN FOR A BUNDLE, distinct per marker.
 *
 * Shaped like the module a bundler emits so the value reads as what it stands
 * for, but nothing ever evaluates or parses it: what matters is that two markers
 * are two byte strings and one marker is always the same one.
 */
export function bundleBytes(marker: string): Uint8Array {
	return new TextEncoder().encode(`export const createProcessor=()=>({marker:${JSON.stringify(marker)}});\n`);
}

/** `sha256:<64 lowercase hex>` over some octets, the way every arrival that HAS bytes derives one. */
export function identityOfBytes(bundle: Uint8Array): string {
	return `sha256:${createHash('sha256').update(bundle).digest('hex')}`;
}

/**
 * The identity of `bundleBytes(marker)`: what a deployment handed those bytes
 * would name its fold.
 *
 * This is what a suite hands to a fold and what it asserts the fold answers, so
 * the two can never be spelled differently.
 */
export function identityOf(marker: string): string {
	return identityOfBytes(bundleBytes(marker));
}
