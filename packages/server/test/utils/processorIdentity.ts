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
// identity is a hash of octets and nothing in this package parses it: the
// registry stores it in a column, compares it for equality and renders it into
// messages, and these suites assert on WHICH generation answered rather than on
// what the code inside one does. A bundler would add a build step, a dependency
// and a source of flakiness to produce a string whose only property under test
// is "different marker, different value". A test that shelled out to `esbuild`
// to get one would have misread the design.
//
// The rendering is `@etherfold/utils`'s (`processorArtifactIdentity`) and
// `@etherfold/core`'s `stream/seed.ts`: `sha256:` in front of the digits,
// because such a value is pasted into builds, logs and generation records where
// it outlives the session that produced it, and a bare hex string cannot say
// which function produced it. It is spelled here rather than imported because
// what is under test is that a deployment files WHATEVER it is handed, so the
// exact derivation is the test's business and never the server's -- the same
// judgement `@etherfold/core`, `@etherfold/processor-entities` and
// `@etherfold/processor-sqlite` each recorded for their own copy. Duplicated
// rather than shared because a test folder is not a published surface.
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
 * would name its generation.
 *
 * This is what a suite supplies through `identity` / `processorIdentity` and what
 * it asserts a registered generation is called, so the two can never be spelled
 * differently.
 */
export function identityOf(marker: string): string {
	const bytes = bundleBytes(marker);
	const identity = identityOfBytes(bytes);
	bytesBehind.set(identity, bytes);
	return identity;
}

/** Every identity `identityOf` has produced in this module's lifetime, and the bytes behind it. */
const bytesBehind = new Map<string, Uint8Array>();

/**
 * THE BYTES AN IDENTITY FROM `identityOf` IS THE HASH OF: what a receiving container
 * is handed beside the identity, because registering a generation on a Node deployment
 * STORES its bundle (ADR-0092).
 *
 * Answerable only for identities this suite made through `identityOf`, which is every
 * one a spec here carries -- and REFUSED for anything else, rather than inventing
 * bytes for a name, because a generation registered under a name its stored bytes do
 * not hash to is exactly the lie retention must never tell.
 */
export function bundleOf(identity: string): Uint8Array {
	const bytes = bytesBehind.get(identity);
	if (!bytes) {
		throw new Error(
			`no bytes are known for ${identity}: build it with identityOf(marker) so the bundle is its preimage`,
		);
	}
	return bytes;
}
