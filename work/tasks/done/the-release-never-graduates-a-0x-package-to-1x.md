---
title: 'The release never graduates a 0.x package to 1.x: changesets v3, an internal peer as `workspace:^`, and a guard that refuses any 1.x'
slug: the-release-never-graduates-a-0x-package-to-1x
blockedBy: []
covers: []
---

## What to build

The open Version Packages PR (#239, branch `changeset-release/main`) takes `@etherfold/graphql` from `0.0.0` to **`1.0.0`**, although no changeset asks for a major (every changeset in this repo is patch or minor, by policy). Cause, established by the first build of this task (2026-09-29) and verified: `@etherfold/graphql` peers on `@etherfold/browser` (optional), `@etherfold/browser` gets a minor (0.11.0 to 0.12.0), and changesets v2 (`@changesets/cli` 2.31.0, `@changesets/assemble-release-plan` 6.0.10) bumps a peer-dependent to major on any minor of its peer (`shouldBumpMajor`). Changing the peer to `workspace:^` alone does NOT help on v2: `getDependencyVersionRanges` turns it into `^0.11.0` and graphql still goes to `1.0.0`. `wighawag/rocketh` avoids it because it upgraded to `@changesets/cli` v3 (`b34e921c`), whose `assemble-release-plan` 7.0.0 no longer has `shouldBumpMajor` (rocketh's own comment credits `workspace:^`, which is wrong: see rocketh PR #167).

The maintainer chose option (a), 2026-09-29: do what rocketh does.

1. **Upgrade to `@changesets/cli` v3** (the root devDependency, and the lockfile), and to **`changesets/action` v2** in `.github/workflows/release.yml`, whose inputs are renamed: `version-script`, `publish-script`, `github-token` (v2 requires the token as an input and no longer reads the `GITHUB_TOKEN` env), and `push-with-git-cli: true` to keep pushing through the Git CLI as v1 did. Copy rocketh's release step (`../rocketh/.github/workflows/release.yml`, `changesets/action@ae32849d5ba541f9ae29e40e22a623bc13562f51 # v2.1.2`) and its comments, adapted to this repo's scripts. Check that the repo's own changeset tooling (`scripts/check-changesets.mjs`, `pnpm changeset status --since=main` in the gate, `release:ci`) still works on v3, and that `.changeset/config.json` is still valid (bump its `$schema` if v3 names a new one).
2. **Declare the internal peer as `workspace:^`** (not `workspace:*`), still optional, so pnpm publishes it as a `^x.y.z` range instead of an exact pin (rocketh `42d7ff62`).
3. **Add the guard** the first build already wrote once (its branch was not kept, so write it again): `scripts/check-no-major-graduation.mjs` (plain `node`, like the other `scripts/check-*.mjs`), which compares each workspace package's version in the working tree against `HEAD` and exits non-zero naming any package that was below 1.0.0 and is now at or above it; a package already at or above 1.0.0 may move. A root `changeset:version` script runs `changeset version` then the guard, and the release step's `version-script` is `pnpm changeset:version`, so the Version PR is never opened with a graduated package. Its comment and failure message name changesets v3 (not `workspace:^`) as what normally prevents the bump.
4. **Document** the rule where the repo states its "0.x, patch or minor, never major" policy (`CONTEXT.md` or the contributing docs): stay on `@changesets/cli` >= 3, declare an internal peer as `workspace:^`, and the guard is the backstop.

Do NOT edit the `changeset-release/main` branch or PR #239: once this lands, the release workflow regenerates it.

## Acceptance criteria

- [ ] `@changesets/cli` is v3 in the root `package.json` and the lockfile; `release.yml` uses `changesets/action` v2 with `version-script`, `publish-script`, `github-token` and `push-with-git-cli: true`; `ci.yml` is unchanged.
- [ ] `@etherfold/graphql`'s `peerDependencies['@etherfold/browser']` is `workspace:^`, still optional.
- [ ] Measured, not assumed: in a throwaway copy of the repo (never the committed tree), `pnpm changeset:version` over the pending changesets gives `@etherfold/graphql` a 0.x version (expected `0.1.0`) and no package reaches 1.x, and the guard passes; state every package's before and after version in `## Decisions`. Also state what the same run gave on v2 (expected: graphql `1.0.0`, and the guard failing on it).
- [ ] `pnpm pack` of `@etherfold/graphql` shows the peer published as a `^` range (state the manifest line).
- [ ] The guard exits non-zero when a 0.x package's version becomes 1.x or higher, and zero otherwise, shown by a test over a fixture (a vitest case or a scripted check the gate runs), not by hand only.
- [ ] The gate's `pnpm changeset status --since=main` and `pnpm check:changesets` still pass on v3.
- [ ] Changesets: `@etherfold/graphql` (patch, the published peer range changes). No major.
- [ ] CI: the PR's CI green as a whole.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: a release that publishes only the versions the changesets chose, with no accidental 1.0.0, done the way rocketh does it (maintainer's answer (a)). Look at the root `package.json` (the `@changesets/cli` devDependency and scripts), `scripts/check-*.mjs`, `.changeset/config.json`, `.github/workflows/release.yml`, `packages/graphql/package.json`, and in `../rocketh` (read only): `package.json` (`changeset:version`, `changeset:check-graduation`), `.github/workflows/release.yml`, `scripts/check-no-major-graduation.ts`, and commits `b34e921c`, `42d7ff62` and `e68fa683`.
>
> FIRST, check this task against current reality: it was re-scoped on 2026-09-29. Check that the repo is still on `@changesets/cli` v2 and that a `changeset version` run still gives `@etherfold/graphql` 1.0.0. If not, route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> Run `changeset version` only in a throwaway copy (for example a `git worktree` or a copy under a temp dir), never in the tree you commit: it deletes the changesets and rewrites every package version.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files.

