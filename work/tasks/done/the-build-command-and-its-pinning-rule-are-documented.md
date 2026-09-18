---
title: 'The build command and its PINNING rule are documented, and ADR-0086 stops saying it is unimplemented'
slug: the-build-command-and-its-pinning-rule-are-documented
spec: a-processor-is-a-bundle-and-its-hash-is-its-identity
blockedBy: [a-path-naming-an-unbundled-entry-point-is-refused, a-snapshot-is-labelled-with-the-identity-it-was-computed-under, a-module-handed-to-a-tab-is-identified-by-its-handler-sources]
covers: [2, 3, 10]
---

## What to build

The last task of this family: the documentation an author needs, and the ADR line that expires when the code lands.

Document how to produce a processor bundle, and make the PINNING rule prominent rather than a footnote, because ADR-0086 makes determinism load-bearing: a non-deterministic build means a new identity on every build and state that is never reused.

**`--minify` is mandatory, and the reason is identity rather than size.** This was measured rather than assumed, and the measurement belongs in the documentation because the obvious reading is wrong. Without minification, esbuild emits a `// <path>` banner per module, so the BUILDING MACHINE'S DIRECTORY LAYOUT ends up in the bytes: the same source built from two different directories hashed DIFFERENTLY un-minified and IDENTICALLY minified. Un-minified, a developer and CI disagree about which generation they are. Stripping comments, which is the reason someone would guess, is the lesser benefit.

**Also remove ADR-0086's `status: accepted, not yet implemented` line.** THIS IS THAT TASK -- it is blocked by every other leaf of the family precisely so that it is unambiguously last, which `work/protocol/ADR-FORMAT.md` warns is otherwise a hand-off with no holder ("every task in a chain can see that it is not the last one while the actual last one has no way to know that it is"). Check rather than assume: confirm the rest of the family is in `work/tasks/done/`, and say which you did.

## Acceptance criteria

- [ ] The documented build command produces a single minified ESM bundle, stated once, in a place an author starting out will actually reach.
- [ ] `--minify` is documented as MANDATORY with the identity reason, including the measured fact that un-minified output embeds per-module path banners.
- [ ] The pinning rule covers the bundler VERSION AND its FLAGS, not merely the tool, and says why: output is a function of both, and a drifting build means state is never reused.
- [ ] `rollup` is named as the alternative for anyone who wants it; `tsup` is not recommended, and the reason is given in a clause rather than a paragraph.
- [ ] The migration note tells an existing author what changed and what to run, matching the refusal message `a-path-naming-an-unbundled-entry-point-is-refused` emits, so the error and the docs say the same thing.
- [ ] Source maps are mentioned as the answer to minified stack traces, and stated not to affect the identity.
- [ ] `ADR-0086`'s `status: accepted, not yet implemented` line is REMOVED, after confirming the rest of the family has landed.
- [ ] `CONTEXT.md` describes how a processor is identified in the new vocabulary, since it is the glossary a future reader lands on first.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-path-naming-an-unbundled-entry-point-is-refused`, `a-snapshot-is-labelled-with-the-identity-it-was-computed-under` and `a-module-handed-to-a-tab-is-identified-by-its-handler-sources` -- the three leaves of this family. The fan-in is deliberate and is what makes this task the LAST one, so that removing the ADR status line has an unambiguous owner.

## Prompt

The goal is that an author can produce a bundle correctly on the first try, and that ADR-0086 stops claiming to be unimplemented once it is.

Read **ADR-0086** in full, then `work/specs/tasked/a-processor-is-a-bundle-and-its-hash-is-its-identity.md` for the measured esbuild behaviour recorded at launch, then `work/protocol/ADR-FORMAT.md` on the status vocabulary and specifically on why the expiring line is the implementer's to remove.

The decision most likely to be got wrong is treating the minify rule as a style preference and documenting it as one. It is a CORRECTNESS rule for identity: without it two machines building the same source disagree about which generation they are, because the directory layout is in the bytes. Lead with that.

The second: the error message and the documentation must agree word for word on the command. An author meets the refusal first and the docs second, and two different commands is worse than either alone. Check what `a-path-naming-an-unbundled-entry-point-is-refused` actually emits.

The third: do not skip the ADR line because it feels like housekeeping. It is a claim about the code that is false the moment the code lands, and the format doc records two ADRs where exactly this deferral left a stale line for months. Confirm the family is done, remove it, and say so.

The seam to test at is mostly the repo's own gates: `check:adr`, `check:refs` and `format:check` cover the documentation surface, and the acceptance gate proves the example command still produces something the loader accepts.

Done means: an author can bundle correctly from the docs, the refusal and the docs say the same thing, and ADR-0086 no longer says it is unimplemented.

## Decisions

**Source maps are documented PER SPELLING, not as "they do not affect the identity".** The acceptance criterion asks for source maps to be "stated not to affect the identity". Measured, that is true of `--sourcemap=external` (byte-identical bundle) and FALSE of plain `--sourcemap`, which appends a `//# sourceMappingURL=` comment and so produces a different hash, hence a different generation. I documented the measured truth and named `--sourcemap=external` as the spelling to use, rather than writing the flat sentence the criterion suggests. Alternative considered: state it flatly and let an author discover the re-fold; rejected, because a documentation claim that is false for the DEFAULT spelling of the flag is exactly the class of error this task exists to prevent. Touches: nothing in code; it does set a user-facing recommendation of one flag spelling over another, and it strengthens the pinning rule (a source-map flag is a flag to pin).

**The canonical home is `packages/cli/README.md`, not the docs site.** `docs/guide/getting-started/index.md` is a two-line stub ("Documentation in Progress"), so a new guide page would sit in an unfinished site and need a sidebar edit to be reachable. The CLI README is what an npm user of `etherfold` reads, is where `-p` is documented, and is the reference for the `etherfold <command>` the refusal names. The example README keeps only its concrete invocation and links here for the rule; the root README carries a one-paragraph pointer. Alternative: a `docs/guide/` page (rejected, above) or the root README (rejected: it is browser-first, and the block is a CLI-authoring concern). Touches: anyone later writing the getting-started guide should link this section rather than restate it, or the "stated once" property dies.

**The section is called "Producing the processor bundle", not "Building the bundle".** Coherence check against the existing language: `build` already means `etherfold build`, a command "named for what it PRODUCES: a database", and the section sits directly under it. A heading with `build` in it would have made one word mean two things one heading apart. Touches: the anchor `#producing-the-processor-bundle` is linked from the root README, the example README and the spike.

**Two new glossary terms, both taken from names the code already uses.** **processor identity** (`requireProcessorIdentity`, `GenerationId.processor`) and **processor artifact** (`loadProcessorArtifact`, `processorArtifactIdentity`, `unresolvedImportsOf`), rather than coining a word such as "bundle identity". They overlap the existing **generation** entry, which already says a generation is identified by its stream plus the processor's identity; that entry is the composite and these are the term it names, so I left it alone and did not duplicate its content. Touches: `CONTEXT.md` is the glossary later artifacts inherit, so the spellings matter.

**The `<!-- bundle-command: -->` anchor is a new convention in a documentation file.** It follows the existing `<!-- provider-surface: -->` anchor in the root README, which is checked by `packages/core/test/theEngineDeclaresItsMethodSet.test.ts`; I copied the shape rather than inventing a second way to mark prose held to the code. Touches: any future edit to `bundleCommand()` in `packages/cli/src/config.ts` must change both documents in the same commit, which is what the anchor comment says out loud.
