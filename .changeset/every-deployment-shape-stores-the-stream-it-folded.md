---
'etherfold': minor
'@etherfold/core': minor
'@etherfold/server': minor
---

Every deployment shape stores the emission stream it folded, not only the one behind an HTTP route.

`appendEmissions` had exactly one call site, the HTTP ingest route, so `etherfold run` and `etherfold build` -- which fold through the direct in-process wire and touch no route -- produced databases whose `_emissions` table was EMPTY. That made the stored stream a fact about the TRANSPORT, exactly as the reorg counters were one task earlier (ADR-0050), and on worse ground: a `build` artifact is a publishable database later fed into another process, so without a stored stream a processor-logic change has to re-fetch the whole history from the node rather than re-fold what is already on disk, and both of ADR-0006's feed views were a split-shape-only surface.

**The append is a port on the FOLD, supplied by whoever owns the store** (ADR-0052). `StreamBuilder.receive` hands each batch's emissions to an `EmissionAppender` once, whichever entrance the batch arrived through, and the ingest route is a CALLER of `receive` rather than the owner of a write -- so a receiver that both concludes a batch and serves the request that carried it stores it once, and `run`, `build` and `index` all store what they fold.

**This write is NOT best-effort, and it is ordered BEFORE the fold.** A reorg count that cannot be persisted is a logged miscount; a stream that cannot be persisted is a HOLE -- a state that advanced past events the stream never received, which is silent, permanent, self-consistent and invisible to the gap check. So a store that cannot take the batch refuses the batch: nothing is processed, the cursor does not move, and the next cycle re-derives the same delta.

- **`@etherfold/core`** gains `EmissionAppender` and `EmissionWrite`, plus `StreamBuilderOptions.appendEmissions`. Like `recordReorg` it is not hashed into the wire identity, and it is optional: a host that supplies none stores no stream, and folds identically. `IngestionOutcome.emissions` is unchanged and is still REPORTED, but a caller that stored it would now be storing a second copy.
- **`@etherfold/server`** exports `emissionAppenderFor(db, indexer)`, which binds the append to a database and a named indexer. Its ingest route performs no durable write at all now: everything a batch costs happens inside `receive`, and the route decides who may call it and which status code each refusal is. A store failure is a `500` with `lastError` set, and the sender's own recovery is unaffected -- nothing was applied, so its next attempt meets the cursor it already had.
- **`etherfold`** builds the appender in `buildProcessor`, beside the reorg recorder and against the same handle, so no folding command can store into a database it does not fold into. **`--indexer` becomes OPTIONAL on `run` and `build`, defaulting to `default`**, and stays REQUIRED and never defaulted on `fetch` and `index`. The never-defaulted rule protects the WIRE (a name a host was not built with must be a routing error, ADR-0036), and a combined process routes nothing: it needs a name only to KEY the stream it stores, which is `NOT NULL` on every emission row. `serve` still refuses the flag.

**One behaviour change worth reading before upgrading:** `--no-auto-setup` against a database nobody has migrated now STOPS a fold rather than degrading it, because the fixed tables carry `_emissions` and a fold that cannot store what it folded must not advance past it. The cycle is retried and the deployment catches up when the schema arrives.

`packages/cli/test/equivalence.test.ts` compares the stored streams of `run` and `fetch` plus `index` row for row and column for column, asserts the `build` artifact carries the same seven rows under the default name, drives a refused append and asserts it leaves no hole, and serves both feed views over a database a combined process folded. `packages/server/test/oneEmissionAppendSite.test.ts` scans the workspace and asserts there is no second site appending to that table.
