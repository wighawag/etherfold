---
status: accepted, not yet implemented
---

# A `run` node may start with NO processor, and waits for one to be uploaded

The Graph's deploy UX starts from a node with nothing configured: deployments ARRIVE. ADR-0085's amendment of 2026-09-22 makes that the target, and code retention (ADR-0092) makes it reachable, because a generation's bundle is stored with it and can be instantiated at open. We decide that **`etherfold run` may be started with no processor and no source.** Such a node runs whatever its registry's canonical generation names; if it has never received a processor, it WAITS for one to be uploaded. This is not a default: ADR-0048 refuses a missing input because a defaulted one fails silently, and a waiting node fails loudly by saying it is waiting.

## What a node with nothing configured does

- **With a canonical generation in its registry**, it instantiates that generation from its stored bundle and folds, exactly as a restart does under ADR-0092. The contracts it indexes are the ones that bundle carries.
- **With none**, it serves, fetches nothing, and says so: reads answer "no generation yet", the same shape as a fresh deployment before its first fold, and `/status` reports that the node is waiting for a processor. The first upload becomes its first generation and takes `canonical` by the registry's existing rule.
- **Every upload carries its own contracts** (ADR-0085's amendment), so a node with nothing configured always learns WHAT to index from the same artifact that says HOW to fold it.

## Why `run` and nothing else

`run` holds both halves in one process, the fetcher and the fold, so a source that arrives inside an upload reaches the thing that fetches. In a SPLIT deployment the fetcher is a separate `fetch` process configured with its source, and an upload to `index` cannot change what it fetches. So a split deployment does not get the waiting mode. What it may get later is uploads whose contracts MATCH what its fetcher already fetches, with a mismatch refused by name, which is the same match rule an upload to any node with a known source follows.

## Considered options

**Default the processor to something.** Rejected for ADR-0048's own reason: a defaulted processor folds something nobody chose and looks healthy doing it.

**Require the processor at start and let uploads only REPLACE it.** Rejected as the whole answer: it keeps The Graph's second half and loses its first, where a node is stood up once and processors arrive by deploy. A node started WITH a processor still works exactly as today.

**Let a split deployment's `index` accept any upload and re-configure the fetcher.** Rejected: the fetcher is another process, possibly on another machine, holding no processor by ADR-0003. Reaching back into it is a control channel this project has deliberately not built.

## Consequences

**ADR-0048 gains one exception, stated as a MODE rather than a default.** `run`'s processor and source may be absent together. Everything else keeps today's behaviour: a processor with no source is already valid (its module supplies the contracts), and a SOURCE with no processor is still refused, because contracts with nothing to fold them are a configuration error rather than an intent to wait.

**The match rule applies to UPLOADS.** Where a node was started with a source the operator configured at start (`--deployments` or `INDEXING_SOURCE`) and an upload's contracts differ from it, the upload is refused by name. A node whose source came from its processor module, or that was started with nothing, takes an upload carrying different contracts as a successor on a new stream, as a re-read after a filter change already is.

_Corrected in place on 2026-09-26, under ADR-FORMAT's rule for text that never described code._ This paragraph first said an upload is refused where "a node has a known source". No code ever implemented that wording, and the maintainer decided on 2026-09-26 that a source changes legitimately (a new event a new handler needs, an upgraded contract with new events), so the only source an upload is held to is one the operator configured. "A known source" would also have covered a source a node learned from its own processor module, which would refuse the ordinary "add an event" deploy; it is corrected rather than preserved so the next reader does not build that refusal. The route that implements the rule is `POST /{indexer}/admin/upload` (`packages/cli/src/upload.ts`).

On the disk path, a configured source today still OVERRIDES a module's own contract data (flag, then `INDEXING_SOURCE`, then the module); whether that should also become a match check is not decided here.

**It depends on two unbuilt things**, so it is built after them: stored bytes and instantiation at open (ADR-0092), and the upload route itself (ADR-0085).
