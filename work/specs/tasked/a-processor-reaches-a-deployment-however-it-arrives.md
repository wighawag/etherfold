---
title: 'A processor reaches a running deployment however it arrives: read from disk, pushed as bytes, or handed over by HMR'
slug: a-processor-reaches-a-deployment-however-it-arrives
taskedAfter: [a-save-replaces-the-pending-successor]
---

> Launch snapshot -- records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **PARTIALLY TASKED, THEN CARVED (2026-09-16).** This spec was moved to `work/specs/tasked/` after only its BROWSER arrival (stories 1-3) had been tasked, as `an-hmr-update-reconfigures-the-tab-it-is-running-in`. Stories 4-11 were never tasked, so this folder was claiming something untrue about them. They have been carved out rather than re-tasked here:
>
> - **Stories 4-8 and 10, the PUSHED arrival**, are now `work/specs/ready/a-processor-artifact-is-pushed-to-a-running-deployment.md`.
> - **Story 11, a processor's identity coming from its bytes**, is GENERALISED by ADR-0086 from the pushed arrival to EVERY arrival, and is built by `work/specs/tasked/a-processor-is-a-bundle-and-its-hash-is-its-identity.md`.
> - **Story 9, "the re-read arrival unchanged, so that this is an addition rather than a migration", is WITHDRAWN.** ADR-0086 makes a bundle mandatory for every arrival, so the re-read path takes a bundle and this IS a migration. It is a cheap one (nothing is published) but the story as written is no longer true and is not carried forward.
> - The **Out of Scope** item below reading "changing what an identity means for the other two arrivals" is likewise superseded by ADR-0086, which changes it deliberately.
>
> Nothing in the body below is edited; this note records where each untasked story went.

## Problem Statement

`an-endpoint-triggers-a-reconfigure-in-a-running-process` built ONE way for a changed processor to reach a running deployment: the endpoint RE-READS it from the filesystem, behind a cache-busting URL query because a dynamic import of an unchanged path returns the cached module. That is the right shape for a Node process with a disk, and it is the only shape there is.

Two deployments cannot use it. A **browser tab** has no filesystem to re-read and no route to call, so today a developer changing a handler reloads the page, which throws away a warm fold and is the restart this whole family of work exists to remove. A **remote or containerised deployment** has a filesystem, but not one the developer's build can write to, so "the new processor is on disk" is a deployment step that has to happen before the endpoint is worth calling, which is most of the work the endpoint was meant to remove.

The re-read shape also fixes what an identity can be. Because the deployment loads whatever the path holds, the only identity available is the one the author DECLARED, and an author who edits a handler without regenerating their `version` is truthfully told nothing changed.

## Solution

Separate the TRIGGER from the ARRIVAL. The container already does the one thing that matters, which is registering a successor beside a live incumbent; what differs between deployments is only how the processor got there. Support three arrivals against that one seam.

**Read from disk.** Exactly what ships today, unchanged, for a Node deployment with a processor path.

**Pushed as bytes (DECIDED, DEFERRED).** Recorded in ADR-0085 and deliberately not built yet: no deployment today is one the developer's build cannot write to, and this is the arrival carrying every cost (remote code execution on the admin credential, a payload bound, a content type, a refusal for a bundle that is not self-contained). It is described here so the seam is shaped for three arrivals rather than two. A pre-bundled, content-addressed artifact arrives in the request and is instantiated without touching the filesystem, from a `data:` URL in Node (ADR-0085). This reaches the containerised and remote deployments, and it makes the cache-busting query unnecessary on that path, because distinct bytes are a distinct module by construction. It is guarded by the admin credential, which is the same credential the pointer move already uses.

**Handed over by HMR.** In a browser tab the bundler has ALREADY replaced the module: `import.meta.hot` hands the page a new module object directly. So there is nothing to upload, nothing to instantiate and no cache to defeat. The tab reconfigures ITSELF by handing the container the processor it was just given, which means no route, no credential and no bytes crossing anything. This is the arrival that makes an in-browser indexer keep a warm fold across a handler edit.

Those three converge on one call: register this processor as a successor. Everything downstream, the slot it lands in, the promotion policy, the incumbent going on answering, is already built.

## User Stories

