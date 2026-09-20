---
title: "The guide's `addGeneration` recipe gives the new fold its OWN store, so copying it does not collide with the live one"
slug: the-guide-s-add-generation-recipe-gives-the-new-fold-its-own-store
blockedBy: []
covers: []
---

## What to build

A correction to ONE copyable snippet on the user-facing guide, which currently teaches a recipe that does not work. Documentation only.

**What is wrong.** `docs/guide/indexing-in-a-browser-app/index.md`, in the section "The same edit, without the blank app", shows:

```ts
await indexer.addGeneration({
	createState: () => createBrowserStateStore(next.entities),
	createProcessor: (store) => fromEntityProcessor(next)(store),
});
```

That snippet is wrong twice, and both are the kind of wrong a reader only discovers after copying it.

**It gives the new generation the SAME store as the live one.** `createBrowserStateStore` with no `databaseName` defaults to `etherfold-state`, which is the database the canonical generation is already folding into. Two generations sharing one `databaseName` are ONE store by IndexedDB's own definition, so they collide on the rows and on the sync cursor, and the writer claim demotes one of the two (ADR-0075, ADR-0077). The section is specifically about building a generation BESIDE the live one, so this is the exact mistake the section exists to avoid.

**And `createState` must hand back a claimed, writable store.** Its contract returns a `WritableStateStore`, which `openForWriting` is the only way to obtain, because folding is writing and the factory is where the claim is taken (ADR-0077). The snippet returns an unclaimed store.

**The page already contains the right answer, forty lines below it**, in the HMR example under `reconfigureFromHotUpdate`, which passes an explicit per-generation `databaseName` and wraps the store in `openForWriting`, with a comment explaining why. So the page teaches the rule and then ships, ABOVE the teaching, a snippet that violates it. Make the two agree.

`@etherfold/browser`'s own `createState` JSDoc carries the canonical minimal form, including forwarding the claim patience signal. Prefer matching what the code documents over inventing a third shape.

This is the still-open half of `work/notes/observations/two-doc-sites-still-describe-the-deleted-declared-identity-or-a-shared-generation-store`. The other half, the browser package README's account of processor identity, is already corrected -- confirm that and do not re-edit it.

## Acceptance criteria

- [ ] The `addGeneration` snippet gives the new generation its OWN store, with an explicit `databaseName` that cannot be the live generation's, and obtains a writable store through `openForWriting`. It reads as something a user can copy and run.
- [ ] The snippet and the `reconfigureFromHotUpdate` example later on the same page agree with each other and with `createState`'s documented contract. A reader who meets them in page order must not be taught two different things.
- [ ] Whatever prose is needed around the snippet says WHY the store must be its own, briefly, rather than leaving a naming convention to be copied without its reason.
- [ ] Every other `createState` / `createBrowserStateStore` snippet on the guide and in the package READMEs is checked for the same two defects, and each is either corrected or its correctness stated after checking.
- [ ] No behaviour change and no source change: this is documentation. A diff touching `packages/*/src` is out of scope.
- [ ] `pnpm docs:build` passes, which is now part of the gate.
- [ ] No changeset: nothing shipped in a package changes. Confirm that is this repo's convention for documentation-only changes rather than assuming it.

## Blocked by

None -- can start immediately.

## Prompt

The goal is that a reader who copies the `addGeneration` recipe off the guide gets a generation that folds beside the live one, instead of one that fights it for a store.

Read `docs/guide/indexing-in-a-browser-app/index.md` around "The same edit, without the blank app", then the `reconfigureFromHotUpdate` example further down the SAME page, which already does it correctly and explains itself. Then read the `createState` JSDoc on `BrowserGenerationSpec` in `@etherfold/browser`, which is the contract and carries the canonical minimal form. ADR-0077 is why the claim is taken in that factory; ADR-0084 is why a generation beside the live one is an ordinary shape rather than an exception.

The decision most likely to be got wrong is inventing a third convention. There are already two correct statements of this in the repo and they agree; your job is to make the broken snippet agree with them, not to design a naming scheme. If the HMR example's scheme does not fit the simpler section, say why in the report rather than quietly diverging.

The second: check the neighbours before you finish. The criterion asking you to sweep the other snippets is there because this defect was found by reading, not by a tool, and nothing in the gate can catch a snippet that typechecks nowhere. A snippet in documentation is not compiled, so it is only as correct as the last person who read it.

Done means: the recipe is copyable and correct, the page agrees with itself, and the other snippets are checked.

FIRST, check this task against current reality. The snippet may already have been corrected; if so, say that and stop rather than rewriting it. Observations in this repo are append-only records of what was true when they were written, not standing instructions.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself.
