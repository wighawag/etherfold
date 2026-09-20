# The fix, measured on the same instrument: scenarios 2a and 2b changed, and NOTHING ELSE did

ADR-0088 landed as `Indexer.open`'s two phases (`registerGeneration` / `holdGeneration`, `packages/core/src/container.ts`). This folder holds the evidence that it removed the stall WITHOUT buying it with a second fetcher, which is the failure the rejected candidate patch had and the reason this task was not a one-line predicate.

The harness is NOT copied here. It belongs to the measurement task that bought it and is re-run in place:

```sh
pnpm --filter @etherfold/browser exec tsx \
  ../../docs/spikes/the-reloaded-tab-stall-is-measured-on-the-configuration-a-tab-actually-has/measureTheReloadedTab.ts
```

`measurement-with-the-fix.txt` is that command's output with the fix in the tree. Read it against its two neighbours in `docs/spikes/the-reloaded-tab-stall-is-measured-on-the-configuration-a-tab-actually-has/`:

| scenario | today (before) | the rejected patch | shipped |
| --- | --- | --- | --- |
| 0. default MEMORY registry, changed handler | fetches | fetches | fetches |
| 1. changed-handler reload, durable registry | `CanonicalGenerationNotHeldError` | same refusal | same refusal |
| 2a/2b. **reload after a PROMOTION** | **STALLED, zero `eth_getLogs`** | fetches | **fetches** |
| 3. reload holding BOTH folds | fetches | fetches | fetches |
| 4. control, unchanged handler | fetches | fetches | fetches |
| 5. **the ORDER PROBE**, edited fold listed first | ONE fetcher | **2 FETCHERS, one log stored twice** | **ONE fetcher** |

A line-for-line `diff` against `measurement-today.txt` touches scenarios 2a and 2b and nothing else. What those two now report:

```
chain reads:        {eth_chainId: 2, eth_blockNumber: 1, eth_getLogs: 1}
eth_getLogs ranges: [{from: 102, to: 107}]
tab cursor:         lastToBlock 107, latestBlock 107   (the node's tip)
stored stream:      6 events, blocks [100,102,104,106], delivered twice: NONE, covers to 107
```

Scenario 5 is the one that matters for the SHAPE of the fix rather than its effect: it lists the same two folds edited-first, and the rejected patch (`the-narrow-fix-candidate.patch`, kept next door) turned it into two generations fetching one stream, the same range requested twice and block 106's log stored twice. It is unchanged here because the derivation is taken once, over the complete fold set, rather than per `add` over a `held` array that `open` is still filling.

Both properties are pinned as TESTS as well, so nothing here has to be re-run to catch a regression: `packages/browser/test/aTabHoldsItsGenerationsInSlots.test.ts` (the promotion-then-reload tab, asserted on the methods and the ranges it asks the node for) and `packages/core/test/follower.test.ts` (a registry that outlived its process, in both spec orders). Each fails against exactly one of the two wrong rules, checked by putting each back in turn.
