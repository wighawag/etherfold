import {sha256} from 'viem';

// ---------------------------------------------------------------------------
// HOW A TEST GIVES A FOLD AN IDENTITY: it supplies BYTES.
// ---------------------------------------------------------------------------
// ADR-0086's invariant is that an author cannot STATE a processor's identity and
// that the engine is HANDED one and never asks where it came from. So a test
// here does what an ARRIVAL does: it has bytes, it hashes them, and it hands the
// result over.
//
// The bytes are SYNTHETIC and that is correct rather than a shortcut. An
// identity is a hash of octets and NOTHING in this package parses it -- the
// registry compares it for equality and renders it into messages -- and these
// suites assert on WHICH generation answered, never on what the code inside a
// generation does. So a bundler would add a build step, a dependency and a
// source of flakiness to produce a string whose only property under test is
// "different marker, different value". A test that shelled out to `esbuild` to
// get one would have misread the design.
//
// The rendering is `stream/seed.ts`'s and `@etherfold/utils`'s
// (`processorArtifactIdentity`): `sha256:` in front of the digits, because such
// a value is pasted into builds, logs and generation records where it outlives
// the session that produced it, and a bare hex string cannot say which function
// produced it. It is spelled here rather than imported because `@etherfold/utils`
// depends on `@etherfold/core` and not the other way round -- and because what
// core is being tested on is that it takes WHATEVER it is handed, so the exact
// derivation is the test's business and never core's.
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
	return `sha256:${sha256(bundle).slice(2)}`;
}

/**
 * The identity of `bundleBytes(marker)`: what a deployment handed those bytes
 * would name its generation.
 *
 * This is what a suite supplies through `processorIdentity` and what it asserts a
 * registered generation is called, so the two can never be spelled differently.
 */
export function identityOf(marker: string): string {
	const identity = identityOfBytes(bundleBytes(marker));
	markers.set(identity, marker);
	return identity;
}

/** Every identity `identityOf` has produced in this module's lifetime, and the marker behind it. */
const markers = new Map<string, string>();

/**
 * WHICH MARKER an identity came from, for the assertions that read as a sentence:
 * "canonical is A, successor is B" says what a pair of digests does not.
 *
 * The reverse of `identityOf` and answerable only for the markers this suite has
 * already asked about, which is every one it could be shown -- a fold's identity
 * exists because the suite made it. It is a TEST convenience and deliberately has
 * no counterpart in the engine: nothing there may look inside an identity
 * (ADR-0086), and this direction is exactly what a production helper must never
 * offer.
 */
export function markerOf(identity: string | undefined): string | undefined {
	return identity === undefined ? undefined : markers.get(identity);
}
