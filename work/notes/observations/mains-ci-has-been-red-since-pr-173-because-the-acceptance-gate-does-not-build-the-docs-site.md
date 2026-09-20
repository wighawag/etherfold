---
title: "Main's CI has been red for two days and seven merged PRs, because the acceptance gate does not build the docs site"
date: 2026-09-20
---

`main`'s CI has failed on every commit since 2026-09-18 14:26. Seven PRs have merged into it since, each one green on its own acceptance gate. The gate and CI do not run the same thing, so the gate cannot see the failure and nothing else was looking.

## The bisect

```
382421fe   2026-09-18T13:54Z   success    <- last green CI on main
a05ba3d5   2026-09-18T14:26Z   failure    <- PR #173, first failure
...        every main commit since          failure
a70e15bb   2026-09-20T08:27Z   failure
```

`a05ba3d5` is `the-build-command-and-its-pinning-rule-are-documented` (#173), and it is the commit that added the file the failure names. PRs #174, #175, #176, #177, #178, #179 and #180 all merged on top of it, each with a green gate.

## The failure

```
Found dead link ./../../../packages/cli/README
  in docs/spikes/the-build-command-and-its-pinning-rule-are-documented/README.md
[vitepress] 1 dead link(s) found.
```

The link is real and its target exists on disk:

```md
Evidence for the documented build command in
[`packages/cli/README.md`](../../../packages/cli/README.md#producing-the-processor-bundle).
```

`packages/cli/README.md` is present. The link is dead in the SITE rather than in the repository: VitePress's source root is `docs/`, so a relative link that climbs out of it has no page to resolve to, whatever exists in the filesystem. A link out of the docs tree and into the package tree cannot be expressed this way at all, so this is not a typo to repair but a link that needs a different form -- the published README URL, or the documented page that covers the same ground, or no link.

## Why nothing caught it

The two things called "the gate" are different sets.

`dorfl.json`'s `verify`, which is what the acceptance gate and every `dorfl do` run, is:

```
format:check, check:adr, check:refs, check:graph, check:changesets,
changeset status, build, typecheck, test
```

The CI workflow runs those AND a `Build docs site` step (`docs:build`: `pwag`, `publish-typedoc`, `vitepress build`). `docs:build` is the step that fails, and it is the one step the gate does not have.

So the acceptance gate is green on a tree CI rejects, by construction and not by accident. Every builder saw a full green gate and a passing local run; the red only exists after the push, on a surface nobody in the loop was reading. A conductor reviewing a PR sees `verify fail` and, correctly following the rule not to merge red, has to bisect `main` before it can tell whether the red is its own -- which is the cost this drive actually paid.

## What follows

Two separable things, and the second is the one that matters.

**The dead link** is a small, self-contained fix in one spike README.

**The gate gap** is the finding. A check that runs in CI and not in `verify` means the gate's green is not a claim about mergeability, and a contributor cannot get an honest answer locally. Either `docs:build` joins `verify`, so a broken docs site reds the gate where it is cheap to see, or it is deliberately excluded and that exclusion is written down with its reason -- but the current state, where it is excluded silently, is what let seven PRs merge onto a red `main` without anyone deciding to.

There is a prior cost signal for the same shape: `check:refs` and `check:graph` were both ADDED to `verify` after the things they check had already gone wrong repeatedly. This is the same class, one step earlier.
