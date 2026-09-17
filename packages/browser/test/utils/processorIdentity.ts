import {createHash} from 'node:crypto';

// ---------------------------------------------------------------------------
// HOW A TEST GIVES A GENERATION AN IDENTITY: it supplies BYTES.
// ---------------------------------------------------------------------------
// ADR-0086's invariant is that an author cannot STATE a processor's identity and
// that the engine is HANDED one and never asks where it came from. So a test
// here does what an ARRIVAL does: it has bytes, it hashes them, and it hands the
// result to the hook through `processorIdentity`. What it does NOT do is declare
// a `version` -- that is the path these suites are migrating off.
//
// The bytes are SYNTHETIC and that is correct rather than a shortcut. An
// identity is a hash of octets and nothing in this package parses one: it is
// compared for equality by the registry and rendered into messages, and these
// suites assert on WHICH generation answered rather than on what the code inside
// one does. A bundler would add a build step, a dependency and a source of
// flakiness to produce a string whose only property under test is "different
// marker, different value". A test that shelled out to `esbuild` to get one
// would have misread the design.
//
// The rendering is `@etherfold/utils`'s (`processorArtifactIdentity`) and
// `stream/seed.ts`'s: `sha256:` in front of the digits, because such a value is
// pasted into builds, logs and generation records where it outlives the session
// that produced it, and a bare hex string cannot say which function produced it.
// It is spelled here rather than imported for the reason `@etherfold/core`'s and
// `@etherfold/processor-entities`' own copies are: what is under test is that a
// generation is named by WHATEVER it was handed, so the derivation is the test's
// business and never the hook's.
//
// It hashes through `node:crypto` because the VITEST half of this package runs
// under Node. It is deliberately NOT in `browser/workload.ts`, which the
// Playwright specs load INSIDE a browser: the harness only ever PASSES an
// identity through, so nothing that runs in a page has to hash anything.
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
 * The identity of `bundleBytes(marker)`: what a tab handed those bytes would name
 * its generation.
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
 * "canonical is the app, successor is the save" says what a pair of digests does
 * not.
 *
 * The reverse of `identityOf`, and answerable only for the markers the suite has
 * already asked about -- which is every one it could be shown, since a
 * generation's identity exists because the suite made it. It is a TEST
 * convenience and deliberately has no counterpart in the engine: nothing there
 * may look INSIDE an identity (ADR-0086), which is why a suite that used to read
 * a version out of the front of one now asks this instead.
 */
export function markerOf(identity: string | undefined): string | undefined {
	return identity === undefined ? undefined : markers.get(identity);
}
