---
title: 'A generation SAYS whether it can run here, so an operator can tell before reverting'
slug: a-generation-says-whether-it-can-run-here
spec: a-generation-retains-the-code-that-folds-it
blockedBy: [an-upgrading-restart-keeps-the-incumbent-folding]
covers: [2, 8]
---

## What to build

ADR-0092, the visibility half, and the LAST task in its chain. An operator about to revert should be able to see whether the generation they are reverting to can actually run on this deployment, and a generation that cannot run should be a REPORTED state rather than a silent stall.

**Where it is reported.** `GET /{indexer}/admin/canonical-generation` already reports every slot, what it names, and everything no slot names (ADR-0084's 2026-09-16 amendment). Widen that report so each generation says whether it can fold here: this process HOLDS a fold for it, or it can be INSTANTIATED from stored bytes, or NEITHER. The exact vocabulary is yours; record it in `## Decisions`.

**Story 8 is conditional, and you must find out which way it goes.** The spec asks for "this generation is frozen because its code is gone" to be expressible and reported **if it can occur at all**. After the two previous tasks, determine whether it can: for example, can a Node generation be registered with no stored bytes (the processor arrival still has a MODULE route beside the bundle route), or can stored bytes fail to instantiate? If it can occur, report it wherever a stalled deployment would otherwise be silent. If it cannot, assert the refusal that makes it impossible and say so. Either answer is acceptable; an unexamined one is not.

## Acceptance criteria

- [ ] The admin slot report states, per generation, whether it can fold on this deployment, asserted for a held generation, one instantiable from stored bytes, and (if reachable) one that is neither.
- [ ] Story 8 is RESOLVED one way or the other: either the frozen-because-code-is-gone state is reported where it would otherwise be silent, or a test proves it unreachable and the report says why.
- [ ] The report is unchanged in shape for anything it already reported; this widens it.
- [ ] **ADR-0092's `status: accepted, not yet implemented` line is REMOVED**, leaving NO status line, because `work/protocol/ADR-FORMAT.md` says an absent status means accepted and current. Do not invent a value: `accepted, implemented` is not one of its seven and a previous build in this repo had to have it reverted. **This task is the last in ADR-0092's chain and therefore owns the removal.**
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

- `an-upgrading-restart-keeps-the-incumbent-folding` -- it reports states the earlier tasks create, and it touches the same container.

## Prompt

The goal is that an operator never has to choose between two generations they cannot tell apart.

Read ADR-0092, then ADR-0084's 2026-09-16 amendment (the admin route that reports every slot) and ADR-0057 (the revert is an authenticated admin route). The earlier three tasks in this chain built the storage, the resume on revert and the resume at open; read their done records for the vocabulary they settled on.

The decision most likely to be got wrong is leaving story 8 unexamined because it says "if". The second is forgetting the status line, which in this repo has survived its chain twice precisely because every task could see it was not the last.

Done means: the report says whether each generation can run here, story 8 is settled with evidence, and ADR-0092 stops saying it is unimplemented.

FIRST, check this task against current reality: all three earlier tasks will have landed. If they landed differently than this assumes, route to needs-attention with the discrepancy.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in particular how story 8 resolved. Do not write the done record, the commit message or the PR body yourself.

## Decisions

- **How story 8 resolved: it is reachable, so it is reported.** The evidence is in the CLI end-to-end tests:
  - Stored bytes that no longer build a processor: the restart starts, serves the canonical generation frozen, and the listing says `frozen / instantiation-failed` with the loader's reason. Before this only a log line said so, because the previous task chose not to refuse to start.
  - `bundle = NULL` on the row: reported as `frozen / no-bundle` ("its code is gone").

  The literal "no bytes" case cannot be produced by etherfold's own registration, because `add` refuses a missing bundle. But the SQL column is nullable, so the state can exist in the database, and the report names it rather than asserting it away.
- **Vocabulary.** The field is `folding: 'held' | 'instantiable' | 'frozen'`, with `frozen: {reason, message}` only when frozen. "held" matches `HeldFold`/`held()`, "instantiable" matches `instantiateGeneration`, and "frozen" matches how the revert docs and `CONTEXT.md` already describe a cross-stream revert. "Frozen" also names an unrelated `StreamWriteOutcome` value on the browser-side container; I accepted that overlap because the generation sense is already established in the docs.
- **`instantiable` is decided without running the code.** It means: bytes are stored, the host can instantiate, nothing in this process has failed to, and the generation's stream is the container's own. Proving it would mean evaluating the bundle and opening its state for every generation on each request, which is the eager instantiation ADR-0092 rejects. The alternative was a probe that actually loads the bytes. The cost of not probing: a host whose seam supplies its own source is judged against the container's source until an attempt is made (the CLI supplies none).
- **Failed attempts are remembered in memory, per process,** alongside the existing `instantiatedHere` set. A later successful attempt clears the entry. Another process with a different loader may answer differently, which is why nothing about it is stored durably.
- **Reason order:** `no-bundle` first (nothing anywhere can fix it), then `no-instantiator`, then a remembered failure, then `stream-not-fetched`.
- **Reported on the admin listing only, not `/status`.** The task names the admin route, and `/status` is a separate public surface (ADR-0047). That gap is left in the observation note.
- **`folding()` is optional and independent of `slots`/`reclaim`,** because it is a fact about the answering process rather than about the registry.
- **ADR-0092 got one new paragraph** describing the report and the story-8 resolution, rather than a dated amendment. It adds a decision and does not correct any earlier text. The status line is removed with no replacement, as ADR-FORMAT requires.
