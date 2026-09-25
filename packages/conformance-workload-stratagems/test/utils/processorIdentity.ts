import {createHash} from 'node:crypto';

// ---------------------------------------------------------------------------
// HOW THIS WORKLOAD GIVES A FOLD AN IDENTITY: it supplies BYTES.
// ---------------------------------------------------------------------------
// ADR-0086's invariant is that an author cannot STATE a processor's identity and
// that the engine is HANDED one and never asks where it came from. So a suite
// here does what an ARRIVAL does: it has bytes, it hashes them, and it hands the
// result to the container through `processorIdentity`. What it does NOT do is
// lean on the `version` the stratagems processor declares -- that is the path
// these suites are migrating off, and nothing in this package is ABOUT identity:
// the cases publish, retract and apply.
//
// The bytes are SYNTHETIC and that is correct rather than a shortcut. An identity
// is a hash of octets and nothing in this tree parses one: a container compares it
// for equality and renders it into a generation digest, and these suites assert on
// WHAT a fold published rather than on what it is called. A test that shelled out
// to `esbuild` to get one would have misread the design.
//
// The rendering is `@etherfold/utils`'s (`processorArtifactIdentity`): `sha256:`
// in front of the digits, because such a value is pasted into builds, logs and
// generation records where it outlives the session that produced it. It is
// spelled here rather than imported for the reason `@etherfold/browser`'s,
// `@etherfold/processor-sqlite`'s and `@etherfold/core`'s own test copies are:
// what is under test is that a fold takes WHATEVER it is handed, so the
// derivation is the test's business and never the container's.
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
