# The reloaded-tab stall, measured: it is REAL, it needs an opt-in durable registry, and the trigger is a PROMOTION rather than a changed handler

The task `the-reloaded-tab-stall-is-measured-on-the-configuration-a-tab-actually-has` was a MEASUREMENT and a DECISION, with no behaviour change. This folder is the evidence, so the follow-on FIX task does not pay for the measurement twice. The decision it produced is **ADR-0088**.

Everything below was RUN, against `main` at `8ca52576`. The signal it was raised from (the observation `a-reloaded-tab-with-a-changed-handler-folds-its-stream-and-never-fetches`, discharged once this measurement and ADR-0088 carried it) was read off the source and explicitly not run, in both its original claim and its `## Update`.

## What is here

| file | what |
| --- | --- |
| `measureTheReloadedTab.ts` | the harness: six scenarios over a real IndexedDB registry, a real IndexedDB stream keeper and a recording fake chain |
| `measurement-today.txt` | its output against the tree as it ships |
| `the-narrow-fix-candidate.patch` | the obvious narrow fix, as a one-line change to `Indexer.add` (NOT shipped) |
| `measurement-with-the-narrow-fix.txt` | the same harness with that patch applied |

Run it from the repository root, after `pnpm install && pnpm build`:

```sh
pnpm --filter @etherfold/browser exec tsx \
  ../../docs/spikes/the-reloaded-tab-stall-is-measured-on-the-configuration-a-tab-actually-has/measureTheReloadedTab.ts
```

It is a SCRIPT and not a test on purpose: the task changes no behaviour and leaves nothing red, so nothing here may be collected by `packages/browser`'s vitest config, and no file under `packages/*/src` or `packages/*/test` changed.

## The instrument

