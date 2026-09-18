---
'@etherfold/browser': minor
'@etherfold/core': patch
---

**A processor a dev server hands a tab is identified by a derivation over its HANDLER SOURCES, so editing a handler takes effect and saving a file you did not change does not** (ADR-0086).

Identity is derived PER ARRIVAL and an author never states one. Every other arrival has bytes and is named by the SHA-256 of them; a browser dev server has none, because it serves unbundled ESM and hands the page a module OBJECT. That arrival now derives its own name from the processor's handler sources (`moduleProcessorIdentity`), which is the code fingerprint in a different role: not a second opinion sitting beside a declared identity, but the identity itself where no bytes exist.

What changes for an application:

- `updateProcessor(next)` applies an edited handler with no `version` to bump, and answers `{stateDiscarded: false}` for a save that changed nothing rather than skipping an edit that should have run. The trap it used to have -- an edit under an unchanged `version` that silently never executed -- is gone rather than documented;
- a generation built through `createIndexerState`, `addGeneration` or a worker host's `reconfigure` is named the same way when the app supplied no `processorIdentity`, so the running fold and a save are compared like with like;
- **nothing is taken from the app.** An identity an application could state is the author-declared identity ADR-0086 deletes, re-entering through the one door left open, and it would be silent whenever it was wrong. `updateProcessor` still takes `{force}` and nothing else.

**The limits are real and stated at the code** (`src/moduleIdentity.ts`, the package README and the browser guide). The derivation is over handler SOURCE TEXT: it survives reformatting and handler re-ordering, it does NOT survive minification or a change of transpiler -- which is why it names a module a DEV SERVER handed the tab and never a deployed build -- and it does not move for a change the text does not carry (an edited helper the handler imports, a changed entity declaration, behaviour decided by a captured value), which is what `{force: true}` is for. The consequence worth stating plainly is that the same code has a different identity as a MODULE than as a BUNDLE. That is correct rather than unfortunate: a dev iteration and a deployed build are different generations either way.

**Nothing outside this arrival changed how a processor is named.** An identity the arrival supplied is still used verbatim, the bytes arrivals still hash bytes, and `@etherfold/core` still only compares what it is handed. A processor whose handlers have no readable source (all bound, or behind a proxy) answers `undefined` as it always did, and that fold keeps the declared fallback until `the-declared-version-and-the-drift-report-are-deleted` removes it -- which must leave `EventProcessor.getCodeFingerprint()` answering, since it is now what names the one arrival with no bytes.

`@etherfold/core` is DOCUMENTATION ONLY here, and no behaviour of it changes: `EventProcessor.getCodeFingerprint` and `processorCodeFingerprint` now say that they have a second role in the browser's module arrival, so that a reader who meets "advisory" does not conclude the seam is free to delete.
