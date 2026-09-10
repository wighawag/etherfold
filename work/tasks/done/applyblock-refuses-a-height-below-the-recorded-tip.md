---
title: 'applyBlock refuses a height that is not above the recorded tip'
slug: applyblock-refuses-a-height-below-the-recorded-tip
spec: a-second-writer-writes-nothing
blockedBy: [every-mutating-path-carries-a-writer-token]
covers: []
---

## A previous attempt produced an EMPTY DIFF — read this before deciding there is nothing to do

A previous run of this task ended with no source change at all and no recorded reason, so the runner treated it as a stop. **That judgement was checked and is wrong.** The tightening is genuinely NOT implemented on `main`:

`applyBlock` in `packages/state-store-indexeddb/src/store.ts` still refuses only a DUPLICATE height. Inside its transaction it does exactly three checks, in order: `claimOrCheck` (the writer token, added by `every-mutating-path-carries-a-writer-token`), then `blocks.get(block.number)` refusing a height already recorded, then the hash-index lookup refusing a duplicate hash. **There is no comparison against the recorded TIP anywhere in it.** So a writer holding a stale cursor can still apply at a height the tip has passed, as long as that exact height is not already recorded, which is the hole this task exists to close.

Do not re-derive "already done" from the presence of the writer-token guard. That guard answers WHO is writing. This task answers WHETHER THE HEIGHT IS ABOVE THE TIP. They are different questions and the second one is unanswered.

### If you genuinely need to STOP, stop LOUDLY, not with an empty diff

This task's prompt asks you to confirm its premise yourself and says that finding a caller which legitimately applies at or below the tip is a STOP. That instruction stands. But an empty diff is NOT how to report it: it loses your reasoning entirely, which is what happened last time and cost a full run.

If you conclude this task should not proceed, WRITE THAT CONCLUSION DOWN as a `work/notes/observations/` note naming the exact call site, the file and line, and why it legitimately applies at or below the tip. That note IS your deliverable and it is a non-empty diff. A stop that leaves a record is useful; a stop that leaves nothing is indistinguishable from a failure.

## What to build

`applyBlock` refuses a DUPLICATE height today, which is narrower than the invariant a single writer maintains: every applied block is ABOVE the recorded tip. Tighten it, so a writer holding a stale cursor is refused rather than accepted at a height the tip has passed.

This is a TIGHTENING and not a behaviour change, established by reading rather than by choosing. `applyEventStream` (`@etherfold/processor-entities`) is the one production caller: it takes the stream's fork point, calls `revertTo(fork)` FIRST, and only then applies the grouped blocks in stream order. Its docstring states the property it relies on: "Revert precedes apply, which is also what makes replay safe. A store records a block plainly and a re-applied block raises on purpose ... the canonical events in the same stream are all at or above `fork + 1`". So after the revert the tip is at or below the fork and every apply is strictly above it.

`covers: []` deliberately: this traces to the spec's Problem Statement (unguarded path 2) rather than to a user story. It is separated from the guard task so it can be reverted alone if a path is ever found that legitimately applies below the tip.

## Acceptance criteria

- [ ] `applyBlock` refuses a height that is not strictly above the recorded tip.
- [ ] An EMPTY store admits any height: there is no tip to be above.
- [ ] The tip is read inside the same transaction as the write, so a revert lowering it and an apply above it cannot interleave with another writer.
- [ ] The refusal names both heights **where the backend can compose that message inside its writing transaction**. On memory, patch and IndexedDB a read-then-write transaction exists, so it can. On SQLite the existing duplicate-height refusal comes from a PRIMARY KEY and a UNIQUE constraint rather than from a message this code writes, and `remote-sql` has no read inside a transaction, so there the verdict is a conditional write plus a read-back and the message is assembled after the batch. Do not force a uniform message that the substrate cannot produce.
- [ ] The existing duplicate-height and duplicate-hash refusals still hold.
- [ ] Every existing suite stays green, including the replay path, the rebuild path and bootstrap from a snapshot, all of which install into a store with no tip.
- [ ] Conformance carries the case on every backend.
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

