---
title: 'An endpoint triggers a reconfigure in a running process, so a watcher can drive the loop'
slug: an-endpoint-triggers-a-reconfigure-in-a-running-process
spec: a-change-reaches-a-running-deployment
blockedBy: [a-successor-that-was-never-canonical-is-superseded]
covers: [1, 2, 3, 4, 5, 6, 7, 8]
---

## What to build

The trigger the reconfigure story has never had: a way for a changed processor or source to reach a RUNNING deployment.

Everything downstream of "a successor exists" is already built and careful. A successor is registered beside the incumbent and nothing is discarded. The incumbent goes on answering every read. A follower is advanced by a bounded rebuild the host schedules. The promotion policy then decides when the pointer moves, and `on-catch-up` is the default everywhere. Note precisely what that does and does not mean today: the policy speaks ONLY for a fold added to a container that is already open (`applyPolicyTo` returns while `opened` is false, and `open()` adds the configured fold before setting it), and no CLI deployment ever adds one, so on every CLI shape the policy is currently INERT rather than merely unselectable. This endpoint is what gives it something to speak about. What is missing is the thing that INTRODUCES the successor: a generation is registered when the container OPENS, from config, and nothing in the CLI watches a file or exposes a route that adds one. So a changed processor reaches the process by restarting it.

Build the trigger as an **ENDPOINT**, and leave whatever notices a file changed OUTSIDE the process. That split is the decision: a file watcher inside the CLI would be dev tooling by construction, which is what makes it tempting to gate behind a dev flag and then need a second mechanism for production. An endpoint is called by a dev watcher, a deploy hook or a CI step equally.

It sits beside the pointer move, on the admin credential, which is already deliberately a second credential and never the ingest one. So the authorisation story is the existing one rather than a new one.

**Its job is RE-READ, not receive.** A processor is code and cannot cross HTTP, so the endpoint cannot be handed a new one. It re-resolves the configuration, re-imports the processor, and registers whatever generation that now names beside the incumbent. The watcher owns WHEN, the process owns WHAT.

Two things decide whether this is usable or maddening, and both are about a reload that finds nothing to do or cannot be done at all. A processor that does not compile is the normal case in a dev loop, not an exception: the source usually changes first and the handlers follow, so the endpoint will be called while the module is broken. It must leave the running deployment exactly as it was and say what went wrong, because the watcher will call again in seconds. And a reload that succeeds but changes no identity must say so, rather than looking the same as one that did nothing.

## Acceptance criteria

