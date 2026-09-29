<!-- dorfl-sidecar: item=task:the-release-never-graduates-a-0x-package-to-1x type=task slug=the-release-never-graduates-a-0x-package-to-1x allAnswered=false -->

## Q1

**'task:the-release-never-graduates-a-0x-package-to-1x' was bounced — how should we proceed?**

> The task's step 1 does not hold in this repo, so its main acceptance criterion ("`changeset version` gives graphql a 0.x version after `workspace:^`") cannot be met as written. Measured in a throwaway clone with @changesets/cli 2.31.0 (assemble-release-plan 6.0.10): with the peer as `workspace:*`, graphql goes 0.0.0 -> 1.0.0 (drift check confirmed). With the peer changed to `workspace:^` and nothing else, graphql STILL goes 0.0.0 -> 1.0.0.
>
> Cause, read from the source. In v2, `getDependencyVersionRanges` turns `workspace:^` into `^<oldVersion>` (`^0.11.0`), so the literal IS evaluated as a range. `shouldBumpMajor` also bumps a peer-dependent to major on ANY minor/major release of the peer unless `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange` is true, and even then `^0.11.0` excludes 0.12.0. Rocketh avoids the bump because it is on @changesets/cli 3.0.0 (assemble-release-plan 7.0.0), which removed `shouldBumpMajor` completely. The "`workspace:^` is never evaluated" explanation in rocketh's commit e68fa683 and its script is wrong, and this task inherited it.
>
> A human has to pick the real fix. The options are each a design decision that reaches past this task:
> (a) Upgrade @changesets/cli to v3. Rocketh notes this also requires changesets/action v2 with renamed inputs (`version-script`, `publish-script`, `github-token`, `push-with-git-cli`), so it reworks release.yml. Keep `workspace:^` for the `^x.y.z` publish range.
> (b) Stay on v2 and set `onlyUpdatePeerDependentsWhenOutOfRange: true` in `.changeset/config.json`, with a peer range that admits future 0.x minors (e.g. `workspace:>=0.11.0`, which publishes as `>=0.11.0`). This relies on an experimental option.
> (c) Remove `@etherfold/browser` from graphql's peerDependencies (it is already a devDependency) and document the optional import differently.
>
> The guard itself (`scripts/check-no-major-graduation.mjs`, a `changeset:version` root script, `check:graduation` in the dorfl verify gate) was built and works. Suggested re-scope: pick (a), (b) or (c), then keep the guard, the release.yml `version: pnpm changeset:version` step, the CONTEXT.md convention bullet and the graphql patch changeset as already specified.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
