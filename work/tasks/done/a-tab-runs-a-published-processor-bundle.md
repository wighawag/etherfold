---
title: 'A tab runs a published processor bundle, and its identity is the bytes' hash'
slug: a-tab-runs-a-published-processor-bundle
spec: a-build-publishes-what-a-browser-app-starts-from
blockedBy: []
covers: [8]
---

## What to build

`@etherfold/browser` can take a processor as a URL to a published, self-contained bundle (the same bytes `etherfold build` folds with): it fetches the bytes, derives the identity as the SHA-256 of those bytes exactly as `processorArtifactIdentity` does, instantiates the processor FROM THOSE BYTES, and hands both to the generation (ADR-0086, ADR-0095). It is the browser counterpart of `loadProcessorArtifact`, and it works on the main thread and in both worker hosts, where the processor is instantiated inside the worker.

It must never report an identity for bytes it did not run: identity is derived from the bytes that are instantiated, never from a separately fetched or injected value (ADR-0095 refuses the injected-hash variant). Refusals are reported as outcomes: a bundle that still imports something (not self-contained), bytes that do not load, and a host that forbids instantiating from bytes (a strict Content-Security-Policy), which must name the policy as the reason.

## Acceptance criteria

- [ ] A tab given a bundle URL folds with it and registers its generation under the bundle's SHA-256, equal to what the CLI derives for the same file.
- [ ] The same in a dedicated worker and a SharedWorker host.
- [ ] A non-self-contained bundle, unloadable bytes and a refused instantiation are each reported as a distinct refusal and fold nothing.
- [ ] The module arrival (HMR) is unchanged, with its module identity.
- [ ] Tests cover the new behaviour, mirroring the existing browser identity and host suites.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: the bundle arrival in the browser (ADR-0086, ADR-0095). Look at `loadProcessorArtifact` / `processorArtifactIdentity` in `@etherfold/utils` (Node) and at `moduleProcessorIdentity` and `processorIdentity` on the browser's generation spec. ADR-0091 records which runtimes can instantiate from bytes; a browser can, subject to CSP. Test at the browser host seam with a real bundle built the way the examples build theirs.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-26. Read ADR-0095 and the spec `a-build-publishes-what-a-browser-app-starts-from`, and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **The bundle is a field on the generation spec, not only a free function.** The spec takes `processorBundle: {url, fetch?, importModule?}`, and the host loads it before building the store. Without this, a worker entry point would have to `await` the fetch before it starts listening. SharedWorker connect events would be lost, and a refusal would never reach the tab. `loadProcessorBundle` is also exported for apps that want to drive the load themselves. Alternative considered: only the free function, with the app passing `processorIdentity`. That is the injected-hash path ADR-0095 refuses. Touches: `BrowserGenerationSpec`, `HostedIndexerSpec`, `addGeneration`, the port's reconfigure.
- **Both factories get the loaded bundle as a new optional third argument.** `createState(context, patience, bundle?)` and `createProcessor(state, context, bundle?)` receive it, so the store can be declared from the entities the bundle itself declares. Module arrivals get `undefined`. The bundle's `processor` is typed `unknown`, because nothing type-checked bytes fetched at run time. Alternative considered: a discriminated-union spec type, which would be more precise but spreads into every internal caller.
- **Naming both `processorBundle` and `processorIdentity` is a new error.** It is thrown when the generation spec is built, as a wiring mistake. The bytes name themselves, and ADR-0095 refuses an injected identity.
- **Two new refusal reasons beyond Node's three.** `unreachable` covers a failed fetch or non-2xx response; it has no identity because no bytes arrived. `forbidden-by-policy` covers a CSP refusal. Hosts raise all refusals as `ProcessorBundleRefusedError`, whose fields cross the port.
- **CSP is detected by probing, not by reading the error.** A trivial module is imported through `data:` first, then `blob:`. The real bytes go through the first scheme that works, so any later failure is the bytes' own. The violation events are only used to name the directive and policy. Reasons: under a blocking policy, good and corrupt bytes reject with the same error, and the finding shows `data:` and `blob:` are separate CSP sources.
- **An `importModule` hook is injectable.** It follows the precedent of `loadProcessorModule`'s injectable importer. It is the only way to test the policy path in Node, and whatever it receives is a URL made of the hashed bytes, so it can't make the identity lie.
- **One load per bundle source for the life of the page or worker.** A reconfigure that only changes the source reuses the processor it already has, rather than silently picking up a redeploy. Refusals are not cached, so a later `init` retries.
- **The artifact identity moved into `@etherfold/core`, computed with viem's SHA-256.** It replaces utils' `node:crypto` version. It is synchronous and works without a secure context, so it runs on a plain-HTTP LAN tab. The output is identical, and the existing pinned utils test passes. It costs about 13 ms/MB on the CLI side. The `streamIdentity` test, which lists every `sha256` call site in core, now admits `processorArtifact.ts`, with the reason written next to it.