`every-mutating-path-carries-a-writer-token`. Both checks read state inside the same writing transaction, and doing them in one place is cheaper than doing them twice.

## Prompt

Read `work/specs/tasked/a-second-writer-writes-nothing.md`, then `packages/processor-entities/src/apply.ts` IN FULL: `applyEventStream` is the one production caller and its docstring is the evidence that this tightening is safe. Then `applyBlock` in `packages/state-store-indexeddb/src/store.ts` and `packages/state-store-sqlite/src/store.ts`, and `packages/state-store-sqlite/src/ddl.ts` to see that the SQLite duplicate refusal is a schema constraint rather than an authored message.

Before you build, CONFIRM the premise yourself rather than trusting this task: check the replay path, the rebuild-chunk path and `bootstrapFromSnapshot` for any call that applies a block at or below an existing tip. The reading says none does. If you find one, that is a STOP: report it rather than weakening the check to accommodate it.

Domain vocabulary: a **fetch is not a replay** (ADR-0042). A fetch is raw logs carrying no verdicts, so retractions are derived by comparing the cursor's window against incoming blocks; a replay is a stored emission stream that already records what was applied and what was taken back, so the engine honours those verdicts. Both route through `applyEventStream`, and both revert before they apply.

Done means a stale writer cannot land a block at a height the tip has passed, an empty store still accepts its first block, and nothing on the replay or bootstrap paths regressed.

## Decisions

- **The refusal is a plain `Error` carrying a shared message, not a new error type.** It means the same thing as the duplicate-height refusal beside it (the CALLER is wrong: revert first, or stop writing), and `StoreWriterChangedError` stays the only typed one on this path because it means the opposite (a lost race whose correct response is demoting to a reader) — spec user story 3 rests on that distinction, and a second type would blur it. Alternative considered: a `BlockNotAboveTipError`, rejected because nothing branches on it. It touches `a-refused-writer-demotes-itself-to-a-reader` (backlog), which must keep telling the two apart by TYPE — it still can.
- **The message lives at the seam (`blockNotAboveTip`) rather than being authored per backend.** The acceptance criterion allows backends to differ, and SQLite turned out to be able to name both heights (the tip read rides its batch), so all four say the same thing from one place. The existing duplicate-height message is copied in three backends and is exactly the drift this avoids. It touches any future backend: it inherits the message by calling the helper.
- **`applyBlocks` (SQLite-only, no production caller) now requires its blocks to ASCEND, refused locally before any I/O.** Each block is judged against the tip its predecessors left, so a descending pair would silently apply to nothing. This is a NEW REFUSAL on a public method of that backend: it mirrors the engine's existing `assertAscendingByBlock` rather than inventing a rule, and the alternative (silently dropping, or one read-back per block) was worse in both directions. It touches `the-seam-splits-into-a-readable-and-a-writable-store` and `the-seam-narrows-and-a-reader-cannot-write` (backlog), which keep `applyBlocks` on the SQL tier's own class.
- **`applyBlocks` sends its LOWEST block in a batch of its own, carrying the tip read.** That makes the refusal whole (nothing applied) rather than "the rest of the first batch landed", at the cost of one extra round trip per CALL, not per block. Alternative considered: reading the tip in the first packed batch (cheaper, but a refusal would leave the higher blocks of that batch applied) and one read-back per batch (needs a batch→block mapping `planBatches` deliberately does not carry). It touches `platforms/cf-worker`'s D1 limits test, which now asserts two batches with the same packing bound.
- **`packages/state-store-indexeddb/test/persistence.test.ts` ("interleaves writes from both") was rewritten to interleave in ASCENDING order**, and the multi-tab browser harness now counts a tip refusal as an outcome beside `StoreWriterChangedError`. Those tests encoded "each tab owns its own heights", which the source spec explicitly says was never evidence that two indexers can share a database; a store's blocks are one sequence. No coverage was dropped: the property they exist for (neither handle caches state the other contradicts; four tabs can OPEN one database) is asserted unchanged.
- **`.wrangler/` added to `.gitignore`.** Running the cf-worker tests writes `platforms/cf-worker/.wrangler/tmp`, which is untracked, unignored, and would otherwise be swept into the commit by `git add -A`.
