---
title: "A fold's cursor is read against the CONTAINER's source, even for a fold added with its own"
slug: a-folds-cursor-is-read-against-the-containers-source
observed: 2026-09-14
---

2026-09-14 — Noticed while building `a-successor-that-was-never-canonical-is-superseded`. `ReceivingIndexer.cursorOf` (`packages/core/src/receivingContainer.ts`) calls `fold.processor.load(this.options.source, fold.streamConfig)`: the fold's OWN stream config, paired with the CONTAINER's source. A fold added through `add({source: ...})` — a filter change, which is the case a second live wire context exists for — folded under a different source, so the pair this reads with is one that fold never used. The visible consequence would be on the PROMOTION trigger, which compares `cursorOf` values: a filter-change successor whose cursor reads `undefined` is never ready, so `on-catch-up` would never promote it on its own.

Not investigated further and not fixed: out of scope for that task, which needed only that an un-started fold never reads as level (it does not, either way).