## Decisions

- **Measured versions (the throwaway runs).** v3 run: my changes committed in a clone, then `pnpm changeset:version`. v2 run: an unmodified clone at `0d33344e` with `changeset version`. The guard passed on v3 and exited 1 on the v2 output, naming `@etherfold/graphql: 0.0.0 -> 1.0.0`. Each line is package: before, then v3, then v2:
  - accessor: 0.0.0, 0.1.0, 0.1.0
  - browser: 0.11.0, 0.12.0, 0.12.0
  - etherfold: 0.9.0, 0.10.0, 0.10.0
  - core: 0.10.0, 0.10.0, 0.10.0
  - fetcher-host: 0.2.2, 0.2.2, 0.2.2
  - **graphql: 0.0.0, 0.1.0, 1.0.0**
  - processor-entities: 0.3.0, 0.3.1, 0.3.1
  - processor-sqlite: 0.2.2, 0.2.3, 0.2.3
  - server: 0.3.0, 0.4.0, 0.4.0
  - state-moved-conformance: 0.3.0, 0.3.0, 0.3.0
  - state-store-conformance: 0.3.0, 0.4.0, 0.4.0
  - state-store-indexeddb: 0.2.1, 0.3.0, 0.3.0
  - state-store: 0.3.0, 0.4.0, 0.4.0
  - state-store-patch: 0.2.1, 0.2.2, 0.2.2
  - state-store-sqlite: 0.3.0, 0.4.0, 0.4.0
  - utils: 0.8.2, 0.8.2, 0.8.2
  - platform-nodejs-fetcher: 0.2.2, 0.2.2, 0.2.2
  - platform-nodejs: 0.2.2, 0.3.0, 0.3.0
- **`pnpm pack` manifest line.** Packing `@etherfold/graphql` in this tree gives `"@etherfold/browser": "^0.11.0"` under `peerDependencies`. After the version bump it would be `^0.12.0`. I could not pack in the version-bumped clone, because its packages were not installed there.
- **How the guard test runs in CI.** I used `node --test` through a new `test:scripts` script at the start of the root `test`, rather than vitest (there is no package around a root script) or a new step in `dorfl.json` (CI would never run it, and the task says `ci.yml` stays unchanged). The downside is that the root `test` now does slightly more for every task's gate, about 0.3s. This touches the root `test` script, which both the gate and CI use.
- **What the guard scans.** It reads `packages/`, `platforms/` and `examples/`, the same list `check-changesets.mjs` uses, and skips `private: true` packages. Rocketh's version reads only `packages/`, which would miss the published `@etherfold/platform-*` packages. It takes an optional root argument so the fixture test can point it at a temp repo.
- **Where the policy is written down.** The "patch or minor, never major" rule was not stated anywhere in `CONTEXT.md` (only in task prompts). I added it as a new Conventions bullet next to the changeset rule, with the three safeguards. Nothing else links to it.
- **`$schema` bump.** I pointed it at `@changesets/config@4.0.1`, the version v3 installs. That schema still lists every key our config uses.
