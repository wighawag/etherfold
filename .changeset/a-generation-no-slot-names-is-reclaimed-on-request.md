---
'@etherfold/core': minor
'@etherfold/server': minor
'etherfold': minor
---

A generation NO SLOT NAMES is RECLAIMED on request, so a cap stops being the only instrument an operator has.

A generation cap REFUSES at its bound and never evicts, which is sound and was the ONLY mechanism there was: when it fires an operator is told what they COULD delete and handed nothing to delete it with, so the remedy was hand-written SQL or a deleted database. The durable slots (ADR-0084) make the missing verb expressible for the first time, because a generation no slot names is garbage BY DEFINITION rather than by a judgement about which of four digests is safe to remove.

**`ReceivingIndexer.reclaim()`** drops every registered generation no slot names and REPORTS what came back. The deletion is not new: it is the registry's own `deleteGeneration`, which takes the row, the state namespace (ADR-0053 makes that a `DROP`) and the stream where no registered generation is left folding it. What is new is the verb and the rule for choosing.

```ts
const report = await container.reclaim();
report.outcome; // 'reclaimed' | 'declined' | 'nothing-to-reclaim'
report.reclaimed; // each generation NAMED, with the stream reaped and the records that went with it
report.declined; // each one kept, and WHY
report.slots; // what canonical / successor / predecessor hold, which a reclaim never touches
```

**It never takes a generation any slot names, and `predecessor` is the one worth saying out loud**: it is not canonical right now and is exactly the way back from a bad upgrade, so "not canonical" would have been the wrong predicate. The rule is a REFCOUNT over the slot rows (`unslottedGenerations`, exported from `@etherfold/core`), which is what makes a verb that DELETES safe to hand an operator.

**It DECLINES rather than refusing where dropping would strand a fold that follows the stream that generation writes** (ADR-0044), exactly as the existing drops decline, and says so per generation. A deletion that failed is reported the same way and the generation is still named by no slot, so the next call tries again.

**Three answers, because "nothing happened" had three causes.** `reclaimed` names what went; `declined` says something was reclaimable and could not go yet; `nothing-to-reclaim` is a SUCCESS that says every generation this indexer holds is named by a slot. Collapsing the last two would tell an operator whose disk is full that there was nothing to free.

**The operator's affordance is HTTP, beside the pointer move** (ADR-0057's reasoning, unchanged: a Worker is reachable only over HTTP and the CLI command set is pinned at five names):

- `POST /{indexer}/admin/reclaim-generations` — the verb, on `ADMIN_TOKEN`, which fails closed and is deliberately never the ingest credential. It takes no body. `501 reclaim-not-held` on a host that holds no generations.
- `GET /{indexer}/admin/canonical-generation` — widened to report `slots` (what each of the three holds), `unslotted` (everything no slot names) and a `slot` on each listed generation. This is the SEE half, so an operator stops matching digests by eye.

`IndexerRegistryEntry` gains the optional, paired `slots()` and `reclaim()`, forwarded by `indexerEntryOn`; `etherfold run` and `etherfold index` answer both. `GenerationDeletion` now also carries `records`, how many substrate records a reaped stream subtree held, so the report can say what actually came back.

**It is a VERB an operator runs and NOT a garbage collector.** Nothing fires it on a timer or at `open`: an automatic reclaim deletes with nobody present, which is a different decision with a different risk profile, and ADR-0084 does not make it. **The caps are UNCHANGED**: this gives an operator an instrument, it does not raise a bound or make a refusal less likely.
