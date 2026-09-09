---
'@etherfold/browser': patch
---

**The reactivity of the published stores rests on the store library's equality rule, and that is now asserted instead of assumed.**

Tests and docs only; no behaviour change. Both published stores call `set(x)` where `x` is the SAME OBJECT they already hold: `state` publishes a read handle with deliberately stable identity (the same object every time, so a caller keeping one is not defeated by an update), and `syncing` mutates its state object in place and then sets the store to the object it just mutated. They notify only because `sveltore`'s `writable` guards on Svelte's `safe_not_equal`, which reports any object as changed regardless of identity.

Nothing stated that dependency, nothing tested it, and breaking it is SILENT: swap in any store whose default equality is `===` (Solid's `createSignal`, Vue's `ref`, a React `useSyncExternalStore` snapshot compared by identity) and every subscriber simply stops being called, with no error and no failing test. `reactiveUpdatesNotifyOnAStableIdentity.test.ts` pins it, and was verified by substituting an identity-comparing store: subscribers drop from three notifications to one, and the test reddens naming the reason.

The browser guide also now says what `state` actually publishes. On the entities path the value is a HANDLE carrying no rows, so an update is a notification to RE-READ rather than a delivery of new state, and neither `state` nor `syncing` can be diffed or snapshotted by a subscriber, because the previous value is the same live object as the current one.
