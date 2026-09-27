---
title: 'A worker host takes its provider and its settings from the tab that connects'
slug: a-worker-host-takes-its-provider-and-settings-from-the-tab
blockedBy: []
covers: []
---

## What to build

Today an app's worker entry (`hostIndexerInThisWorker` / `hostIndexerInThisSharedWorker`, `packages/browser/src/host/`) must hard-code everything: the provider has to be BUILT in the worker (from an RPC URL, since a provider object cannot be structured-cloned), and nothing the tab knows at run time (the chain the user connected, the deployments, the publication locations, the catch-up budget) can reach the host. Two consequences, recorded in `a-worker-hosted-tab-starts-from-a-publication`'s decisions: a wallet's provider cannot be used by a worker-hosted indexer, and neither can a provider that itself lives in ANOTHER worker, which is the case for `webevm` (an in-browser EIP-1193 node that runs in its own worker). Decided with the maintainer on 2026-09-27:

1. **The provider crosses as a PORT.** A `MessagePort` can be transferred where a provider cannot. Use `@eip-1193/over-port` (published, `^0.1.0`, MIT: `serveProvider(provider, port)` on the side that holds the provider, `providerOverPort(port)` on the side that uses it; errors keep `code`, `data` and `cause`, which the fetcher's refusal parsing reads). The tab may hand the host EITHER a `MessagePort` whose other end is already served elsewhere (for example by a `webevm` worker, so requests go worker to worker and the main thread relays nothing), OR a provider object (a wallet's), which the tab-side API serves on a fresh `MessageChannel` itself. The worker entry no longer needs to build a provider; building one in the worker stays supported.
2. **Settings are given when the tab connects**, the way `webevm`'s `createWorkerNode({worker, ...options})` passes cloneable options with the connection: the tab-side call takes the cloneable settings (at least `source`, `config`, `publication`, `catchUpWithinSeconds`) plus the provider port, and a worker entry can wait for them instead of hard-coding them. What must stay in the worker (code: `createState`, `createProcessor`, a processor module, a `keepStream`) stays in the entry. Values set in the entry and values sent by the tab: decide the precedence (or refuse a conflict by name) and record it.
3. **A SharedWorker host** serves several tabs: it takes the provider from a connected tab, and when that tab goes away it switches to another connected tab's provider rather than failing every request. Use the liveness the SharedWorker host already tracks for its tabs. With no tab left, it behaves as it does today when the provider fails.

Keep the main-thread host's API and behaviour unchanged. Document the new shape in `docs/guide/indexing-in-a-browser-app` (the worker recipe gains the tab-side call with the provider port and settings; show the wallet case and the provider-in-another-worker case), and amend ADR-0082 in place where it says a provider has to be built where the fold runs, citing this task.

## Acceptance criteria

- [ ] A dedicated-worker host folds through a provider handed as a port whose other end is served from ANOTHER context (a second `MessageChannel` end standing in for another worker), with no provider built in the worker entry; a refusal from that provider (a range hint in `error.data`, an archive refusal) is read by the fetcher exactly as from a local provider.
- [ ] A provider object handed by the tab (a wallet stand-in) is served on a fresh channel by the tab-side API and folds the same.
- [ ] Settings sent by the tab (`source`, `config`, `publication`, `catchUpWithinSeconds`) reach the host and take effect (asserted: the publication is used, the budget applies), and the chosen precedence or conflict refusal is tested.
- [ ] A SharedWorker host with two tabs keeps folding when the tab whose provider it uses goes away, switching to the other tab's provider.
- [ ] The main-thread host and the existing host suites are unchanged.
- [ ] The guide and ADR-0082 are updated; `pnpm docs:build` passes; changesets for every published package changed (0.x: patch or minor); `@eip-1193/over-port` is a dependency of `@etherfold/browser`.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: a worker host takes its provider as a port and its cloneable settings from the tab that connects (see What to build). Look at `packages/browser/src/host/` (`serve.ts`, `dedicatedWorker.ts`, `sharedWorker.ts`, `port.ts`, `endpoint.ts`), ADR-0082, the `@eip-1193/over-port` README (`node_modules/@eip-1193/over-port/README.md` once installed; read only that file), and `~/dev/github/wighawag/webevm/packages/webevm/src/worker-client.ts` for the connect-with-options shape.
>
> FIRST, check this task against current reality: if a host already takes a provider port or tab settings, adjust or route to needs-attention with the discrepancy.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **Precedence: neither side wins; a disagreement is refused by name.** The rule lives in `settleHostSettings` (`host/settings.ts`):
  - A setting the tab leaves out agrees with anything.
  - Before the host starts, a tab's value fills a gap and an equal value is accepted.
  - Once the host has started, its settings are fixed. A tab's value must equal the one in force, and a value for a setting the host started without is refused too, because it could not take effect.
  - A refused connect applies nothing. The error is `HostSettingsConflictError` with `fields`, which reaches the tab by name through the existing error details.
  - Alternatives considered: "tab wins" (not possible once the host has started) and "entry wins" (would silently ignore a tab's source).
  - This touches every worker host, and a SharedWorker with tabs that send different settings.
- **A provider is refused the same way.** If the entry built one, or a tab already handed one over, the new one is refused with `fields: ['provider']` and its port is closed. The alternative was letting the tab's provider replace the entry's.
- **When the host starts:** once it has a provider and a source, from any mix of entry and tab. An entry with both starts immediately, as before, so existing suites and apps are unchanged. The alternative, always waiting for a tab, would have changed every existing host.
- **How the tab learns the outcome: an `onConnect(outcome)` option, called once per host (first and every restart), plus a log line on refusal.** I first added a `connected` promise to `IndexerPort`, but three existing suites pin the port's exact list of members, so it would have required editing them. A callback also covers restarts, which a one-shot promise cannot.
- **Tab-side input forms:** a provider object, a `MessagePort`, or `() => MessagePort`. A bare port can only be transferred once, so restarting with one is refused with a message pointing at the function form; the restart is then abandoned and reported through `onHostDeath`.
- **The SharedWorker provider pool lives in `sharedWorker.ts`, the layer that already knows which tab sent what.** The host is handed one provider: the pool, served on an in-worker `MessageChannel`. This costs one extra structured clone per response inside the worker, and keeps `serve.ts` independent of the hosting shape. The alternative was passing a non-cloneable object through the multiplexer's in-process message, which bypasses the message types.
  - If the host refuses a tab's connect, that tab's provider leaves the pool (its settings, possibly its chain, are not the ones being folded).
  - If the entry built a provider, the pool is disabled and tab providers go to the host unchanged, so the host's refusal applies.
- **How the pool notices a tab went away, added on top of the liveness the host already tracked.** It still drops a tab whose port throws on a post, and now also drops one whose client port or provider port fires `close`, where the engine fires it (Node and current Chromium). Letting a tab go closes its provider, which rejects in-flight requests, and the pool retries them on the next tab. On an engine that fires neither signal, a vanished tab's in-flight request still hangs; this is documented in `sharedWorker.ts`. A heartbeat protocol was out of scope.
- **With no tab left:** a retryable `NoTabProviderError`, so the driver retries every second as it does when a provider is down, and resumes through the next tab that connects.
- **`MessageEndpoint.postMessage` gains an optional `transfer` argument.** Only the `connect` message uses it. Its settings are checked for cloneability separately, since a `MessagePort` in the payload is not a plain value.
- **The `eip-1193` type mismatch is handled with a cast in `serve.ts`,** not a dependency bump. `@eip-1193/over-port` types against `eip-1193` 0.7 and this package uses 0.6; at run time both are a single `request({method, params})`.
