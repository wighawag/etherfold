<!-- dorfl-sidecar: item=task:a-folds-cursor-is-read-with-the-source-it-folded type=task slug=a-folds-cursor-is-read-with-the-source-it-folded allAnswered=true -->

## Q1

**'task:a-folds-cursor-is-read-with-the-source-it-folded' was bounced — how should we proceed?**

> The task's load-bearing premise is false against current code, and I measured it rather than argued it.
>
> FALSE PREMISE 1 (the whole justification, "What to build" para 1-2). The task states that for a filter/source change "the load answers nothing ... `cursorOf` returns `undefined`, and the fold reads as 'has not loaded' for ever", so "`on-catch-up` never promotes it" and the second reconfigure shape "registers a generation that catches up invisibly and never takes over". It does take over. `EventProcessor.load(source, streamConfig)` has exactly two implementations in this repo — `EntityEventProcessor.load` (packages/processor-entities/src/EntityEventProcessor.ts:237) and `VersionedStateEventProcessor.load` (packages/processor-sqlite/src/VersionedStateEventProcessor.ts:228, which delegates to it) — and neither uses `source` to decide which cursor it answers. `EntityEventProcessor.load` assigns `this.source = source` to a field declared at :123 and never read anywhere in that file, then reads the cursor out of its own per-generation store (`store.readCursor(SYNC_CURSOR_KEY)`), which is namespaced per generation (ADR-0053) and source-independent. So `cursorOf` (packages/core/src/receivingContainer.ts:1317-1323) returns the fold's real `lastToBlock` even when handed a source that fold never folded under.
>
> MEASURED, at the seam the task names (container, real registry, real state), both directions:
> (a) incumbent `v1` folded through block 110 and canonical; `add({source: OTHER_SOURCE, ...})` (different contract address, so a different stream digest, `follows === false`, its own receiver); fed on its own wire to 110; `rebuildMore()` to settle the pointer. The pointer MOVES to the successor, against unmodified main. `on-catch-up` already promotes a filter-change successor end to end.
> (b) the same scenario with a deliberately source-honouring processor double (one that answers `undefined` from `load` for a source it never folded under, i.e. the behaviour the observation assumed) does NOT promote: canonical stays `v1`.
> So the mismatch in `cursorOf` is LATENT, not live: it bites only a processor that honours the `source` argument, and none exists.
>
> FALSE PREMISE 2 (acceptance criteria 1 and 2). Criterion 1 ("reports a cursor that reflects its real progress, rather than reading as never-loaded") is already true. Criterion 2 ("A successor on a changed source is seen to CATCH UP, so `on-catch-up` promotes it. Asserted end to end through the promotion trigger, since that is the behaviour the bug removes") cannot be satisfied as a red-then-green test: measurement (a) is green before any change, and the clause "the behaviour the bug removes" is not true. Building this as written would land a changeset and a done record asserting that auto-promotion was silently broken for the filter-change reconfigure shape and is now repaired, which is false and would mislead whoever reads the release notes or the done record later.
>
> NOT A PREMISE PROBLEM (so the task's other FIRST is settled, in the task's favour): the fold's own source DOES survive. `add` resolves it at packages/core/src/receivingContainer.ts:1035 and remembers it at :1138-1142 as `FoldOrigin.source` in the `origins` WeakMap — not as a field on `HeldFold`, which carries `streamConfig` but no source. Every fold goes through `add`, the opening one included (`open()` at :680), so it is populated for all of them, and it survives `handOverTheWire` because that mutates the fold object in place. The "if it does NOT survive, that is the actual bug" branch does not apply.
>
> SUGGESTED RE-SCOPE (for a human to decide, because the framing is the decision and it is user-visible in the release notes):
> 1. Re-frame as LATENT-DEFECT HARDENING, not a bug fix: "`cursorOf` reads a fold's cursor with the pair that fold folded under", justified by the seam contract (`load` takes a source, so it may honour one) rather than by a promotion failure. Drop acceptance criteria 1 and 2 as written; replace with (i) `cursorOf` passes the fold's own source, asserted through the promotion trigger with a SOURCE-HONOURING processor double, which is the only double that can go red first, and (ii) the processor-change path and the differing-recorded-processor guard unchanged. Note in the task that the fix is a no-op for every processor that exists today, so the changeset says so honestly.
> 2. Decide where the fold's source is read from: `this.origins.get(fold)?.source` reuses a structure whose stated purpose is "what a fold needs REMEMBERED so its ENGINE half can be rebuilt later" (writer succession), so using it for a read widens that concept; the alternative is adding a `source` field to the public `HeldFold`, which is a published-type change (cheap here per CONTEXT.md, but a decision). That choice belongs in the task, not buried at the call site.
> 3. Separately worth a human's eye, and deliberately NOT folded into the above: `cursorOf` is a READ that calls `load`, and the shipped `load` MUTATES its processor (`this.source = source`, `this.finality = streamConfig.finality`, `ensureMigrated()`). Today `this.source` is write-only so this is inert, but a read that writes the container's source onto a fold that folded another is the shape the whole confusion came from.
> 4. Correct or supersede work/notes/observations/a-folds-cursor-is-read-against-the-containers-source.md, whose "would be" was read as "is". I did not edit it: an observation is an append-only capture and amending someone's signal is not mine to do unasked.
>
> No source change was made and the working tree is clean (both measurement test files deleted after running).

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):

ANSWERED 2026-09-17 (decided by the repo owner in session; recorded by the conductor).

CANCELLED, and its content folded into `promotion-arms-from-the-slot-so-a-restart-can-finish-an-upgrade`.

The stop was right: neither implementation of `EventProcessor.load` uses `source` to decide which cursor it answers (`this.source` is assigned and never read, and the field's own comment says so), so the cursor is read correctly today and `on-catch-up` already promotes a filter-change successor. The defect is a CONTRACT violation that is inert as a BEHAVIOUR, which is why this task's end-to-end criterion could not go red first.

Rather than re-scope it into a standalone "harden a latent defect" task carrying an awkward changeset that admits it fixes nothing observable today, the one-line correction moves to the arming task, which already rewrites how `cursorOf` reads. Same function, one touch, and there it is a clause of a change that DOES have observable behaviour.

The measurement survives as `work/notes/observations/the-source-argument-to-load-is-inert-so-the-cursor-defect-is-latent.md`, and the original observation stays.

