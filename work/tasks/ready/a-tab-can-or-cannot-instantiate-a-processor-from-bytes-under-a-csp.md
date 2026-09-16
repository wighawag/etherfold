---
title: 'SPIKE: can a tab instantiate a processor from BYTES under a realistic Content-Security-Policy?'
slug: a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp
blockedBy: []
covers: []
---

## What to build

A throwaway spike whose DELIVERABLE IS THE ANSWER, not the code. Nothing here ships.

`a-generation-retains-the-code-that-folds-it` proposes that a generation retains the bundle that folds it, so that a `predecessor` can be RESUMED rather than merely read. In a browser that requires a tab to take stored bytes and turn them into a running processor, and a tab is the one runtime where that may simply be forbidden: a strict Content-Security-Policy can block `blob:` and `data:` script execution, and `script-src 'self'` alone is enough to do it.

If a tab cannot evaluate retained bytes under the CSP a real app ships, then browser-side retention does not work, and the revert promise in a tab has to be met some other way or withdrawn honestly. That is a needs-attention answer, and it is much cheaper to learn now than after the retention work is built around the assumption.

Note what is NOT at stake, so the spike stays narrow. A tab's ORDINARY processor arrives as a module object its own bundler loaded, with no evaluation of bytes at all, and the HMR arrival is the same shape. Nothing in `a-processor-is-a-bundle-and-its-hash-is-its-identity` asks a tab to instantiate bytes. This is only about RETENTION and resume.

## Acceptance criteria

- [ ] The question is ANSWERED for the mechanisms that could work in a tab (at least `blob:` URL import and `data:` URL import), against at least: no CSP, a `script-src 'self'` policy, and a policy that explicitly allows `blob:`.
- [ ] The answer states which mechanism works under which policy, rather than a yes or no, since the useful result is the boundary.
- [ ] What a BLOCKED instantiation looks like from inside the page is recorded: whether it is catchable, what it reports, and whether an app could tell it apart from a corrupt bundle. An uncatchable failure and a catchable one lead to different designs.
- [ ] Whether the reference browser deployment's own CSP would permit it is checked, so the answer is about a real app rather than a hypothetical one.
- [ ] If the answer is NO under realistic policies, the alternatives are NAMED and costed in a paragraph each, not designed: retaining the module factory in memory only (lost on reload), requiring the app to register every processor version it might revert to at build time, or accepting that a browser revert is read-only and saying so.
- [ ] The finding is written to `work/notes/findings/` as the deliverable, since this is a spike and the ANSWER is what survives.
- [ ] The spike code is NOT merged: no production path, no new export, no dependency added.

## Blocked by

- None. It can start immediately, and it should, because it gates a design decision rather than depending on one.

## Prompt

The goal is to find out, cheaply and for real, whether a browser tab can turn stored bytes into a running processor, before anything is built on the assumption that it can.

Read `work/specs/ready/a-generation-retains-the-code-that-folds-it.md` for what retention needs and why a `predecessor` that cannot be resumed is the problem being solved. Read **ADR-0086** for why a processor is bytes at all. Read `work/notes/findings/` for the house style of a finding note, and note that this repo has a track record of measuring browser-platform claims rather than trusting them (`browser-storage-headroom-for-generations.md` is the precedent: a documented API reported 6.45 GB of headroom while writes were failing, and the measurement is why nothing rests on it).

This is a PROTOTYPE in the sense of the `prototype` skill: throwaway code scoped to ONE question on the narrowest real case. Do not build a retention path, do not touch `@etherfold/browser`'s exports, and do not add a dependency. A page, a bundle, a CSP header and a result is the whole of it.

The decision most likely to be got wrong is testing the wrong thing. A bundler's dev server usually sends no CSP at all, so a spike that only runs under `vite dev` will report success and mean nothing. Serve the page with the header actually set, and test the policies a real deployment would use.

The second: the interesting result is the BOUNDARY, not the verdict. "`blob:` works unless `script-src` is restrictive, `data:` is blocked by more policies than `blob:` is" is a usable answer; "it works" is not, because the next question is always "under what".

The third: report an inconvenient answer as the answer. If a tab cannot do this under the policies real apps ship, that is a genuine finding that changes the retention design, and it is worth far more than a workaround that only holds where nobody sets a header.

Done means: a finding note in `work/notes/findings/` that says which mechanisms work under which policies, what a blocked attempt looks like from inside the page, and what the retention spec should do about it.
