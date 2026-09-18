import {simple_hash} from './hash.js';

/**
 * ## What a code fingerprint is, and what it is deliberately NOT
 *
 * `getVersionHash()` is the identity of a processor's LOGIC, and the core
 * discards persisted state when it changes. That identity is author-declared:
 * an author who edits a handler and forgets to bump `version` gets state
 * computed by the previous logic, served forever, silently. The fingerprint is
 * the second opinion, derived from the handler implementations themselves, so
 * that "declared version unchanged but the code underneath it changed" becomes
 * something the core can SAY rather than something nobody can see.
 *
 * It is **advisory** and stays out of `getVersionHash()`. Folding it in would be
 * safer in principle and unusable in practice: a bundler or minifier that
 * re-emits the same behaviour differently would invalidate every deployment's
 * state and force a full replay with no logic change. Advisory makes that false
 * positive a log line instead of a multi-hour rebuild. (This deviates from
 * `docs/adr/0008`, which asks for the folding-in; see the task record.)
 *
 * ## IT HAS A SECOND ROLE NOW, in exactly one arrival
 *
 * ADR-0086 moves identity onto the ARRIVAL and deletes the advisory role above
 * along with the declared version it was a second opinion about. It keeps THIS
 * derivation, in a different role, for the one arrival that has no bytes to hash:
 * a browser tab handed a MODULE OBJECT by a dev server names its fold with it
 * (`moduleProcessorIdentity`, `@etherfold/browser`), because there is nothing
 * else to be. The measurements below are that decision's whole licence -- the
 * cases it does NOT survive are a bundler's and a minifier's, and neither exists
 * between a dev server and the page it is serving.
 *
 * So the sentence above stands where it was written (a PRODUCTION identity, which
 * is now the hash of a bundle's octets) and does not reach the browser's module
 * arrival, where a spurious re-fold is a developer's own save.
 *
 * ## What it survives, and what it does not
 *
 * The source is `Function.prototype.toString()`, normalised by collapsing every
 * run of whitespace to a single space. Measured against this repo's own
 * toolchain (tsc 6.0.3, esbuild 0.28 as vitest uses it):
 *
 * - **Survives**: process restarts (the string is a pure function of the loaded
 *   source), re-indentation and reformatting, and re-ordering the handlers on
 *   the object (the payload is keyed and sorted by property name).
 * - **Does NOT survive**: minification (identifiers are renamed), a change of
 *   transpiler or target (tsc keeps comments and indents with four spaces,
 *   esbuild strips comments and indents with two), or editing a COMMENT inside a
 *   handler under a toolchain that keeps comments. Each of those reports drift
 *   with no logic change.
 *
 * ## Why it is tagged `fp-`
 *
 * So that a value found in a stored cursor says what it is. The structural
 * protection it used to provide (a fingerprint must never read as a `"123n"`
 * BigInt to the storage adapters that revived them) moved one level down, into
 * `simple_hash`, which prefixes every digest for that reason and so protects
 * `context.processor` and `context.config` too -- and is now belt and braces on
 * top of that, since no adapter revives the suffix form at all. See
 * `utils/bigint.ts` for the bug that motivated all three.
 *
 * ## Comments
 *
 * Comments are left in rather than stripped, and that is a choice about which
 * way to be wrong. Stripping them from arbitrary source text needs a JS lexer
 * that gets regex-vs-division right; a lexer that gets it wrong deletes real
 * code from the payload, and a change inside the deleted region then reads as NO
 * drift. Over-reporting is recoverable by bumping the version; under-reporting
 * is the exact failure this exists to prevent.
 */
export function processorCodeFingerprint(processor: unknown): string | undefined {
	if (!processor || (typeof processor !== 'object' && typeof processor !== 'function')) {
		return undefined;
	}

	const functions = new Map<string, (...args: never[]) => unknown>();
	let current: object | null = processor as object;
	while (current && current !== Object.prototype && current !== Function.prototype) {
		for (const name of Object.getOwnPropertyNames(current)) {
			if (name === 'constructor' || functions.has(name)) {
				continue;
			}
			// Read the DESCRIPTOR rather than the property: a getter would otherwise be
			// invoked just to look at it, and fingerprinting must not run author code.
			const descriptor = Object.getOwnPropertyDescriptor(current, name);
			if (!descriptor || typeof descriptor.value !== 'function') {
				continue;
			}
			functions.set(name, descriptor.value);
		}
		current = Object.getPrototypeOf(current) as object | null;
	}

	if (functions.size === 0) {
		return undefined;
	}

	const sources = [...functions.keys()].sort().map((name) => `${name}:${normalizeSource(functions.get(name)!)}`);

	// A processor whose every function is native (all handlers `.bind()`-ed, or
	// wrapped by a proxy) has no readable source, and hashing "[native code]"
	// would produce a CONSTANT that no change can ever move: the same silent lie
	// as the `unknown` fallback this exists to remove. `undefined` says "cannot
	// tell", which the core reads as "do not report".
	if (sources.every((source) => NATIVE_CODE.test(source))) {
		return undefined;
	}

	return `${FINGERPRINT_PREFIX}${simple_hash(sources.join('\n'))}`;
}

/** Marks the value as a fingerprint, and keeps it from ever looking like a `"123n"` BigInt. */
const FINGERPRINT_PREFIX = 'fp-';

const NATIVE_CODE = /\{\s*\[native code\]\s*\}/;

function normalizeSource(fn: (...args: never[]) => unknown): string {
	return Function.prototype.toString.call(fn).replace(/\s+/g, ' ').trim();
}
