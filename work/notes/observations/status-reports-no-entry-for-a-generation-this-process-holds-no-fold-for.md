---
title: '`/status` reports no entry for a generation this process holds no fold for, so a restarted upgrade shows the successor and not the target it must reach'
slug: status-reports-no-entry-for-a-generation-this-process-holds-no-fold-for
observed: 2026-09-19
---

2026-09-19 — Noticed while driving `promotion-arms-from-the-slot-so-a-restart-can-finish-an-upgrade`; NOT fixed, and out of that task's scope.

`foldingStatusReport` (`packages/cli/src/folding.ts`) builds its `folds` from `container.held()`, so `/status` reports one `cursor.generations` entry per fold this PROCESS holds. On a deployment restarted with a changed processor that is exactly one entry, the successor's: the incumbent is registered and still canonical and still answering reads, and its position is a row in its own namespace, but nothing on the page mentions it. So an operator watching an upgrade across a restart sees a number climbing towards a target the page does not show, and cannot tell "nearly there" from "stalled".

The number is now readable with no engine (`GenerationRegistryPort.readStateCursor`, added by that task), so reporting an entry per REGISTERED generation rather than per held fold is available in a way it was not before. Whether `/status` should is a decision nobody has made: it changes what the `generations` field means (ADR-0047 defines it as what a host holds) and it costs one cursor read per registered generation on every `/status`.
