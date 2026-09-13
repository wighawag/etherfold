---
'@etherfold/state-moved-conformance': minor
'@etherfold/browser': patch
'@etherfold/server': patch
---

One notification model across every transport, made checkable rather than asserted.

`@etherfold/state-moved-conformance` is a new package: the conformance suite a **state-moved transport** must pass to be an ADAPTER rather than a second semantics. ONE case list, parameterised by an adapter that says how a reader ATTACHES and how the fold behind it is MOVED, run over all three transports from the packages that own them — a worker's port and the cross-tab channel in `@etherfold/browser`, the server's stream in `@etherfold/server`. It is the shape `@etherfold/state-store-conformance` already uses to parameterise over storage backends, and it exists for the reason ADR-0083's opening claim needed one: three independently-correct adapters agree on the day they are written and drift one edit at a time afterwards, each still passing the tests in its own file.

The four chapters are the four places adapters stop agreeing: what the VALUE carries (an exact field set, never a subset), what the SEQUENCE is, what a reader ATTACHING LATE is told, and what a reader that MISSED something converges on. The last chapter is claim-driven — a transport whose reader has a state surface is asked that a read is not answered from below the block it was told about, one with none is asked how a connecting reader is told the position — and a transport offering neither fails a case saying so rather than skipping it. `runStateMovedConformance` runs the list without a test runner, which is how a deliberately-diverging transport is asserted to FAIL the suite, and how a transport built outside this repository (the anticipated GraphQL subscription adapter) checks itself.

No behaviour changed in `@etherfold/browser` or `@etherfold/server`: both gain the suite as a dev dependency and a runner for the transports they own. `SignalStream` in the server's test harness gained an `onEvent` hook, which is what turns a frame off the wire into a call to the plain handler an app writes.

Documentation: ADR-0083 loses its status line (absence means accepted and current) and records the three transports and the suite in its body instead; `CONTEXT.md` gains **transport conformance suite** and names the network transport as built; the browser-app guide gains "How your app learns the state moved", with the two-line reader rule wired to a real client library's invalidation callback and a statement of what the narrow half actually costs (`work/notes/findings/what-the-state-moved-payload-costs-a-normalised-cache.md`).
