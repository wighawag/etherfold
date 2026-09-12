---
title: "ADR-0082 and CONTEXT.md still say the hosted indexer is not built"
slug: adr-0082-still-says-not-yet-implemented
observed: 2026-09-12
---

Noticed while building `a-sharedworker-serves-several-tabs-from-one-host`, and NOT changed (the spec's tasking banner gives the `CONTEXT.md` entries to the last task, `createindexerstate-becomes-the-main-thread-host`, and the ADR's own status line is not assigned to anyone).

`docs/adr/0082-the-indexer-is-hosted-and-a-tab-holds-a-port-to-its-host.md` carries `status: accepted, not yet implemented`, and `CONTEXT.md`'s **indexer host** entry opens with `(browser: ADR-0082; NOT YET BUILT)`. Seven of the spec's tasks have landed by now, including the dedicated and shared hosting shapes, the store proxy, control, tx inclusion and restart-and-resume, so both lines are false for everything except the main-thread task still in `work/tasks/ready/`. Worth flipping when that one lands.
