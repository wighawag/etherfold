---
'@etherfold/state-store': minor
'@etherfold/browser': minor
---

**A tab reads the store across the port**: the seam's four reads are proxied to the host, so an app holding only a port gets TYPED rows with no query runtime on its first-paint path (ADR-0082).

`createPortReadSurface(port, entities)` is the port-side twin of `createReadSurface(store, entities)` -- same call shape, same result type, same four reads per entity, typed off the declarations the app already wrote. Under it, `IndexerPort.reads` is the untyped, entity-name-string handle those types are generated over, which is what `EntityStateView` is on this thread; four new cases ride the existing envelope (`getCurrent` / `getAsOf` / `listCurrent` / `listAsOf`, plus `declarations`), so nothing about the transport, the correlation or the clone guard moved.

There are FOUR reads and there will not be a fifth: no predicate, no caller-supplied ordering, no offset (ADR-0021). Richer queries arrive on this same port as an EXECUTOR with its own serialisation, not as more methods here.

**The rows are the same rows, and that is a test rather than a claim.** One case list runs against a surface over a store on this thread and against a surface over a port to a host holding its own store, with both stores written by the same processor from the same captured logs, in node over a `MessagePort` and in Chromium, Firefox and WebKit over a real dedicated worker. The projection to the declared columns happens in the HOST, through the same `declaredRow` the same-thread surface uses, so version columns never cross and an unlisted declared field arrives as `null` exactly as the store wrote it.

**Reads are served WHILE the fold runs**, from the store the CANONICAL generation folds into, resolved per read. One arriving before the host has opened its store waits for it rather than being refused, and is rejected with the failure that stopped the host if one never arrives.

**`UnknownEntityError` (`@etherfold/state-store`) is new**, thrown by `mustGet` -- so every backend raises the same named refusal for an entity its declarations do not describe, with the same message, and the name survives a `postMessage` where the class cannot. `assertDeclaredBy` is exported from the same package for the same reason: a port proxy checks its declarations against the host's with the seam's own rule instead of a second, weaker one, and refuses a disagreement naming both. If you matched that refusal on its message, the text is unchanged; if you matched `Error` by identity, it is now a subclass.

A tab-only import is measured rather than described: `packages/browser/test/bundlesForABrowser.test.ts` bundles the three imports an app's tab half writes and asserts no query runtime, no store implementation and no engine came with them (8.2 KB minified against 152.4 KB for the whole package when this landed).
