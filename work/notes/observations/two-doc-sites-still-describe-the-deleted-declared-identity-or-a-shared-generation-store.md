---
title: 'Two browser doc sites lag the generation model: one names the deleted declared identity, one shows two generations sharing a store'
slug: two-doc-sites-still-describe-the-deleted-declared-identity-or-a-shared-generation-store
observed: 2026-09-19
---

2026-09-19 — Noticed while writing the hot-update arrival's docs (`an-hmr-update-reconfigures-the-tab-it-is-running-in`), in files adjacent to the ones I edited, and deliberately not fixed.

`packages/browser/README.md`, in the paragraph about `processorIdentity` on a generation spec, still ends "Leave it off and the generation keeps the author-declared identity the processor computes from its `version`, exactly as before." There is no declared identity any more (ADR-0086, `the-declared-version-and-the-drift-report-are-deleted`): leaving it off now means the MODULE arrival derives one from the handler sources, or is refused if it cannot.

`docs/guide/indexing-in-a-browser-app/index.md`, in the `addGeneration` snippet under "The same edit, without the blank app", passes `createBrowserStateStore(next.entities)` with no `databaseName`, which defaults to `etherfold-state` — the same database the canonical generation is already folding into. Two generations sharing one `databaseName` are one store, so that snippet as written collides on the rows and on the sync cursor and one of the two would be demoted by the writer claim.

2026-09-20 — Checked again while correcting the guide half (task `the-guide-s-add-generation-recipe-gives-the-new-fold-its-own-store`, whose body states this half was already corrected). It is NOT: `packages/browser/README.md` still ends its `processorIdentity` paragraph "Leave it off and the generation keeps the author-declared identity the processor computes from its `version`, exactly as before", and contradicts itself thirty lines below where it says an author-declared identity is what ADR-0086 deletes. The guide half is now fixed; this half is still open.

2026-09-20 — Both halves are now closed. Task `the-browser-readme-stops-promising-an-author-declared-identity-adr-0086-deleted` verified the sentence was still present (it was, verbatim) and replaced it with what omitting `processorIdentity` actually does. A third site carrying the same retired rule turned up while checking the other package READMEs and was corrected in the same change: `packages/utils/README.md` said an arrival with no `identity` left "the author's declared one" naming the fold, where such a deployment is in fact refused (`refuseUnbundledProcessor`, `requireArrivalIdentity`).