`fakeChain` (the browser package's own workload fixture) records `eth_getLogs` RANGES and nothing else, which cannot answer this question: **a follower's first advance still calls `load()`, and `load` opens with the `eth_chainId` identity handshake (ADR-0081), so a tab that fetches nothing still makes one chain read.** The harness therefore wraps the provider and records EVERY method, and every table below separates the handshake from the log fetching.

Two more things the instrument does, because without them a stall is not distinguishable from health:

- **The chain MOVES ON while the tab is closed** (`BRANCH_A_EXTENDED`: a transfer in block 106, tip 107). Otherwise "asked for nothing" means "already at the tip" and the measurement says nothing.
- **The stored stream is read back afterwards** and checked for a log delivered twice and for what its cursor claims to cover. That is the duplicate-or-hole question ADR-0087 measured on the receiving side, and it is invisible in a `follows` flag or a count of chain reads.

The tab's driver is reproduced rather than approximated: `load()` once, then `indexMore()` to the tip, because `setupIndexing` does exactly that (`packages/browser/src/IndexerState.ts:1326`). A container whose first act is `indexMore()` over a stored stream throws `indexing... should not replay`.

## Result 1 -- WHICH REGISTRY A REAL TAB HAS: a MEMORY one, and the stall cannot be reached on it

Both real entry points default to a memory registry:

- `createIndexerState` -- `spec.registry ?? (await openMemoryGenerationRegistry(BROWSER_GENERATION_CAPS))`, `packages/browser/src/IndexerState.ts:1202`
- the worker / SharedWorker hosts -- the same expression, `packages/browser/src/host/serve.ts:374`

`packages/core/src/generation/memory.ts` says plainly that what it does NOT do is survive a reload, so on the default a reload starts with an EMPTY registry. Measured (scenario 0): the sole fold takes `canonical`, `fetcherOf` names itself, `follows` is `false`, and the tab asks for `{eth_chainId: 2, eth_blockNumber: 1, eth_getLogs: 1}` over `102..107` and lands on the tip.

**Nothing in `packages/*/src`, `examples/`, `platforms/` or `docs/` ever passes the durable `openGenerationRegistryOnIndexedDB`.** Only tests do. So the reachability answer is: **the stall requires an opt-in durable registry.** That is not a test-only configuration -- it is the documented way to keep a superseded generation so the pointer can be moved BACK to it (`IndexerState.ts:502-510`, and the changeset that introduced the default) -- but it is an opt-in, and no shipped code takes it.

## Result 2 -- TRIGGER A (a changed-handler reload) is a REFUSAL, not a stall

Scenario 1: session 1 indexes on the app's fold; session 2 reloads over the DURABLE registry with the edited bundle only.

```
REFUSED: CanonicalGenerationNotHeldError
  slots after session 1: {canonical: the-app}
  chain reads:           {}   (it never got as far as a handshake)
```

The container refuses to open rather than coming up healthy and idle. **A refusal is a materially different bug class from a silent stall and is recorded as one here.** It is also why the existing reload test holds both folds (see Result 5): with one fold that container does not merely fail, it throws.

## Result 3 -- TRIGGER B (a reload after a PROMOTION) IS the silent stall, and here are its numbers

Scenario 2: session 1 indexes on fold A, saves fold B beside it, and the default `on-catch-up` policy promotes B. `dropOnPromotion` defaults to `false` and a generation `predecessor` names is untouchable, so **A survives as `predecessor`**. Session 2 reloads with B's bundle alone -- which is all a tab can supply, because A's code is not in the bundle that just loaded.

```
STALLED -- and it opened healthy
  slots:              {canonical: edited-by-3, predecessor: the-app}
  held by the tab:    [edited-by-3]
  fetcher on stream:  the-app          <- older, registered, NOT held
  follows:            true
  chain reads:        {eth_chainId: 1}
  eth_getLogs ranges: []               <- NONE, ever
  node tip:           107
  tab cursor:         lastToBlock 105, latestBlock 105
  reported phase:     "at-tip"         <- through the host's OWN pacing rule
  stored stream:      5 events, blocks [100,102,104], covers to 105
```

Read the last four lines together, because they are the failure: the tab is two blocks behind a chain it will never ask about again, and it reports itself LIVE. `latestBlock` is 105 because a follower never calls `eth_blockNumber`, so `someGenerationBehind` (`packages/browser/src/host/pacing.ts`) compares 105 against 105 and answers `at-tip`. There is a UI attached to this, it answers reads, and nothing about it looks wrong. The stored stream is frozen at 105 too: nothing in this process writes it, so the re-fold a follower does can never catch up either.

**One chain read, and it is the handshake.** Zero `eth_blockNumber`, zero `eth_getLogs`. This is the same shape ADR-0087's own amendment measured for the restarted deployment (`["eth_chainId"]` and nothing else, for ever).

Measured TWICE -- once with a fresh state for B and once carrying the store session 1 folded into, which is what a reload really is -- because the stall must not depend on which. It does not: both are identical, line for line.

## Result 4 -- the mechanism, checked step by step against the source

The observation's original chain was traced and not run. Every step was re-checked here, and the score is: steps 1 to 5 correct, the CONCLUSION wrong for the trigger it named, and the `## Update`'s replacement hypothesis CORRECT.

| claim | verdict |
| --- | --- |
| `indexMore()` routes each held entry by `entry.follows ? followMore() : indexMore()`, and a follower fetches nothing | TRUE (`container.ts:1109`), and measured: zero `eth_getLogs` |
| a tab opens holding exactly ONE fold | TRUE -- `generations: [generationSpecFor(...)]` (`IndexerState.ts:1207`) and `generations: [generationSpecOf(...)]` (`host/serve.ts:379`) |
| a reload with changed code is a new identity registered beside the previous session's | TRUE (ADR-0086), and the previous session's record survives |
| `fetcherOf` names the OLDEST surviving generation on the stream | TRUE (`registry.ts:628`), measured naming `the-app` while the tab holds only `edited-by-3` |
| ...so a changed-handler reload stalls silently | **FALSE.** It REFUSES (Result 2), and on the default registry it does not even do that (Result 1) |
| ...but a reload after a PROMOTION stalls silently | **TRUE**, measured (Result 3) |

## Result 5 -- the existing test's two-generation configuration is NOT reachable from any real entry point

`packages/browser/test/aTabHoldsItsGenerationsInSlots.test.ts` opens its reloaded container with

```ts
generations: [generationOver(..., processor, APP_IDENTITY), generationOver(..., editedTo(3), identityFor(3))],
```

and then asserts "AND IT STILL FETCHES". Reproduced here (scenario 3): it fetches, `102..107`, one `eth_getLogs`.

**Neither real entry point can produce that list.** `createIndexerState` builds a one-element `generations` list from ONE `BrowserGenerationSpec` (`IndexerState.ts:1207`); `hostIndexerInThisWorker` / `hostIndexerInThisSharedWorker` build a one-element list from one spec (`host/serve.ts:379`). A second generation can only arrive at RUNTIME, through `addGeneration`, which is a save -- and the fold a save arrives with is the one in the bundle that is running, never the previous handler's code. So the property is asserted under a configuration production never produces.

**Judge it as a CONSTRAINT rather than an oversight, exactly as the task says.** Opening that container with only the edited fold does not fail, it THROWS (Result 2): the registry's canonical is the incumbent and `resolveCanonical` refuses when canonical is not held. Holding both is the only way that container opens at all. What the suite cannot say today is the thing this task measured, and the honest re-scope is not "open with one generation" (that throws) but the promotion-then-reload shape of Result 3 -- which belongs to the FIX task, green, together with the fix.

## Result 6 -- the obvious narrow fix works, and then duplicates the history

`the-narrow-fix-candidate.patch` is the one-line change the observation gestures at: `follows` additionally requires that the generation `fetcherOf` names is one this container HOLDS.

```diff
-const follows = !!fetcher && !sameGeneration(fetcher, record);
+const fetcherIsHeldHere = !!fetcher && this.held.some((entry) => sameGeneration(entry.record, fetcher));
+const follows = !!fetcher && !sameGeneration(fetcher, record) && fetcherIsHeldHere;
```

With it applied, `pnpm --filter @etherfold/core --filter @etherfold/browser test` is **green** (1204 + 373 passing), and the stall is gone:

```
2a/2b FETCHES -- {eth_chainId: 2, eth_blockNumber: 1, eth_getLogs: 1}, range 102..107, cursor 107
      stored stream: 6 events, blocks [100,102,104,106], delivered twice: NONE, covers to 107
```

**And that is the interesting half: no duplicate and no hole.** The duplicate-or-hole result ADR-0087 measured on the receiving side does NOT transfer to this runtime as written, and the measurement says why: there the restarted successor's state was empty and it fetched from `defaultFromBlock`, re-appending history the stream already covered, through an append-only `EmissionAppender` with no guard. Here `promiseToLoad` REPLAYS the stored stream before anything is fetched, so the fold lands exactly ON the coverage and `streamCanReceive` compares two numbers it actually holds. That is ADR-0044's follower rule doing load-bearing work.

**The hazard is somewhere else, and it was measured.** `this.held` is populated INCREMENTALLY during `open`, so this form reads a half-built array -- and `Indexer.add`'s own comment says `follows` is asked of the durable registry and NOT of `this.held`, "which is whatever order the caller passed its specs in". Scenario 5 lists the same two folds edited-first:

| | today | with the narrow fix |
| --- | --- | --- |
| `follows` | `{edited-by-3: true, the-app: false}` | `{edited-by-3: false, the-app: false}` |
| fetchers on one stream | 1 | **2** |
| `eth_getLogs` | 1 (`102..107`) | **2** (`102..107` twice) |
| stored stream | 6 events, none twice | **7 events, `0xa106:0:applied x2`** |

Seven rows where six are correct, which is the same sentence ADR-0087 writes about `_emissions` holding four where two are correct. So the narrow family's known hazard IS reachable here -- not through the ahead/behind timing the ADR names, but through the order dependence the naive derivation introduces. **A narrow fix escapes it only by deriving over a set that does not depend on the order the caller listed its specs in.** ADR-0088 is that decision.

## What was deliberately NOT done

No behaviour change, no fix, no re-scoped reload test, nothing red, no changeset: no file under `packages/*/src` or `packages/*/test` differs from `main`. The patch above was applied, measured, and reverted.
