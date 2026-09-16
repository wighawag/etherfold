---
title: 'A reloaded chain-facing container makes its canonical generation a FOLLOWER, so nothing fetches'
slug: a-reloaded-container-makes-its-canonical-generation-a-follower
observed: 2026-09-16
---

2026-09-16, noticed while porting slots to the chain-facing container (`the-chain-facing-container-holds-its-generations-in-slots`). Recorded rather than fixed: it is `follows`, not slots, and ADR-0071 decided the rule deliberately.

`Indexer.add` decides `follows` from the DURABLE registry as "is any OTHER generation already registered on this stream" (`packages/core/src/container.ts`, `alreadyOnThisStream`). Within one session that is right and is exactly ADR-0071's argument. Across a RESTART it is not: a container re-opened over a durable registry that already holds a canonical generation A and a pending successor B, both on one stream, re-adds A while B is still registered — so `alreadyOnThisStream` is non-empty and A is built as a FOLLOWER with a `readOnlyStream` and `followMore()`. Every generation the reloaded container holds then follows a stream nothing writes, so the tab stops fetching while `/status`-shaped reporting and the state itself look fine. `writerOf` would name A correctly here; ADR-0071 explicitly rejected that form (it produced two writers under a same-millisecond tie) and named the unification as open work needing `writerOf` stable in registration order — which ADR-0072 has since delivered — plus reconciliation in this container, which `readOnlyStream` being baked into the engine config at construction still prevents.

Worth noting the reachability changed underneath it. Before slots this path was mostly unreachable at `BROWSER_GENERATION_CAPS`: a reload with a changed processor registered a third generation and the cap REFUSED, so the container did not open at all. With slots the reload replaces what `successor` holds, so the container now opens — and lands in this case instead. A loud refusal became a silent stall, which is the direction that matters.

Not to be confused with `a-deliberate-freeze-is-not-visible-on-a-filter-change`, which is one generation deliberately unfed on a stream another generation is being fed on. Here NOTHING is fed, and nobody chose it.