- [ ] A call to the endpoint on a running deployment registers a successor for the current configuration, beside the incumbent, without restarting the process, and the incumbent keeps answering reads throughout.
- [ ] It picks up an EDITED processor module, rather than a cached copy of the one already loaded. Asserted by changing a module between two calls and observing the second registers a generation the first did not.
- [ ] A processor that fails to import leaves the deployment exactly as it was (same generations, same canonical pointer, still folding and still answering) and the call reports the failure. Nothing partial is registered.
- [ ] A call that finds no change in identity is a successful no-op that SAYS it changed nothing, distinguishable in the response from one that registered a generation and from one that failed.
- [ ] The endpoint answers WHAT it did, naming the generation it registered, so "I saved the file and nothing happened" is not three indistinguishable outcomes.
- [ ] It is authorised by the same credential as the existing pointer-move route, and is refused without it.
- [ ] It refuses honestly on a deployment that cannot serve it, in the shape the other capability refusals already use, rather than appearing to succeed.
- [ ] Repeated calls in quick succession stay bounded: the deployment does not accumulate a successor per call. (This is what `a-successor-that-was-never-canonical-is-superseded` provides; assert the end-to-end property here.)
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style, and the `@etherfold/server` platform-agnostic source scan still passes.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-successor-that-was-never-canonical-is-superseded`. Not a code dependency: this endpoint makes churn trivial to produce, and without supersession a handful of calls exhausts the generation cap and leaves an operator deleting generations by hand. Shipping the trigger first would make the wall the first thing anyone meets.

## Prompt

The goal is that a developer edits a handler, their watcher rebuilds and calls one endpoint, and the deployment they are already running picks it up.

Read `work/notes/observations/a-reconfigure-cannot-reach-a-running-run.md`, which has the decided shape, the negative evidence (nothing watches, no route adds a generation, SIGINT and SIGTERM only) and the two mechanism hazards below. Then read `@etherfold/server`'s `api/admin.ts` for the shape of an admin route and what guards it, and `@etherfold/utils`' `loadProcessorModule` for how a processor is resolved and imported.

The first hazard is the module cache. `loadProcessorModule` ends in `import(specifier)`, so re-importing an unchanged path returns the CACHED module and a reload would see nothing at all. There is already an injection point for this, `LoadProcessorModuleOptions.importModule`, so a cache-busting specifier or a fresh worker can be supplied without changing the loader's shape. Whichever you choose, know its cost: a cache-busting query adds a module instance to the registry per reload and none are collected, which is fine for a dev loop and worth stating for a long-lived process.

The second is that a reload can legitimately register nothing, because a generation is registered only when its identity DIFFERS and the processor half of that identity is a hash. Its code fingerprint hashes the SOURCE TEXT of the author's handlers, so a change carried by a closure-captured value fingerprints identically (`work/notes/findings/the-processor-fingerprint-is-blind-to-closure-state.md`). An ordinary edit does change source text, so this is not the common case, but it is why the endpoint has to report what it did rather than return an empty success.

The decision most likely to be got wrong: do not make the endpoint restart anything, and do not have it tear down the container to rebuild it. The container already supports registering a generation beside a live one, and the incumbent answering reads throughout is the property this whole feature exists to preserve. A reload that briefly stops answering is a worse outcome than the restart it replaces.

The seam to test at is the server's existing API test setup for the route and its refusals, plus a deployment stood up the way the CLI tests already stand one up, so the claim checked is "this running deployment picked up an edited processor" rather than "this function returned an object".

Done means: a watcher can call one endpoint after a rebuild, a good processor is picked up without a restart, a broken one changes nothing and says why, and calling it repeatedly does not fill the registry.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. How the module cache is defeated and what that costs a long-lived process, and what the endpoint answers in each of its three outcomes, are both such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**The task's hazard 2 is factually wrong, and I built on the corrected premise rather than the stated one.** The task and `a-reconfigure-cannot-reach-a-running-run.md` say the processor half of a generation identity is a hash of the handlers' SOURCE TEXT, and conclude that "an ordinary edit does change source text, so this is not the common case". It is not: the identity is `getVersionHash()` = `${version}-${simple_hash({entities, config})}`, and `getCodeFingerprint()` is a separate ADVISORY value that `packages/core/src/utils/fingerprint.ts` deliberately keeps out of the identity (a recorded deviation from ADR-0008). `CONTEXT.md`'s own `generation` entry already has it right. I did **not** stop, because the correction does not change what to build — it strengthens the reason the endpoint must report `unchanged` distinctly, which the spec's story 4 already demanded — and folding the fingerprint into the identity to "fix" it is the one thing `fingerprint.ts` argues against by name. What it changes is the FREQUENCY: `unchanged` is what an ordinary handler edit gets, not the rare case, so the `unchanged` message names `version` as the thing to bump. Alternative considered and rejected: making the identity fingerprint-sensitive (invalidates every deployment's state on a minifier change). Touches: the source observation note and the task body, both of which now mislead (observation note filed).

**A failed re-read is `409`, not `400`/`500`/`503`.** The request is well formed (`400` is wrong), the capability is present (`501` is taken), and this is not a host fault (`500` is alarming and wrong). What is true is that the deployment's current state conflicts and an identical re-send after the next build succeeds, which is RFC 9110's `409` and is exactly what this repo already spends `409` on as ADR-0004's one resumable refusal. Touches: what a watcher branches on.

**The three outcomes ride in the BODY (`outcome: registered | unchanged | failed`), not in status-code subtleties.** `200` for both successes rather than `201`/`204`, because `201` implies a Location and a watcher distinguishing outcomes by status nuance is a worse contract than a named discriminant. `registered` and `unchanged` both NAME the generation in the pointer move's own shape (`{stream, processor, digest}`), so the value answered is the value an operator matches or promotes.

**The type is `ReconfigureReport`, not `ReconfigureOutcome`.** Coherence check: `ReconfigureOutcome` is already taken in `@etherfold/core` for the IN-PLACE verb's discard verdict, and `@etherfold/browser` already met this exact collision and sidestepped it (`HostReconfigure`, with a JSDoc saying why). I initially wrote `ReconfigureOutcome`, caught it against the glossary, and renamed. The wire field stays `outcome` because that is the caller-facing word. Touches: `@etherfold/core`'s type of the same name, `@etherfold/browser`'s `HostReconfigure`.

**The module cache is defeated by a cache-busting file-URL query, not a fresh worker.** Cost, stated rather than discovered: every reload adds a module instance to the ESM registry and none are ever collected, since the registry is keyed by URL for the life of the process. That is nothing for a dev loop and a slow unbounded growth for a long-lived process poked frequently, so a production caller should trigger per BUILD, not per minute. The alternative (a worker per reload) costs a process boundary the fold would then have to cross. An INJECTED `importModule` wins untouched, because a test double is stating what comes back. Touches: `LoadProcessorModuleOptions.importModule`, and any future decision to run the fold out-of-process.

**An identity this process already holds a FOLD for is answered `unchanged` WITHOUT calling `add`.** `add` does not deduplicate: the registry resolves an identity it already holds, but the container still builds a second fold over the same state and starts re-folding the stream into it beside the first. So the identity is computed first and compared against `container.held()`. Without this, a watcher calling on every save would quietly accumulate duplicate in-memory folds writing into one namespace. Touches: `ReceivingIndexer.add`'s resolve-rather-than-create behaviour.

**A re-read whose config names a different INDEXER or a different DATABASE is `failed`, not silently ignored.** Those two decide where rows go and what key they carry, and neither is re-appliable on a running process. Every other re-read input (node URL, rps, port) is deliberately NOT refused and is documented as belonging to the fetcher and server this call does not rebuild — refusing on those would be noise. Touches: `resolveCommandConfig`, and the repo's "nothing is accepted and ignored" rule.

**Scoped to `run`; `index` does not get it.** `index` holds a processor path and a container and could answer the capability nearly free, but its source is explicit and its fold is driven by a remote writer, so it is a different story with its own refusals. The capability is an entry method, so `index` can gain it later with no change to the route. It currently answers `501 reconfigure-not-held`, which is honest. Touches: a possible follow-up task.

**A filter/source change registers a generation this process's single fetcher will not feed.** Pre-existing and out of scope (`a-deliberate-freeze-is-not-visible-on-a-filter-change`): `run` builds one fetcher over one scalar source. The processor-only case (the dev loop this exists for) is a follower on the same stream, advanced by the scheduled rebuild and auto-promoted — asserted end to end.
