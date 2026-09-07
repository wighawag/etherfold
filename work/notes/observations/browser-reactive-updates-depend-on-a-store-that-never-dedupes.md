# Browser reactive updates only fire because `sveltore` treats every object as changed

**2026-09-06**, noticed while answering "what IS the reactive payload now that state is not a blob?"
Verified by reading the code; not a failure anyone has hit.

`@etherfold/browser` publishes two reactive stores, and NEITHER changes the identity of the value it
publishes:

- **`state`** (`createRootStore`) is set with `setState(indexer.state)` on every `onStateUpdated`. On
  the ENTITIES path `indexer.state` is a READ HANDLE with deliberately stable identity ("the same
  object every time, because a handle that changed identity on every publication would defeat
  exactly the callers who keep one", `container.ts`). So the same reference is published forever.
- **`syncing`** (`createStore`) is worse: its setter MUTATES the state object in place
  (`($state as any)[field] = data[field]`) and then calls `store.set($state)` with the very object it
  just mutated.

Both therefore publish `set(x)` where `x === the previous value`. They notify subscribers ONLY
because `sveltore`'s `writable` guards on `safe_not_equal`, which returns true for any object
regardless of identity:

```js
function safe_not_equal(a, b) {
	return a != a ? b == b : a !== b || (a && typeof a === 'object') || typeof a === 'function';
}
```

That is Svelte's semantics and it is fine as long as it is the store in use. What is not fine is that
nothing states the dependency, nothing tests it, and violating it is SILENT.

## Why it matters

Two consequences, one latent and one live:

- **Swap the store and entity-path reactivity dies quietly.** Any signal library whose default
  equality is `===` (Solid's `createSignal`, Vue's `ref`, a React `useSyncExternalStore` snapshot
  compared by identity) will see "no change" on every single update. No error, no failing test, an
  app that simply stops re-rendering. The failure is invisible in exactly the way the repo's
  `named-logs`-only complaints already are.
- **A subscriber can never diff, or snapshot, `syncing` TODAY.** Because it is mutated in place, a
  handler that keeps the previous value keeps a reference to the same live object, so "what changed
  since last time" is unanswerable and a value captured in a closure silently changes underneath it.
  The guide's ordering rule ("the hook sets `syncing` before `state`, so a subscriber that reads both
  after an update sees them agree") is true partly because there is only ever one object to read.

## What would settle it

`work/notes/ideas/the-reactive-update-is-an-envelope-not-a-handle.md` proposes publishing a fresh
envelope per update, which makes both problems structural rather than a property of the chosen store
library. This note records the mechanism; that one proposes the change.

Whatever is decided, the DOCS are wrong today in a smaller way that is worth fixing on touch:
`docs/guide/indexing-in-a-browser-app/` describes a reactive `state` without saying that on the
entities path the published value is a HANDLE carrying no data, so the update is a notification to
re-read and not a delivery of new state.
