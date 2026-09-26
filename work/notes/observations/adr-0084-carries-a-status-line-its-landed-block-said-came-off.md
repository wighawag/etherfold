---
title: 'ADR-0084 still carries `status: accepted`, which ADR-FORMAT does not list and its own LANDED block says came off'
slug: adr-0084-carries-a-status-line-its-landed-block-said-came-off
observed: 2026-09-26
---

2026-09-26, seen while amending ADR-0084 for `an-uploaded-processor-survives-a-restart`. `docs/adr/0084-a-generation-is-held-by-named-durable-slots-and-canonical-is-merely-the-first-one.md` has front matter `status: accepted`, which is not a value in `work/protocol/ADR-FORMAT.md`'s vocabulary (absent means accepted and current), while its 2026-09-19 LANDED block says "the front-matter status line comes off with it". Probably a leftover from replacing `accepted, not yet implemented`; left untouched here because it is outside that task's scope.
