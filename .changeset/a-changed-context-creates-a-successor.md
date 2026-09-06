---
'@etherfold/core': minor
---

A changed context CREATES A SUCCESSOR instead of calling `processor.clear()`, on the runtime that receives its stream over the wire.

`StreamBuilder` DISCARDED a persisted cursor carrying a different source, config or processor version: `currentLastSync` called `processor.clear()`, and both public methods reach it, so a server or CLI whose processor was upgraded wiped the state it answers from and served progressively less until it had caught up. That is the outage, and it had a concrete call site.

**`ReceivingIndexer` / `openReceivingIndexer` (`receivingContainer.ts`) is the generation container above that receiver** — the chain-free SIBLING of `Indexer`, which cannot serve here because it builds `IndexerGeneration` engines whose `load()` opens with `eth_chainId`. For ONE named indexer it holds the durable registry, the caps that refuse, the canonical pointer reads resolve through, and the fold this host runs, built `createState` then `createProcessor(state)` (ADR-0043) and registered from the processor's own `getVersionHash()`.

```ts
const indexer = await openReceivingIndexer({
	port: generationRegistryPortOnSQL(db, 'alpha', {dropState}),
	caps: {maxGenerations: 4, maxStreams: 2}, // defaults to SERVER_GENERATION_CAPS
	source,
	stream: {finality: 12},
	appendEmissions: emissionAppenderFor(db, 'alpha'),
	generation: {createState, createProcessor},
});
indexer.ingestion; // the `LogIngestion` a host registers, wired to the container
```

**The MODEL is consumed unchanged.** Generation identity, stream identity, the caps and their refusal, "creating one already registered RESOLVES it" and "the first generation registered is canonical" are all `openGenerationRegistry`'s; `resolveGeneration` is a memo and a log line over it, not a second copy. The two factories are `GenerationSpec`'s, reached through a `Pick` so the build ORDER and the state-keying rule are inherited rather than restated.

**`StreamBuilderOptions.container` is what turns the discard into a creation**, and it is ADDITIVE: a `StreamBuilder` built WITHOUT one behaves exactly as it did, discard included, so the Worker host and every existing caller are untouched. With one, the fold is resolved-or-created as a generation before the cursor is read — so a CAP refuses before anything is folded — and a cursor written by another fold is left where it is instead of being cleared.

**The caps are the container's input, with a documented default.** `SERVER_GENERATION_CAPS` is `{maxGenerations: 4, maxStreams: 2}`: the incumbent, the successor being built beside it, the predecessor kept so a revert stays free, and one spare, over two streams because a generation re-folds a stream that is already stored while a STREAM is the expensive thing to re-fetch. A host states its own and gets the refusal at its own bound.

**The ONE-WRITER RULE is structural here too.** The emission appender is handed to the WRITER of the stream and to nothing else — `writerOf`, the oldest SURVIVING generation registered on it (ADR-0044) — so a successor over a shared stream stores nothing (`ReceivingIndexer.writesStream`, reported and never set). Without that it would append what the incumbent already stored, a second time, and the stream is the ONE history every generation re-folds, so a duplicate there is not an operational blemish (ADR-0052).

Three rules of the chain-facing container deliberately do NOT come over, and the JSDoc says why: it does not refuse a canonical generation it holds no engine for (on this runtime a generation's state is a table namespace and the read tier resolves the pointer to name it, ADR-0053, so the canonical generation answers with no engine at all — refusing would make every upgrade the outage again); it holds ONE live wire context (widening that is `one-registry-entry-holds-several-live-wire-contexts`); and it advances nothing but the fold it was given (catching up is the bounded-chunk rebuild).
