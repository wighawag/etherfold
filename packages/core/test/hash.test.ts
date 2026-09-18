import {describe, expect, it} from 'vitest';
import {simple_hash} from '../src/utils/hash.js';

// ---------------------------------------------------------------------------
// simple_hash: what it must distinguish, and what it must not
// ---------------------------------------------------------------------------
// This is the digest behind `context.config`, `context.source` and the handler
// fingerprint that names a module arrival. Two values it fails to distinguish are
// two states the core will treat as one, which is how a processor ends up serving
// state computed under a configuration that is no longer in force.
// ---------------------------------------------------------------------------

describe('simple_hash distinguishes values that differ', () => {
	it('tells a falsy value from an absent one', () => {
		// It used to filter with a bare `if (value)`, so every falsy field vanished
		// from the payload. `{fee: 0}` and `{}` are different configurations, and a
		// processor cannot invalidate state on a change it cannot see.
		expect(simple_hash({fee: 0})).not.toBe(simple_hash({}));
		expect(simple_hash({enabled: false})).not.toBe(simple_hash({}));
		expect(simple_hash({name: ''})).not.toBe(simple_hash({}));
		expect(simple_hash({parent: null})).not.toBe(simple_hash({}));
	});

	it('tells falsy values apart from each other', () => {
		expect(simple_hash({v: 0})).not.toBe(simple_hash({v: false}));
		expect(simple_hash({v: 0})).not.toBe(simple_hash({v: ''}));
		expect(simple_hash({v: null})).not.toBe(simple_hash({v: false}));
	});

	it('sees a falsy value nested inside an object or an array', () => {
		expect(simple_hash({a: {b: 0}})).not.toBe(simple_hash({a: {}}));
		expect(simple_hash({a: [1, 0]})).not.toBe(simple_hash({a: [1]}));
	});

	it('sees a changed value at any depth', () => {
		expect(simple_hash({a: {b: {c: 1}}})).not.toBe(simple_hash({a: {b: {c: 2}}}));
	});
});

describe('simple_hash ignores differences that are not differences', () => {
	it('ignores key order', () => {
		expect(simple_hash({a: 1, b: 2})).toBe(simple_hash({b: 2, a: 1}));
	});

	it('treats an explicit undefined as absent, exactly as JSON does', () => {
		// This one MUST collapse: `JSON.stringify` drops undefined, so a value
		// hashed before being persisted and the same value hashed after a round
		// trip have to agree, or every reload would look like a config change.
		expect(simple_hash({a: 1, b: undefined})).toBe(simple_hash({a: 1}));
		expect(simple_hash(JSON.parse(JSON.stringify({a: 1, b: undefined})))).toBe(simple_hash({a: 1, b: undefined}));
	});

	it('is stable for the same value', () => {
		expect(simple_hash({a: 1, b: [1, 2, {c: 3}]})).toBe(simple_hash({a: 1, b: [1, 2, {c: 3}]}));
	});
});

describe('simple_hash survives the values a real config holds', () => {
	it('hashes BigInts instead of throwing on them', () => {
		// A processor config can hold a `uint256` (a price, a threshold), and plain
		// JSON.stringify REFUSES to serialize a BigInt. Throwing here would take out the
		// stream config hash itself, which is computed on every load.
		expect(() => simple_hash({threshold: 10n})).not.toThrow();
		expect(simple_hash({threshold: 10n})).not.toBe(simple_hash({threshold: 11n}));
		// and a BigInt is not confused with the number of the same value
		expect(simple_hash({threshold: 10n})).not.toBe(simple_hash({threshold: 10}));
	});

	it('hashes a string argument as itself', () => {
		expect(simple_hash('abc')).toBe(simple_hash('abc'));
		expect(simple_hash('abc')).not.toBe(simple_hash('abd'));
	});

	it('never produces a digest that reads as a BigInt literal', () => {
		// A digest is persisted inside `LastSync`, and the storage adapters revive
		// BigInts from the `"123n"` convention. A digest of all digits ending in `n`
		// (`8918n` is one this function used to produce) came back a BigInt, so the
		// core compared a string to a BigInt and discarded state that was fine. The
		// reviver cannot tell those apart; the digest can, by never being one.
		for (let i = 0; i < 20000; i++) {
			expect(simple_hash({payload: i})).not.toMatch(/^-?\d+n$/);
		}
	});
});
