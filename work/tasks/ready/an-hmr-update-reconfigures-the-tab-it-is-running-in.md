---
title: 'An HMR update reconfigures the tab it is running in, so a handler edit keeps the warm fold'
slug: an-hmr-update-reconfigures-the-tab-it-is-running-in
spec: a-processor-reaches-a-deployment-however-it-arrives
blockedBy: [the-chain-facing-container-holds-its-generations-in-slots]
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

Note also that an identity is unchanged by a handler-body edit unless the author's `version` is generated, so `unchanged` will be a COMMON answer here and must be legible rather than looking like a failure. The drift report task covers saying why.

The seam to test at is the browser package's existing indexer tests, driving the handover directly rather than simulating a bundler: the claim worth asserting is "this running indexer held a warm fold, took a new processor, and answered throughout".

Done means: a save updates the running tab, a broken save changes nothing and says so, a burst stays bounded, and a production build carries no dev-only machinery.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise -- route the task to needs-attention with the discrepancy as the reason.

ADR-0084 and ADR-0085 both carry `status: accepted, not yet implemented`. If this is the last task of its ADR's family to land, REMOVE that line as part of this change; check rather than assume, and say which you did.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The exact shape of the exposed API (what it takes, what it answers, how it names the three outcomes), and what the tab reports for each of them, are such decisions. That the library exposes an API rather than subscribing is DECIDED above and is not yours to re-open. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
