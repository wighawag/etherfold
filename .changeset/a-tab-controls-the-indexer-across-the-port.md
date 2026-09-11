---
'@etherfold/browser': minor
---

A tab STARTS, STOPS and RECONFIGURES the indexer its host is running, and sees which generation answers reads.

The port carried progress and the store's four reads; the lifecycle stayed in the host, so an app whose UI lives in a tab could not offer a settings screen, a backgrounded-tab pause, or a source change at all. Five cases now ride the same envelope -- `startIndexing`, `stopIndexing`, `reconfigure`, `generations`, `promotion` -- and `IndexerPort` grows the matching verbs.

```ts
await indexer.stopIndexing(); // answers when the cycle in flight has LANDED
const {generation, added} = await indexer.reconfigure({source: nextSource});
const held = await indexer.generations(); // who exists, how far each got, which one answers reads
```

**A stop is honest.** It resolves once the cycle in flight has landed, so no chain request is made after a caller has been answered and the cursor is where a completed cycle would have left it -- a stopped indexer resumes without re-indexing and without skipping. A cut-off cycle is not on offer: the cursor is written in the same transaction as the block it describes (ADR-0027), so the consistent thing to do with an advance already under way is to let it finish. Starting a started host, or stopping a stopped one, is an ANSWER rather than a refusal: these name a STATE a caller wants, not an edge, so two components each asking once leave the host in the state they both asked for. The container is opened once and stays open across a stop, so a host that is not indexing still answers reads.

**A reconfigure carries the SOURCE, and the generation machinery does the rest.** `Indexer.add` builds the new generation BESIDE the live one, which goes on answering every read until the promotion policy moves the canonical pointer -- nothing is discarded, and a source that hashes to a generation already held resolves to it rather than rebuilding (`HostReconfigure.added` says which happened). The source is the only half of a generation that is data: a fold is code, so changing it is a new worker bundle rather than a message (ADR-0082), and the stream config is not settable per generation. `PromotionConfig` is still passed through un-defaulted at every boundary, and `promotion()` reports what the container resolved.

**A refusal keeps its type AND its fields.** `PortError` gains `details`, carrying the refusal's own enumerable fields, and `errorFromPort` puts them back where the class declared them: a `GenerationCapReachedError` that crosses a port still says which cap, at what limit, and which generations could be deleted to make room, so an app branches on the refusal instead of parsing its sentence. A field that cannot be cloned is dropped rather than taking the whole refusal down with it.

**One fix to an existing contract:** a request payload that cannot cross now REJECTS the caller's promise instead of throwing past it. `assertClonable` ran before the promise was constructed, so `await port.call(x).catch(...)` did not catch the one input it refuses -- and the reads that shipped first carry only strings and numbers, so nothing had reached it.
