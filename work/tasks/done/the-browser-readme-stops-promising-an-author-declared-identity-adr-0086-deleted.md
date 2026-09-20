---
title: "The browser README stops promising an author-declared identity that ADR-0086 deleted, and stops contradicting itself"
slug: the-browser-readme-stops-promising-an-author-declared-identity-adr-0086-deleted
blockedBy: []
covers: []
---

## What to build

One false sentence in a published package README, removed. Documentation only, and deliberately tiny.

**The contradiction.** `packages/browser/README.md` says two incompatible things about where a generation's identity comes from, 97 lines apart.

At line 136, closing the `processorIdentity` paragraph:

> Leave it off and the generation keeps the author-declared identity the processor computes from its `version`, exactly as before.

At line 233:

> Nothing an application supplies is ever taken as an identity here; a value nobody can check against the code it claims to name is the author-declared identity ADR-0086 deletes.

The second is right. ADR-0086 is titled "a processor's identity is derived from its code and never declared", and the same paragraph at 136 cites it one sentence earlier while contradicting it in the next. A reader who stops at 136 -- which is where the API is described, so it is where most readers stop -- is told the opposite of the rule, and told it in the reassuring form "exactly as before", which invites them not to look further.

**What omitting `processorIdentity` actually does** is the thing to state instead, and it is already written correctly elsewhere in the same file (around line 198 and again at 233): the identity is DERIVED, and for a processor a dev server handed the tab as a module -- which has no bytes to hash -- it is a derivation over the handler SOURCE TEXT. So an edited handler is a different generation with no `version` to bump, and a save that changed nothing is answered `{stateDiscarded: false}` rather than costing a rebuild. Say that, briefly, rather than deleting the clause and leaving the reader with no answer at all to "what if I leave it off".

**Check whether `version` still means anything here before you write about it.** The false sentence claims the processor computes an identity from its `version`. If nothing derives an identity from a declared `version` any more, do not preserve that idea in softened form -- say what the derivation actually is. If something DOES still read `version` for some other purpose, that is worth one clause so the field does not look abandoned.

This is the still-open half of `work/notes/observations/two-doc-sites-still-describe-the-deleted-declared-identity-or-a-shared-generation-store`. The other half, the guide's `addGeneration` store recipe, is closed. Note that the observation carries an appended 2026-09-20 update from the task that closed that half, recording that THIS half was reported corrected and was not -- so verify against the file rather than against any prose claiming it is done, including this task's.

## Acceptance criteria

- [ ] `packages/browser/README.md` no longer says a generation keeps an author-declared identity computed from its `version`, and no longer says "exactly as before" about it.
- [ ] What omitting `processorIdentity` DOES is stated positively -- the identity is derived from the code, over handler source text for a module-delivered processor -- so the paragraph still answers the question a reader came to it with.
- [ ] The README does not contradict itself on this point anywhere: the `processorIdentity` paragraph, the `updateProcessor` bullet and the derivation paragraph all say the same thing.
- [ ] Whether a declared `version` still has ANY role is checked in the code and stated, rather than the word being quietly dropped or quietly kept.
- [ ] The same claim is checked for in the other package READMEs and in `docs/`, and each is corrected or its absence stated after checking. A doc site that teaches a retired rule is the subject of the observation this closes.
- [ ] No behaviour change and no source change. A diff touching `packages/*/src` is out of scope.
- [ ] `pnpm docs:build` passes, which is part of the gate.
- [ ] No changeset: nothing shipped in a package changes. Confirm that is this repo's convention for a README-only change rather than assuming it.

## Blocked by

None -- can start immediately.

## Prompt

The goal is that the browser package's README stops telling a reader that they can declare a processor's identity, which is the exact thing ADR-0086 removed.

Read `docs/adr/0086-a-processors-identity-is-derived-from-its-code-and-never-declared.md`, then read `packages/browser/README.md` straight through, paying attention to the `processorIdentity` paragraph, the `updateProcessor` bullet and the derivation paragraph near the end. Two of those three are already correct and can be borrowed from; you are making the third agree.

The decision most likely to be got wrong is deleting the false clause and stopping. The sentence exists because a reader genuinely wants to know what happens if they omit an optional field, and an omission that answers nothing is a worse README than one that answers wrongly -- they will guess, and the most natural guess is the retired rule. Replace it with the true answer.

The second is scope. This is a README. The derivation itself is correct in the code, `processorIdentity` is optional on purpose, and nothing here needs fixing under `packages/*/src`. If you find a genuine code defect while reading, capture it as an observation and leave it.

Done means: the paragraph is true, the file agrees with itself, and the other doc surfaces are checked.

FIRST, check this task against current reality. The precise thing this task exists for -- a claim that a doc half was already corrected when it was not -- has already happened once on this exact observation, which is why the body above tells you to verify against the file. Do that. If the sentence is already gone, say so and stop.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself.

## Decisions

**A changeset IS required, contrary to the task's acceptance criterion.** Criterion 8 asserted "No changeset" but told me to confirm rather than assume. I confirmed, and it is false: `pnpm changeset status --since=main` is in the `verify` gate and fails with "Some packages have been changed but no changesets were found" for a README-only change, because changesets attributes any file under a package directory to that package. Shipping without one would have bounced the gate at land time. I added `.changeset/the-browser-readme-stops-promising-an-author-declared-identity.md` as `patch` on `@etherfold/browser` and `@etherfold/utils`. Alternative considered and rejected: `changeset add --empty`, which `packages/core/test/pendingChangesets.test.ts` explicitly fails ("names no package, so releasing it would discard it"). Precedent agrees: `the-build-command-and-its-pinning-rule-are-documented` was also documentation-only, carried a real patch changeset on `etherfold`, and closed with "Documentation only; no published behaviour changes" — the line I reused. This touches nothing but the release notes; a README ships in the npm tarball, so a patch is honest. Whoever wrote criterion 8 should know the repo convention is the opposite of what it assumed.

**Corrected a third doc site (`packages/utils/README.md`) rather than only reporting it.** Criterion 5 says other package READMEs are "corrected or [their] absence stated after checking", so this is inside the fence, but it is a second package and therefore a second changeset entry. Alternative considered: capture it as an observation and leave it, which I rejected because the criterion authorises the correction and because leaving one of two instances of the same retired rule is what produced this task in the first place.

**Appended a closing line to the observation note** (`work/notes/observations/two-doc-sites-still-describe-the-deleted-declared-identity-or-a-shared-generation-store.md`) recording that both halves are now closed and that a third site turned up. The note currently ends "this half is still open", and a stale open-state line is precisely the drift that caused this task's predecessor to report a fix that had not happened. Observations are the append-only bucket anyone may add to, and I did not move or re-status the file. Alternative: leave it to the done record, rejected because the next agent reads the note, not the done record.
