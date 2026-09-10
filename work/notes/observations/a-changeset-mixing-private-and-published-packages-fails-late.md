---
title: 'A changeset naming a private package alongside a published one fails the gate, after the whole build has run'
slug: a-changeset-mixing-private-and-published-packages-fails-late
---

Spotted while driving `the-cli-schedules-the-prune-its-retention-implies`, whose acceptance gate went red with:

```
Error: Found mixed changeset the-cli-schedules-the-prune-its-retention-implies
Found ignored packages: @etherfold/platform-cf-worker
Found not ignored packages: @etherfold/state-store etherfold
Mixed changesets that contain both ignored and not ignored packages are not allowed
```

The work itself was fine. The changeset listed `@etherfold/platform-cf-worker: patch` beside two published packages, because the change had touched a docstring in `platforms/cf-worker/src/d1.ts`.

## Why it happens

`platforms/cf-worker/package.json` sets `private: true`, and `.changeset/config.json` sets `"privatePackages": false` with an empty `"ignore": []`. So the private package is IGNORED by changesets even though nothing names it in the ignore list, and `@changesets/assemble-release-plan` refuses any single changeset that spans both sides of that line. Nothing in the repository says this where an author meets it: the ignore list looks empty, so the rule is invisible until the gate fails.

**A private package needs no changeset entry at all.** It is never published, so there is no version to bump and nothing for a consumer to read. The fix is to drop the private package's line, not to split the changeset in two.

## Why it is worth capturing rather than just fixing

The cost is in WHERE it fails. `pnpm changeset status --since=main` sits early in the gate, but the gate is only reached after `prepare` plus a full agent build, so the whole run is spent before a one-line frontmatter mistake surfaces. And it is an easy mistake to make honestly: an author who edited a file under `platforms/cf-worker/` and is being conscientious about declaring what changed will reach for exactly the line that breaks it.

The private packages this applies to should be enumerated by whoever picks this up. `@etherfold/platform-cf-worker` is the one observed; any other `private: true` workspace package behaves identically.

Possible discharges, for whoever triages this: a note where changesets are authored (a line in the contributing docs or `.changeset/README.md`), or a cheap pre-flight check that refuses a mixed changeset before the expensive part of the gate runs. Unverified which is the better shape.
