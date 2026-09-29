---
title: 'The release never graduates a 0.x package to 1.x: an internal peer is `workspace:^`, and a guard refuses any 1.x'
slug: the-release-never-graduates-a-0x-package-to-1x
blockedBy: []
covers: []
needsAnswers: true
---

## What to build

The open Version Packages PR (#239, branch `changeset-release/main`) takes `@etherfold/graphql` from `0.0.0` to **`1.0.0`**, although no changeset asks for a major (every changeset in this repo is patch or minor, by policy). Cause: `@etherfold/graphql` declares `@etherfold/browser` as an optional PEER with the range `workspace:*`, `@etherfold/browser` gets a minor (0.11.0 to 0.12.0), and changesets bumps a package whose peer dependency moved out of its range to a major. It is the only published package with an internal peer today, so every future `@etherfold/browser` minor would do it again.

The same problem was solved in `wighawag/rocketh` (commits `42d7ff62` and `e68fa683`, and `scripts/check-no-major-graduation.ts` there); follow it:

1. **Declare the internal peer as `workspace:^`**, not `workspace:*`. Rocketh checked by running `changeset version`: changesets never evaluates the literal string `workspace:^` as a semver range, so the out-of-range peer rule cannot fire, and the dependent gets the plain internal-dependency patch instead. pnpm publishes `workspace:^` as `^x.y.z` (where `workspace:*` publishes an exact pin that forces consumers to move in lockstep). Keep it optional (`peerDependenciesMeta`).
2. **Add a guard** that fails the release if any package below 1.0.0 would reach 1.x: a script (port rocketh's `scripts/check-no-major-graduation.ts`, adapted to this repo: plain `node` `.mjs` like the other `scripts/check-*.mjs` if tsx is not a root dependency) that compares each workspace package's version in the working tree against `HEAD` and exits non-zero naming the package. Run it right after `changeset version` in the release workflow's `version:` step (a `changeset:version` root script, as rocketh has), so the Version PR is never opened with a graduated package.
3. **Document** the rule in the workflow comment and wherever the repo states its "0.x, patch or minor, never major" policy (look for it in `CONTEXT.md` or contributing docs), so the next internal peer is declared `workspace:^`.

Do NOT edit the `changeset-release/main` branch or PR #239: once this lands, the release workflow regenerates it.

## Acceptance criteria

- [ ] `@etherfold/graphql`'s `peerDependencies['@etherfold/browser']` is `workspace:^`, still optional.
- [ ] Measured, not assumed: in a throwaway copy of the repo (never the committed tree), `pnpm changeset version` over the pending changesets gives `@etherfold/graphql` a 0.x version (state it in `## Decisions`, expected `0.1.0`) and no package reaches 1.x; the same run with the peer put back to `workspace:*` reproduces `1.0.0`. State both results.
- [ ] `pnpm pack` of `@etherfold/graphql` shows the peer published as a `^` range (state the manifest line).
- [ ] The guard exits non-zero when a 0.x package's version becomes 1.x or higher, and zero otherwise, shown by a test (a vitest case over a fixture, or a scripted check the gate runs) rather than by hand only; a package already at or above 1.0.0 is free to move.
- [ ] The release workflow runs the guard after `changeset version`; `ci.yml` is unchanged.
- [ ] Changesets: `@etherfold/graphql` (patch, the published peer range changes). No major.
- [ ] CI: the PR's CI green as a whole.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: a release that publishes only the versions the changesets chose, with no accidental 1.0.0. Look at `packages/graphql/package.json` (`peerDependencies`, `peerDependenciesMeta`), `.changeset/config.json`, `.github/workflows/release.yml` (the `changesets/action` step), the root `package.json` scripts and `scripts/check-*.mjs`, and in `../rocketh` (read only): `scripts/check-no-major-graduation.ts`, its root `package.json` `changeset:version` script, its release workflow, and the messages of commits `42d7ff62` and `e68fa683`.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-29. Check that `@etherfold/graphql` still peers on `@etherfold/browser` with `workspace:*` and that a `changeset version` run still gives it 1.0.0. If not, route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> Run `changeset version` only in a throwaway copy (for example a `git worktree` or a copy under a temp dir), never in the tree you commit: it deletes the changesets and rewrites every package version.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files.
