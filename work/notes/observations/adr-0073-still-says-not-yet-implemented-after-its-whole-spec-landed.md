---
title: 'ADR-0073 still says `accepted, not yet implemented` after every task of its spec landed'
slug: adr-0073-still-says-not-yet-implemented-after-its-whole-spec-landed
observed: 2026-09-08
source: 'noticed during the end-of-drive triage of a drive-tasks run that built all ten remaining tasks of `etherfold-is-a-fold-over-logs` and `the-fetcher-reads-the-hints-providers-already-send` (PRs #106-#119)'
---

`docs/adr/0073-the-engine-makes-one-data-call-and-eth-getlogs-is-it.md` still carries `status: accepted, not yet implemented`, but every task of `work/specs/tasked/etherfold-is-a-fold-over-logs.md` is now in `work/tasks/done/` and merged: the timestampless refusal, both flag deletions with the whole `enrichEvents` path, the `providerSupportsETHBatch` retirement, the declared method set with its guard, and the EDR/scope documentation.

The interesting part is HOW it survived, because no one was careless. At least two builders looked straight at the line and deferred it on the same reasoning: `providersupportsethbatch-is-deleted-and-adr-0002-is-corrected` recorded "two more tasks from this spec are still in `work/tasks/ready/` ... flipping the status now would overstate what shipped. Same call both predecessor tasks made; the last task in the chain is the place for it." Each task in a chain can see that it is not the last one, and the actual last task has no way to know it is: nothing in a task body says "you are the one that closes this spec". So a per-task agent correctly defers every time, and the flip never happens. The deferral is individually right and collectively wrong.

Two things worth deciding separately:

1. **The status line itself.** Someone who has read the merged diffs should flip it, or replace the status vocabulary with something a task can act on.
2. **The general shape.** Any ADR-status or spec-closing edit that "the last task will do" has this failure mode. It is a hand-off with no holder. Candidates for where it belongs: the spec's own destination check, a runner verb that fires when a spec's last task done-moves, or simply not asking tasks to maintain ADR status at all.

Not fixed here: a conductor can attest that the code landed, but deciding what `implemented` means for an ADR that also carries permanent machinery and a still-open sibling spec is a judgement for a human.
