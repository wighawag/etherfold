import {describe, expect, it} from 'vitest';
import {createRootStore, createStore} from '../src/utils/stores.js';

// ---------------------------------------------------------------------------
// THE REACTIVITY OF THIS PACKAGE RESTS ON THE STORE'S EQUALITY RULE
// ---------------------------------------------------------------------------
// Both published stores call `set(x)` where `x` is the SAME OBJECT as the value
// already held, and they still have to notify:
//
//   - `state` (`createRootStore`) is set with `setState(indexer.state)` on every
//     update, and on the entities path `indexer.state` is a READ HANDLE with
//     deliberately stable identity -- "the same object every time, because a
//     handle that changed identity on every publication would defeat exactly the
//     callers who keep one" (`container.ts`). So the same reference is published
//     for the life of the indexer.
//   - `syncing` (`createStore`) MUTATES its state object in place and then sets
//     the store to the very object it just mutated.
//
// They notify only because `sveltore`'s `writable` guards on Svelte's
// `safe_not_equal`, which reports ANY object as changed regardless of identity:
//
//   function safe_not_equal(a, b) {
//     return a != a ? b == b : a !== b || (a && typeof a === 'object') || typeof a === 'function';
//   }
//
// That is a real dependency on a library's equality semantics, and nothing
// stated it, nothing tested it, and breaking it is SILENT: swap in any store
// whose default equality is `===` (Solid's `createSignal`, Vue's `ref`, a React
// `useSyncExternalStore` snapshot compared by identity) and every subscriber
// simply stops being called. No error, no failing test, an app that quietly stops
// re-rendering.
//
// So it is asserted here. A change that breaks it fails THIS file, which names
// the reason, rather than being discovered in a consumer's app.
//
// `work/notes/ideas/the-reactive-update-is-an-envelope-not-a-handle.md` proposes
// removing the dependency instead, by publishing a fresh envelope per update.
// That is a design change; this test pins the behaviour the package has TODAY and
// should be deleted by whatever adopts that idea.
// ---------------------------------------------------------------------------

describe('a re-published value with UNCHANGED identity still notifies', () => {
	it('notifies when the root store is set to the very object it already holds', () => {
		// the entities path: one stable read handle, published on every update
		const handle = {read: () => 'rows'};
		const {set, readable} = createRootStore<unknown>(handle);

		const seen: unknown[] = [];
		const unsubscribe = readable.subscribe((value) => seen.push(value));
		expect(seen).toHaveLength(1); // the initial call

		set(handle);
		set(handle);

		// If this drops back to 1, the store started comparing by identity and every
		// entities-path subscriber has silently stopped updating.
		expect(seen).toHaveLength(3);
		expect(seen.every((value) => value === handle)).toBe(true);
		unsubscribe();
	});

	it('notifies when the syncing store is set to the object it just mutated in place', () => {
		const {set, readable, $state} = createStore<{lastSync?: number; error?: unknown}>({});

		const seen: number[] = [];
		const unsubscribe = readable.subscribe((value) => seen.push(value.lastSync ?? -1));
		expect(seen).toHaveLength(1);

		set({lastSync: 10});
		set({lastSync: 20});

		expect(seen).toHaveLength(3);
		// and the identity never changed while it was doing that
		expect(readable.$state).toBe($state);
		unsubscribe();
	});

	it('is the STORE that allows this, not a fresh object being published', () => {
		// The point stated as an assertion: the value handed to `set` is `===` the value
		// already held. A subscriber therefore cannot diff or snapshot it -- keeping the
		// previous value keeps a reference to the same live object -- which is the second
		// half of the note and the reason the envelope idea exists.
		const held = {mutable: 1};
		const {set, readable} = createRootStore<{mutable: number}>(held);
		let latest: {mutable: number} | undefined;
		const unsubscribe = readable.subscribe((value) => (latest = value));

		held.mutable = 2;
		set(held);

		expect(latest).toBe(held);
		expect(latest?.mutable).toBe(2);
		unsubscribe();
	});
});