1. As a developer running an indexer in a browser tab, I want editing a handler to update the running indexer through HMR, so that I keep my warm fold instead of reloading the page and re-indexing.
2. As a developer in a browser tab, I want the incumbent generation to go on answering my app's reads while the new one catches up, so that my UI does not go blank while I iterate.
3. As a developer in a browser tab, I want an HMR update whose processor throws on evaluation to leave the running indexer exactly as it was, so that a half-typed handler does not cost me my state.
4. As a CI system or deploy hook, I want to push a built artifact to a running deployment over the admin credential, so that a deployment with no filesystem access to my build can still pick it up.
5. As an operator, I want a pushed artifact that is not self-contained to be REFUSED with the reason, so that a bare specifier fails at the push instead of at the first event it folds.
6. As an operator, I want the push bounded in size and stating its content type, so that this endpoint cannot be used to exhaust the process.
7. As an operator, I want a pushed processor that fails to evaluate to leave the deployment exactly as it was, with nothing partial registered, exactly as a failed re-read already does.
8. As an operator, I want the three arrivals to report the SAME three outcomes (registered, unchanged, failed) in the same shape, so that a watcher branches on one contract rather than three.
9. As an author of a Node deployment with a processor path, I want the re-read arrival unchanged, so that this is an addition rather than a migration.
10. As an operator, I want to know WHICH arrival registered a generation, so that "the endpoint says unchanged" and "HMR handed us the same module" are distinguishable in a log.
11. As a developer, I want a pushed artifact's identity to come from its bytes rather than from a version I must remember to bump, so that my change is never silently ignored.

## Implementation Decisions

ADR-0085 carries the rationale for the pushed artifact: pre-bundled, content-addressed, instantiated from a `data:`/`blob:` URL, and why WASM is not what buys these properties (bytes are; WASM's extra buy is sandboxing, which is a multi-tenancy requirement rather than an indexing one, and a deployment accepting an upload on its admin credential is accepting code its operator already trusts).

Three things this spec adds.

**The browser arrival needs no ADR-0085 machinery at all, and that is the point.** HMR has already done the module replacement, so the tab passes a module OBJECT, not bytes. No upload, no `blob:` URL, no cache-busting, and crucially no authorisation question, because there is no remote caller: the page reconfigures itself with what its own dev server handed it. The authorisation question only exists for pushing INTO a tab from outside, which nothing needs.

**The seam is `add` a successor, and the arrivals are thin.** Whatever machinery this spec builds belongs in front of that call, not inside the container, which already accepts a processor and registers it beside a live one.

**Identity from bytes lands on the pushed arrival only.** The hash of a received artifact is available exactly when an artifact was received. A re-read from disk still has only the declared version, and an HMR handover has a module object whose bytes were never seen. So story 11 is a property of one arrival rather than a change to what an identity IS everywhere, which keeps it clear of the build-determinism trade recorded in `a-save-replaces-the-pending-successor`.

## Testing Decisions

The pushed arrival tests at the server's existing API test setup for the route and its refusals, plus a deployment stood up the way the CLI tests already stand one up, so the claim checked is "this running deployment picked up a pushed processor". The browser arrival tests where the browser host is already tested, driving the handover directly rather than simulating a bundler: the claim worth asserting is "the tab held a warm fold, took a new processor, and the incumbent answered throughout". The failure cases matter more than the success ones here and should be asserted per arrival: a processor that throws on evaluation leaves generations, pointer and fold exactly as they were.

## Out of Scope

**WASM.** ADR-0085 records why. Revisit only if etherfold hosts processors it did not author, which is the condition that made The Graph choose it.

**Changing what an identity means for the other two arrivals.** Covered above; the artifact hash is available only where an artifact was received.

**Watching files.** Whatever notices a change stays outside the process, which `a-change-reaches-a-running-deployment` decided and this spec does not revisit. HMR is not an exception to that rule but an instance of it: the bundler is the watcher, and it already exists.

## Further Notes

Worth recording for whoever builds this: Ponder, the closest neighbour to this design, provides no production update surface at all. Its reserved routes are `/health`, `/ready`, `/status` and `/metrics`, `ponder start` builds once and ignores file changes, and a changed processor reaches production by starting a new process in a new schema and flipping a set of views. Hot reloading exists only in `ponder dev`. So the three arrivals here are not catching up with prior art; they are further than it, and the browser arrival in particular has no equivalent anywhere, because no comparable indexer runs in the page.
