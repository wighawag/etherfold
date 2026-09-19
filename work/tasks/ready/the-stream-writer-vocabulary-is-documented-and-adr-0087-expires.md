---
title: 'The glossary says a stream is written by whoever fetches it, and ADR-0087 stops saying it is unimplemented'
slug: the-stream-writer-vocabulary-is-documented-and-adr-0087-expires
blockedBy:
  - run-and-build-drive-the-folds-they-hold-rather-than-one-captured-receiver
  - a-restarted-generation-re-folds-its-stream-instead-of-re-fetching-the-chain
  - whoever-fetches-a-stream-writes-it-and-the-stream-outlives-every-fold
  - a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge
covers: []
---

## What to build

The last task of this family: the coherence pass over the vocabulary, and the ADR line that expires when the code lands.

**`CONTEXT.md` states the retired rule in several places, and they must agree with each other as well as with the code.** The glossary currently says, in more than one entry and in more than one form, that which generation writes a stream is the OLDEST SURVIVING generation registered on it, that deleting the writer hands the duty to the next oldest, and that a replaced successor's stream goes with it where no registered generation is left folding it. Under ADR-0087 the first is no longer how a writer is chosen, the second describes a succession that no longer exists, and the third is the automatic reap that was removed.

Each earlier task in the family was asked to update the glossary for what IT changed, so the tree was never left saying something false. This task owns what none of them could: the pass that reads those entries TOGETHER and makes the vocabulary one coherent account rather than four correct patches. Look especially at the entries for the follower, the read-only stream view, the promotion trigger and drop-on-promotion, the generation slot, and the writable-store entry that contrasts a stream's writer with a state store's writer -- that contrast is the sharpest statement of the old rule in the document and it is load-bearing for a reader learning the difference, so it needs rewriting rather than deleting.

**Then remove ADR-0087's `status: accepted, not yet implemented` line. THIS IS THAT TASK.** It is blocked by every other task in the family precisely so that it is unambiguously last, which `work/protocol/ADR-FORMAT.md` warns is otherwise a hand-off with no holder: "every task in a chain can see that it is not the last one while the actual last one has no way to know that it is". ADR-0006 and ADR-0073 both kept the line for exactly that reason. Check rather than assume: confirm each of the other four tasks is in `work/tasks/done/`, and say which you checked and what you found.

**Do not remove the line if the family did not actually land what the ADR decided.** The status is a claim about the CODE, not about the tasks. If a blocker landed in a reduced form -- the automatic reap removed but a stream still lost across a restart, or a write duty still derivable from registration order -- then the honest outcome is to leave the line, say what is missing, and route this to needs-attention. A green board is not the same as a decision implemented.

Also check what ELSE documents the old rule. The user-facing guide and the package READMEs may describe a deployment's relationship to its stream, and a doc site that teaches a retired rule is worse than one that is silent (there is already an observation in this repo about two doc sites describing a deleted concept).

## Acceptance criteria

- [ ] `CONTEXT.md` describes ONE rule for who writes a stored stream -- whoever fetches it -- with no entry still deriving the duty from registration order or describing a succession on delete.
- [ ] The contrast between a stream's writer and a state store's writer survives as a teaching point, restated under the new rule rather than dropped.
- [ ] `CONTEXT.md` says a stream is kept when nothing folds it and is deleted only when an operator asks, and names the verbs that still delete.
- [ ] Any guide page, README or doc-site text that teaches the retired rule is corrected, or its absence is stated after checking.
- [ ] Every other task in this family is CONFIRMED to be in `work/tasks/done/`, and which were checked is stated.
- [ ] ADR-0087's `status: accepted, not yet implemented` line is removed -- and only if the decision is actually implemented, with the check for that stated rather than assumed.
- [ ] Every citation of a `work/` artifact that this family's done-moves invalidated resolves: `pnpm check:refs` is part of the gate, and this is the task positioned to see the whole family's moves at once.
- [ ] No behaviour changes here. This is documentation and one frontmatter line; a diff touching `packages/*/src` is out of scope and a sign the family did not finish.
- [ ] A changeset accompanies the change if anything shipped in a package changed (`pnpm changeset`); documentation-only changes follow whatever this repo already does for them, which should be checked rather than guessed.

## Blocked by

All four of `run-and-build-drive-the-folds-they-hold-rather-than-one-captured-receiver`, `a-restarted-generation-re-folds-its-stream-instead-of-re-fetching-the-chain`, `whoever-fetches-a-stream-writes-it-and-the-stream-outlives-every-fold`, and `a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge`.

The chain is linear, so the last of them would be enough to order this. They are ALL listed anyway, deliberately: the fan-in is what makes this task able to know it is last, which is the whole mechanism `ADR-FORMAT.md` asks for and which ADR-0086's closing task used.

## Prompt

The goal is that a reader who learns this codebase from `CONTEXT.md` learns the rule that is actually in force, and that ADR-0087 stops claiming to be unimplemented once it is.

Read ADR-0087 in full, then read every `CONTEXT.md` entry that mentions a stream's writer, a follower, a read-only stream view, drop-on-promotion, a generation slot or reclaiming. Read `work/protocol/ADR-FORMAT.md` on the `accepted, not yet implemented` status and why removing it is part of the work that implements it.

The decision most likely to be got wrong is treating this as a find-and-replace. The glossary does not merely MENTION the old rule, it ARGUES from it in several places -- the writable-store entry uses "a stream's writer is the oldest surviving generation, a state store's writer is the last claimant" as a deliberate contrast to stop two things being conflated, and the promotion entry explains a decline in terms of it. Rewrite the arguments so they still teach what they were teaching, under the new rule. A sentence that merely stops being false while no longer explaining anything is a worse outcome than the old one.

The second: verify the family before you expire the status line. Read the four done records, and read the code for the two claims that are easiest to land partially -- that nothing derives a write duty from registration order, and that a stream survives having no folds over it ACROSS A RESTART. If either is not true, leave the line and stop.

The third: this repo's reference check will fail on any citation of a task that moved to `done/` during this family. You are the task that can see all of them. Run the check and fix what it names.

Done means: one rule in the glossary, the contrast still taught, the doc surfaces checked, the family confirmed done, and the status line gone because the decision is implemented.

FIRST, check this task against current reality. Four tasks landed before it and the vocabulary they left is what you are reconciling, so this body's description of what `CONTEXT.md` says may already be partly out of date -- read the file, not this summary.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT: how you restated the writer contrast, what you found when you verified the family, and anything you chose to leave alone. Do not write the done record, the commit message or the PR body yourself.
