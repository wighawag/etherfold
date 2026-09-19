---
title: 'An HMR update reconfigures the tab it is running in, so a handler edit keeps the warm fold'
slug: an-hmr-update-reconfigures-the-tab-it-is-running-in
spec: a-processor-reaches-a-deployment-however-it-arrives
blockedBy: [a-module-handed-to-a-tab-is-identified-by-its-handler-sources]
covers: [1, 2, 3]
---

## What to build

The third arrival from ADR-0085, and the cheapest of the three.

A developer running an indexer in a browser tab changes a handler. Their bundler hot-replaces the module, and the indexer goes on folding with the OLD one, because nothing connects the two. Their remedy is to reload the page, which throws away a warm fold and re-indexes from scratch, which is the restart this entire family of work exists to remove.

The fix needs almost nothing, and that is the point worth understanding before building it. On the server, reconfiguring means re-READING a processor (from disk, or from pushed bytes) and defeating a module cache to do it. In a tab, HMR has ALREADY done the module replacement: `import.meta.hot` hands the page a new module object. So there are no bytes to send, no URL to instantiate, no cache to defeat, no route and no credential, because there is no remote caller. The tab reconfigures ITSELF with what its own dev server just gave it.

So this is a thin adapter in front of a call that exists: take the new processor, register it as a successor. Everything downstream (the slot it lands in, the policy, the incumbent answering throughout) is already built by the time this task starts.

## Acceptance criteria

- [ ] An HMR update carrying a changed processor registers a successor in the running indexer, with no page reload, and the incumbent keeps answering reads throughout.
- [ ] Repeated updates stay bounded: a burst of saves leaves the incumbent plus ONE successor, which is what the chain-facing slot work provides and what this asserts end to end.
- [ ] An update whose processor THROWS on evaluation leaves the indexer exactly as it was (same generations, same pointer, still folding and still answering) and reports the failure. Nothing partial is registered.
- [ ] An update that changes no identity is a successful no-op that SAYS it changed nothing, distinguishable from one that registered and from one that failed, matching the outcomes the server-side endpoint already answers.
- [ ] The three outcomes are reported in the SAME shape the reconfigure endpoint uses, so the arrivals share one contract rather than three.
- [ ] The package contains NO reference to `import.meta.hot` or any other bundler-specific HMR global: it exposes an API the application calls, and noticing a change stays the application's job. A deployment built without an HMR-capable bundler is therefore unaffected by construction rather than by a guard.
- [ ] The API is usable from an app's own `import.meta.hot.accept(...)` handler with the module that handler receives, demonstrated in a doc example, since the seam is only worth as much as its call site is obvious.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`the-chain-facing-container-holds-its-generations-in-slots`. A real dependency: without slots in the container a tab runs, every save adds a generation against a cap of two, so the feature would meet a wall on the second edit. Slots are what make this usable rather than a demonstration.

## Prompt

The goal is that editing a handler updates the indexer already running in the page, keeping the state it has folded.

Read **ADR-0085**, particularly the section on why the browser needs none of the upload machinery, which is the decision this task implements and the reason it is small. Then read the browser package's host and how a tab builds and holds an indexer, and the CLI's reconfigure module, which is the SERVER arrival and the source of the three-outcome contract you are matching (registered, unchanged, failed) rather than reimplementing.

The decision most likely to be got wrong is DECIDED, so do not re-open it: **the library does NOT subscribe to `import.meta.hot`, and contains no reference to it.** It EXPOSES an API, and the application calls that API from its own `import.meta.hot.accept(...)` handler. Noticing a change is the application's responsibility, which is the same rule the server side already follows (whatever notices a change stays outside the process; the endpoint only re-reads). Subscribing would put a bundler-specific dev-only global inside a published library, tie the package to one bundler's HMR protocol, and make the library the watcher, which this project has consistently refused. Your job is to make the API the right shape for an app to call with a freshly handed module, not to detect anything.

The second: a processor that throws on evaluation is the NORMAL case in a dev loop, not an exception, because a developer saves mid-edit. It must leave the running indexer untouched, which means evaluating and validating before anything is registered, exactly as the server arrival fails before registering rather than unwinding after.

The third: do not tear down and rebuild the indexer. The warm fold is the entire point, and an indexer that briefly answers nothing is worse in a tab than on a server, because a UI is attached to it. Register beside, as the container already supports.

> **RE-ORDERED 2026-09-17 by the conductor, and the paragraph below is SUPERSEDED. Read this instead of it.** When this task was written a processor's identity was the author's declared `version`, so a handler-body edit did NOT move it: `unchanged` was the COMMON answer, and the drift report existed to explain why. ADR-0086 reverses both. Identity is now DERIVED FROM THE CODE and never declared, the browser's module arrival derives its own from the handler sources, and the drift report is deleted along with `version` itself.
>
> The SEQUENCING was changed rather than the premise patched: this task is now `blockedBy: [a-module-handed-to-a-tab-is-identified-by-its-handler-sources]`, which supplies that derivation, so HMR is built ONCE against the identity it will actually ship with instead of being built against the declared one and rewritten weeks later. When you build this, a real handler edit MOVES the identity and registers a successor; `unchanged` is RARE and TRUE (a hot update that genuinely changed nothing); and there is no drift report to point at, because the condition it described cannot occur.

Note that `unchanged` must still be LEGIBLE rather than looking like a failure, even though it is now the rare answer: a developer who saves without changing anything should be told so plainly rather than left wondering.

The seam to test at is the browser package's existing indexer tests, driving the handover directly rather than simulating a bundler: the claim worth asserting is "this running indexer held a warm fold, took a new processor, and answered throughout".

