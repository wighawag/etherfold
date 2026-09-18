import {simple_hash} from './hash.js';

/**
 * ## What a code fingerprint is, and the ONE arrival it names
 *
 * A processor's identity is DERIVED FROM WHAT IT IS and never declared by its
 * author (ADR-0086), and HOW it is derived belongs to the ARRIVAL. Every arrival
 * that has BYTES is named by the SHA-256 of those octets. Exactly one has none: a
 * browser tab handed a MODULE OBJECT by a dev server serving unbundled ESM. That
 * arrival names its fold with THIS derivation, over the author's handler sources
 * (`moduleProcessorIdentity`, `@etherfold/browser`), because there is nothing else
 * to be. That arrival was built by
 * `a-module-handed-to-a-tab-is-identified-by-its-handler-sources`, which is the
 * record of what it survives and why a dev server is the only runtime it is sound
 * in; this file is its derivation and must not be deleted out from under it.
 *
 * ## What it USED to be, since the measurements below were taken for that role
 *
 * It was an ADVISORY second opinion sitting beside an author-declared
 * `getVersionHash()`, reported as a drift report when the two disagreed, and it
 * deliberately stayed OUT of the identity: folding it in "would be safer in
 * principle and unusable in practice: a bundler or minifier that re-emits the same
 * behaviour differently would invalidate every deployment's state and force a full
 * replay with no logic change". (That was recorded here as a deviation from
 * `docs/adr/0008`, which asked for the folding-in.)
 *
 * ADR-0086 ANSWERS that objection rather than overruling it, and the answer is why
 * this file survived the deletion of the declared identity and of the drift report
 * with it. A PRODUCTION identity is now the hash of a bundle's octets, so the
 * bundler-and-minifier case never reaches this derivation at all; and the one
 * runtime that does reach it is a dev server serving the page the source text it
 * was written from, where a spurious re-fold is a developer's own save. The
 * measurements below are that decision's whole licence -- the cases this does NOT
 * survive are a bundler's and a minifier's, and neither exists between a dev server
 * and the page it is serving.
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
 *   handler under a toolchain that keeps comments. Each of those RENAMES a fold
 *   that did not change, which costs a re-fold of stored data and nothing else.
 *
 * ## Why it is tagged `fp-`
 *
 * So that a value found in a stored cursor says what it is: a fold named this way
 * carries the tag into `GenerationId.processor`, where it sits beside the
 * digest-prefixed identity of every arrival that had bytes. The structural
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
 * code from the payload, and a change inside the deleted region then reads as the
 * SAME fold. Over-naming costs a re-fold; under-naming serves state computed by
 * code that no longer exists, which is the exact failure this exists to prevent.
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
