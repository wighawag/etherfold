# The reference trigger service lives in this repo as its own packages, and runs as its own process

ADR-0005 decided that triggers do not RUN inside the indexer-server: each trigger purpose is an independent consumer of the feed, owning its database, cursor, gate, outbox and auth, and the indexer-server stores nothing about it. It said nothing about where the reference trigger service's CODE lives. We decide that it lives here, as two packages of its own: `@etherfold/triggers` (`packages/triggers`, the platform-neutral core: the consumer of `/{indexer}/canonical`, the trigger registry, the outbox and its delivery policy, the action adapters, the registration API) and `@etherfold/platform-nodejs-triggers` (`platforms/nodejs-triggers`, the `etherfold-triggers` command on libSQL), and that it runs as its own process beside `etherfold run`, reaching the indexer only over the same HTTP feed and `/graphql` any third-party consumer reads. This complements ADR-0005 rather than superseding it: every rule of ADR-0005 still holds, because nothing in `@etherfold/server`, `@etherfold/core` or the CLI depends on the trigger packages, and the indexer-server holds no trigger state. Decided by the maintainer on 2026-11-18, moving the service in from its own repo, `wighawag/etherfold-triggers` (built there in steps S2a and S2b of jolly-roger's plan `docs/plans/template-tree-features.md`), with its history.

## Why here

- **The tests run against this repo's source.** The core's tests fold a real processor in an in-process `@etherfold/server` and read its `/canonical` and `/graphql` through the app's `fetch`; with `@etherfold/*` as `workspace:*` dev dependencies, a change to the feed, the cursor, the rewind answer or the as-of read that breaks the reference consumer fails THIS repo's gate, not a later release in another repo.
- **The `@etherfold` org and this repo's release pipeline**: changesets, `.github/workflows/release.yml` with npm OIDC trusted publishing, and `scripts/reserve-npm-names.mjs`, rather than a second pipeline for one service.
- **Licence**: MIT, like every other package here (it was AGPL-3.0 in its own repo; relicensed by its author).

## What it does not change

- **ADR-0005's boundary is a dependency rule now, and holds as one**: the trigger packages depend on the indexer packages only in their TESTS (`devDependencies`), and at runtime only on the HTTP surface (`canonicalFeed`, `stateReader`). No indexer package may depend on them, and the indexer-server grows no trigger route, table or configuration.
- **A third-party trigger service is still a first-class consumer.** Living here gives the reference one no private interface: what it reads is what anyone may read, so the feed contract (ADR-0006, the feed cursor's opacity) is tested by a consumer that cannot cheat.
- **The trigger ADRs (0007, 0009, 0011, 0012, 0013) are this repo's to build now**, and their status says so. What of them is not built yet (the fast lane, digests and the delivery-rate bound, dormancy from delivery feedback, breadth checks at registration) is listed in `work/notes/ideas/what-the-first-build-left-out.md`.

## Considered Options

- **Its own repo (as built in S2a and S2b).** Kept the boundary visible as a repo boundary, but tested against PUBLISHED `@etherfold/*` versions, so a server change that broke the consumer surfaced only after a release, and it needed its own release pipeline and npm scope. Rejected.
- **Inside `@etherfold/server` or the CLI.** What ADR-0005 rejects. Rejected.