Done means: a save updates the running tab, a broken save changes nothing and says so, a burst stays bounded, and a production build carries no dev-only machinery.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise -- route the task to needs-attention with the discrepancy as the reason.

ADR-0084 and ADR-0085 both carry `status: accepted, not yet implemented`. If this is the last task of its ADR's family to land, REMOVE that line as part of this change; check rather than assume, and say which you did.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The exact shape of the exposed API (what it takes, what it answers, how it names the three outcomes), and what the tab reports for each of them, are such decisions. That the library exposes an API rather than subscribing is DECIDED above and is not yours to re-open. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**The API is a FREE FUNCTION, `reconfigureFromHotUpdate(indexer, {createState, createProcessor}, processorConfig?)`, and not a method on the hook.** A method would be reachable from the indexer object every app holds, so every production bundle would retain it; a free function goes out with the app's own `if (import.meta.hot)` block, which is what makes "a production build carries no dev-only machinery" a fact rather than a promise. I measured both (the test asserts the arrival is absent from a bundle of an app that only calls `createIndexerState`). It also reaches for nothing private, so it is genuinely an adapter over `addGeneration` rather than privileged access. Alternatives: a method on `createIndexerState(...)`'s return (discoverable, but always shipped), or a second factory wrapping the hook (a second way to build an indexer with no rule for choosing). **Touches:** nothing today; a worker-hosted app cannot use it, because a module object cannot cross a `MessagePort` — the arrival belongs wherever the container is built.

**The name.** `reconfigureFromHotUpdate` against the glossary: *reconfigure* already means "register a generation beside the live one, which is not an outage" (`addGeneration`'s own JSDoc, and the **generation** entry), and *hot update* is already the repo's word for this arrival (ADR-0086: "a no-op hot update"). It re-means nothing and duplicates nothing: `updateProcessor` stays the IN-PLACE verb and this is the beside-the-incumbent one. Alternatives considered and rejected: `applyHotUpdate` (says nothing about registering beside), `handOverProcessor` (invents a verb), anything with `hmr` in it (a bundler's acronym in a published API).

**The three outcomes reuse `ReconfigureReport`, and the type MOVED from `@etherfold/server` to `@etherfold/core`.** The AC asks for "the SAME shape the reconfigure endpoint uses", and a structurally-identical duplicate is three contracts that agree on the day they are written. The browser cannot depend on `@etherfold/server` (hono, `remote-sql`, `node:*`), and core is the only package every arrival already depends on — the same argument `core/src/index.ts` already makes for the reorg keys and the emission-stream port. The full rationale moved with it; `registry.ts` keeps a short note saying why it re-exports. Alternative: declare a browser-local twin, rejected as the drift this type exists to prevent. **Touches:** `@etherfold/server` (declaration only; every existing import, including the CLI's and the admin route's, is unchanged) and the future pushed-bytes arrival, which should answer this same type.

**`unchanged` is decided by ADD-THEN-COMPARE, not by derive-then-compare.** The identity of a module arrival is only knowable after `createProcessor` has returned, and `Indexer.add` already resolves a generation it holds rather than building a second engine over its state — so the honest question is "is the record that came back one I already had", which is what the function asks. Deriving the identity first would mean calling `createState` and `createProcessor` myself and then calling `add` with the same factories, i.e. building everything twice. The cost, stated: an `unchanged` still runs the app's `createState`, so a factory that creates a database creates one. **Touches:** nothing; `displacedBySuccessor` already declines to displace anything when the arriving generation occupies a slot, so an `unchanged` drops nothing.

**There is deliberately NO `{force}` on this call, and the message says where force lives.** Forcing means registering a generation beside one of the same name, and the name *is* the generation — it is not expressible on the beside-the-incumbent path. The `unchanged` message therefore names the one case that can still surprise a developer (a change the handler text does not carry: an imported helper, an entity declaration, a captured value) and points at `updateProcessor(next, {force: true})`, which costs the rebuild this call exists to avoid. Alternative: accept `{force}` and quietly ignore it, or synthesise a distinct identity — the second is the author-declared identity ADR-0086 deletes, wearing a flag. **Touches:** `updateProcessor`, which keeps `{force}` and is now documented as the escape hatch for this arrival too.

**The successor's store stays the APPLICATION's obligation, stated at the seam rather than solved.** A successor folds beside an incumbent that goes on writing, so it needs its own storage, and `GenerationContext` carries only `stream` — a processor change keeps the stream, so a `databaseName` keyed on the context alone collides. I did not widen the context or invent a default: the storage decision is the app's (ADR-0077), and `addGeneration` already has this shape and is already used this way by the existing suites. Instead the obligation is stated on `HotUpdateGeneration`, in both doc examples, and in the test fixture. **Touches:** the doc sites in the observation note above, which show the collision and predate this task.

**What the tab reports for each outcome is the app's, and the examples show one rendering.** `registered` names the generation now folding beside the live one; `unchanged` says plainly that the handler sources are the ones already running and that the warm fold was kept; `failed` carries the underlying message verbatim. The library logs the same three through `named-logs` in the words the CLI's re-read uses, so a browser console and a server log read alike.

**The reference app (`examples/browser-reference`) was NOT switched over.** Its axis-one block still calls `updateProcessor`, which remains correct and is the in-place verb; switching it would mean giving it a per-save store and is a change to the reference wiring rather than to this seam. The AC asks for a doc example and there are now two (package README and guide). **Touches:** a later task that wants the reference app to demonstrate the warm path.
