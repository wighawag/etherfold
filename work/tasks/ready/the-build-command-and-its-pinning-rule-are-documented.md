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
