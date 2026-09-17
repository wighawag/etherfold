/**
 * A sibling module, so the artifact beside it is genuinely a BUNDLE.
 *
 * The round trip would pass against a single-file entry point too, and it would
 * be proving something narrower: that bytes evaluate. What a deployment ships is
 * a dependency CLOSURE flattened into one module, so the fixture has a closure
 * to flatten -- one import that must be gone from the built artifact for the
 * self-containment check to admit it.
 */
export function tokenKey(id: bigint): string {
	return id.toString().padStart(78, '0');
}
