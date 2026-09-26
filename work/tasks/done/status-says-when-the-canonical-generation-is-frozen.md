---
title: '`/status` SAYS when the canonical generation is frozen, and where it stands'
slug: status-says-when-the-canonical-generation-is-frozen
blockedBy: []
covers: []
---

## What to build

A Node deployment can now serve a canonical generation that nothing in the process folds: its stored code could not be built at `open`, a revert crossed a filter change, or the host injects no `instantiateGeneration`. The admin listing (`GET /{indexer}/admin/canonical-generation`) reports that since `a-generation-says-whether-it-can-run-here`, as `folding: frozen` with a reason. The PUBLIC `/status` does not. It builds its entries from the folds this process HOLDS (`foldingStatusReport` over `container.held()`) and takes its top-level `value` from the held canonical fold. So when the canonical generation is not held, `/status` has no `value`, no canonical entry, and no word about why. An operator watching the page cannot tell "frozen" from "stalled" from "quiet chain".

After this task, `/status` always says which generation answers reads, where it stands, and whether it is folding here, whether or not this process holds a fold for it.

**The shape, decided by the conductor with the maintainer's go-ahead (2026-09-26), and yours to refine only where the code argues otherwise:**

- ADR-0047's per-generation list keeps its meaning (what this host HOLDS). Do not turn it into one entry per REGISTERED generation: that redefines the field and costs a cursor read per registered generation on every `/status`.
- What is added is about the CANONICAL generation alone: when it is not held, the report still names it and still gives its position, read from its own namespace with no engine (the registry's `readStateCursor` seam already does exactly this for the promotion trigger; reading its full stored cursor through the host's namespace convention is fine if that gives the four numbers the held case reports). Beside it, the same `folding` vocabulary the admin listing uses (`held` / `instantiable` / `frozen` plus the reason), so there is ONE vocabulary for one fact on two surfaces.
- Additive: a reader of today's `/status` must see nothing removed or renamed.

**Also in scope, one comment.** The module JSDoc at the top of the server's admin API, section "The MOVE is one small write", still says a target this host holds no fold for "is answered anyway ... with no engine at all". Since ADR-0092 a same-stream target on a Node deployment is instantiated from its stored bundle and folds, a target whose stored code cannot be built is refused (`409 generation-cannot-fold`), and a cross-stream target still moves and is frozen. Correct the comment to say that.

**Discharge.** The observation `status-says-nothing-about-a-frozen-canonical-generation` records both gaps. When this lands its signal is carried by the tests and ADR-0047's amendment, so DELETE the note (work contract: an observation leaves by deletion). Nothing cites it by path today; if something does by the time you build, re-point it at the test or ADR rather than keeping the note.

## Acceptance criteria

- [ ] With the canonical generation frozen at `open` (stored code that does not build), `/status` names it, gives its position, and says `frozen` with the reason. Asserted end to end on the CLI, in the style of the existing restart suites.
- [ ] Same for a canonical generation frozen by a revert across a filter change.
- [ ] During an upgrading restart the canonical generation is held, and `/status` reports it exactly as it does today (no regression).
- [ ] The held-folds list keeps ADR-0047's meaning; nothing already on `/status` is removed or renamed.
- [ ] The `folding` vocabulary is shared with the admin listing, not re-declared.
- [ ] ADR-0047 carries a dated amendment (`## Amendment, 2026-MM-DD (ADR-0092): ...` plus a pointer under the title) describing the canonical report when nothing here folds it.
- [ ] The admin API's header JSDoc no longer claims a no-fold target is always answered with no engine.
- [ ] The observation `status-says-nothing-about-a-frozen-canonical-generation` is deleted.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

None -- can start immediately.

## Prompt

The goal is that the page an operator already watches never shows a frozen deployment as silence.

Read ADR-0047 (what `/status` reports and why it reports a host's held folds), ADR-0092 (retained code, and its paragraph on how a generation says whether it can fold here), ADR-0057 and its 2026-09-25 amendment (what a revert now does), and ADR-0084's 2026-09-19 amendment (the `readStateCursor` seam that reads a generation's position with no engine).

The seams: the CLI's `foldingStatusReport` and `readStatusReport` (what `/status` is built from), the receiving container's `canonical()` / `held()` and the per-generation folding answer the admin listing already uses, and the server's status reporter types. The CLI suites `anUpgradingRestartKeepsTheIncumbentFolding`, `aRevertResumesFolding` and `aGenerationSaysWhetherItCanRunHere` stand up exactly the frozen shapes you need; reuse their fixtures rather than inventing new ones.

The decision most likely to be got wrong is widening the held-folds list to every registered generation because it is the shortest diff. The second is inventing a second vocabulary for "frozen" beside the admin listing's.

Done means: a frozen canonical generation is visible on `/status` with its position and reason, nothing existing changed shape, the admin JSDoc is true, and the observation is gone.

FIRST, check this task against current reality. If `/status` has since changed shape, or the folding vocabulary moved, route to needs-attention with the discrepancy rather than building on this text.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in particular how the canonical position is read when nothing folds it. Do not write the done record, the commit message or the PR body yourself.

## Decisions

- **How the canonical position is read when nothing folds it.** Each assembly now exposes `stateOf(id)`: the generation's own storage (its table namespace, ADR-0053), built the same way as everything else but without taking the write claim, so a read never takes the claim away from a fold that is writing. `/status` reads the full stored cursor from it, giving the same four numbers the held case reports. The alternative was `registry.readStateCursor`, which returns only `lastToBlock`, so the held and frozen cases would have reported different shapes. The read happens only when no held fold is the canonical one: at most one extra cursor read per `/status`. This touches the public type of `FoldingAssembly` and `IndexingPrepared`, and `foldingStatusReport` now requires `stateOf` as its second argument, which is a breaking change to that export. It is covered by the changeset, per CONTEXT.md's blank-sheet rule.
- **The top-level `value` is filled from the canonical generation even when it isn't held.** Its documented meaning (ADR-0047, and the `StatusReport` JSDoc) is "where the generation answering reads has got to", and the old `reported: false` reason, "named no cursor for the generation that answers reads", was not true for a frozen generation that has a cursor. The visible effect: a frozen deployment's `/status` now says `reported: true` with a value that doesn't move, and "is it advancing" is read from `canonical.folding`. The alternative was to leave `value` taken only from held folds and put the position only in `canonical.value`. That would change nothing existing, but it would keep a false reason and a `value` that misses its own definition. Dashboards that check `reported` are affected, and the ADR-0047 amendment records this.
- **The `canonical` report is included whenever a canonical generation exists, held or not.** This keeps `/status` the same shape whatever the process holds, like `generations`. The alternative was to include it only when frozen or unheld, which makes the page's shape depend on state. It adds one key to the held-case response; no existing key changes.
- **A new single-generation method on the core container, `ReceivingIndexer.foldingOf(generation)`.** The alternative was to call `container.folding()` and pick out the canonical entry, which reads the stored code of every registered generation that isn't held on every `/status`. That is the per-registered-generation cost the task rules out. It is the same private derivation made public, so it doesn't add a concept.
- **A failed `folding` lookup doesn't take down the envelope.** If `foldingOf` throws, the report leaves out `folding` and logs the error. The alternative was to let it throw, which would turn the whole cursor envelope into `reported: false`. This follows the existing rule in `readStatusReport` that one unreadable store must not cost the other entries.
- **Naming: `cursor.canonical` (an object) sits beside each entry's `canonical: boolean`.** This matches the admin listing, which already has a top-level `canonical` object alongside a `canonical` flag on each entry. I didn't introduce a new word.
