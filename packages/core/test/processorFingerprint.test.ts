import {describe, expect, it} from 'vitest';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {processorCodeFingerprint} from '../src/utils/fingerprint.js';
import {fixtureFingerprint} from './utils/fingerprintFixture.js';

// ---------------------------------------------------------------------------
// THE CODE FINGERPRINT: the second opinion on an author-declared version
// ---------------------------------------------------------------------------
// The objects here are built with `eval` on purpose. `Function.prototype
// .toString()` returns the source as the ENGINE received it, and everything in
// this repo goes through a transpiler (esbuild under vitest, tsc for dist)
// which reprints and re-indents it. Writing the two variants as literals would
// therefore test esbuild's printer, not the normalisation: the whitespace
// difference would already be gone by the time the test ran. `eval` is the only
// way to hand V8 exactly the bytes the assertion is about.
// ---------------------------------------------------------------------------

/** An object whose function sources are EXACTLY the given text. */
function objectFromSource(source: string): object {
	// eslint-disable-next-line no-eval
	return (0, eval)(`(${source})`) as object;
}

describe('processorCodeFingerprint', () => {
	it('changes when a handler body changes', () => {
		const a = objectFromSource(`{onTransfer(state, event) { state.count++; }}`);
		const b = objectFromSource(`{onTransfer(state, event) { state.count--; }}`);
		expect(processorCodeFingerprint(a)).not.toBe(processorCodeFingerprint(b));
	});

	it('ignores whitespace and indentation, so a reformat is not drift', () => {
		const a = objectFromSource(`{onTransfer(state, event) { state.count++; }}`);
		const b = objectFromSource(`{onTransfer(state,   event)   {\n\t\tstate.count++;\n\t}\n}`);
		expect(processorCodeFingerprint(a)).toBe(processorCodeFingerprint(b));
	});

	it('ignores the ORDER of the handlers on the object', () => {
		const a = objectFromSource(`{onA(s) { s.a++; }, onB(s) { s.b++; }}`);
		const b = objectFromSource(`{onB(s) { s.b++; }, onA(s) { s.a++; }}`);
		expect(processorCodeFingerprint(a)).toBe(processorCodeFingerprint(b));
	});

	it('changes when a handler is RENAMED, body unchanged', () => {
		// Which event a body is wired to is part of the logic: the same body moved
		// from onTransfer to onApproval computes something else entirely.
		const a = objectFromSource(`{onTransfer(s) { s.a++; }}`);
		const b = objectFromSource(`{onApproval(s) { s.a++; }}`);
		expect(processorCodeFingerprint(a)).not.toBe(processorCodeFingerprint(b));

		// ...including when the handlers are ARROW PROPERTIES, which is the case that
		// forces the property name into the payload: a method's own `toString()`
		// carries its name (`onTransfer(s) { ... }`) and an arrow's does not
		// (`(s) => { ... }`), so rewiring an arrow to a different event would
		// otherwise be invisible. Both forms are legal in `JSProcessor` and
		// `SQLProcessor`, and tsc/esbuild preserve whichever the author wrote.
		const arrowA = objectFromSource(`{onTransfer: (s) => { s.a++; }}`);
		const arrowB = objectFromSource(`{onApproval: (s) => { s.a++; }}`);
		expect(processorCodeFingerprint(arrowA)).not.toBe(processorCodeFingerprint(arrowB));
	});

	it('changes when a handler is added or removed', () => {
		const a = objectFromSource(`{onTransfer(s) { s.a++; }}`);
		const b = objectFromSource(`{onTransfer(s) { s.a++; }, onApproval(s) { s.b++; }}`);
		expect(processorCodeFingerprint(a)).not.toBe(processorCodeFingerprint(b));
	});

	it('covers construct and handleUnparsedEvent, not just on<Event>', () => {
		const a = objectFromSource(`{onTransfer(s) { s.a++; }, construct() { return {a: 0}; }}`);
		const b = objectFromSource(`{onTransfer(s) { s.a++; }, construct() { return {a: 1}; }}`);
		expect(processorCodeFingerprint(a)).not.toBe(processorCodeFingerprint(b));

		const c = objectFromSource(`{onTransfer(s) { s.a++; }, handleUnparsedEvent(s) { s.bad++; }}`);
		const d = objectFromSource(`{onTransfer(s) { s.a++; }, handleUnparsedEvent(s) { s.ignored++; }}`);
		expect(processorCodeFingerprint(c)).not.toBe(processorCodeFingerprint(d));
	});

	it('ignores non-function properties, because only the handlers are the logic', () => {
		// `version`, `entities` and processor config are in the version hash. Hashing
		// them here too would make a config change read as CODE drift.
		const a = objectFromSource(`{version: '1.0.0', entities: ['a'], onTransfer(s) { s.a++; }}`);
		const b = objectFromSource(`{version: '2.0.0', entities: ['b'], onTransfer(s) { s.a++; }}`);
		expect(processorCodeFingerprint(a)).toBe(processorCodeFingerprint(b));
	});

	it('reads handlers off the prototype too, so a class-based processor is covered', () => {
		class A {
			onTransfer(s: {a: number}) {
				s.a++;
			}
		}
		class B {
			onTransfer(s: {a: number}) {
				s.a--;
			}
		}
		expect(processorCodeFingerprint(new A())).toBeDefined();
		expect(processorCodeFingerprint(new A())).not.toBe(processorCodeFingerprint(new B()));
	});

	it('does not invoke a getter to look at it', () => {
		let invoked = false;
		const processor = {
			get onTransfer() {
				invoked = true;
				return () => {};
			},
			onApproval(s: {a: number}) {
				s.a++;
			},
		};
		expect(processorCodeFingerprint(processor)).toBeDefined();
		expect(invoked).toBe(false);
	});

	it('answers undefined rather than a constant when no source is readable', () => {
		// Every handler bound: `toString()` says "[native code]" for all of them, so a
		// hash would be a CONSTANT that no change can move: the same silent lie as
		// the `unknown` version fallback. "Cannot tell" must not read as "unchanged".
		const bound = {onTransfer: ((s: {a: number}) => s.a++).bind(null)};
		expect(processorCodeFingerprint(bound)).toBeUndefined();

		expect(processorCodeFingerprint({})).toBeUndefined();
		expect(processorCodeFingerprint(undefined)).toBeUndefined();
		expect(processorCodeFingerprint('not a processor')).toBeUndefined();
	});

	it('still fingerprints the readable handlers when only SOME are native', () => {
		const partial = {
			onTransfer: ((s: {a: number}) => s.a++).bind(null),
			onApproval(s: {a: number}) {
				s.a++;
			},
		};
		const changed = {
			onTransfer: ((s: {a: number}) => s.a++).bind(null),
			onApproval(s: {a: number}) {
				s.a--;
			},
		};
		expect(processorCodeFingerprint(partial)).toBeDefined();
		expect(processorCodeFingerprint(partial)).not.toBe(processorCodeFingerprint(changed));
	});

	it('cannot be mistaken for a BigInt by a reviver of the old suffix convention', () => {
		// HISTORY, kept as a shape pin. It travels inside `LastSync`, and every
		// persistence path in this repo used to revive BigInts from the `"123n"`
		// string convention. That reviver (copied below, and no longer in the source:
		// the adapters tag their BigInts now) accepted anything that started with a
		// digit and ended with `n`, then called BigInt() UNGUARDED, and a bare base36
		// hash has that shape roughly 1.25% of the time (`1x9tbhn`). The throw
		// happened inside `JSON.parse`, so the CLI read a perfectly good snapshot as
		// corrupt and cold started.
		//
		// The assertion outlives the bug it was written for: the `fp-` prefix is what
		// keeps a fingerprint off the ambiguous shape ENTIRELY, which still matters to
		// any reader outside this repo that kept the old convention, and it is a
		// property of the fingerprint rather than of any one decoder.
		const bnReviver = (v: string): unknown => {
			if (
				typeof v === 'string' &&
				(v.startsWith('-') ? !isNaN(parseInt(v.charAt(1))) : !isNaN(parseInt(v.charAt(0)))) &&
				v.charAt(v.length - 1) === 'n'
			) {
				return BigInt(v.slice(0, -1));
			}
			return v;
		};

		for (let i = 0; i < 2000; i++) {
			const fingerprint = processorCodeFingerprint(objectFromSource(`{onTransfer(s) { s.a += ${i}; }}`))!;
			expect(fingerprint.startsWith('fp-')).toBe(true);
			expect(bnReviver(fingerprint)).toBe(fingerprint);
		}
	});

	it('is identical in a SEPARATE PROCESS, not merely within this one', () => {
		// The requirement is stability across RESTARTS: a fingerprint that varied per
		// process would report drift on every boot and the report would stop being
		// believed. Asserting it twice in one process cannot catch a per-process seed
		// (a WeakMap counter, an object identity, a Date), so this runs the real
		// module in a real second process and compares.
		const here = path.dirname(fileURLToPath(import.meta.url));
		const tsx = path.resolve(here, '..', 'node_modules', '.bin', 'tsx');
		const script = path.join(here, 'utils', 'printFingerprint.ts');
		const out = execFileSync(tsx, [script], {encoding: 'utf-8'}).trim();

		expect(out).toBe(fixtureFingerprint());
		// and it is a real fingerprint, not two `undefined`s agreeing
		expect(out).not.toBe('undefined');
	});
});
