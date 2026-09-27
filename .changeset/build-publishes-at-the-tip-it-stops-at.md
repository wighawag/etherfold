---
'etherfold': minor
---

`etherfold build --publish <dir>` publishes at the tip it stops at (ADR-0095).

After the build has folded to the tip, settled its pointer and pruned, it runs `etherfold publish`'s own implementation over the database it has just written, into `<dir>`, so a scheduled publishing job is one step and the directory holds exactly what a separate `publish` over that database writes. `--history` and `--seed` pass through to it, and are refused on `build` without `--publish`. The processor it expects is always the build's own: a build whose fail-soft final settle left the previous processor canonical is refused, naming both identities, rather than publishing the previous one. A refused publication exits `1` with the fold kept; a build stopped from outside publishes nothing. `--out` stays `publish`'s and is refused on `build`, naming `--publish`; `--publish` is refused on every other command.

The library gains `publishDatabase(db, {out, history, seed, expected?}, deps)`, the implementation both forms call, `PublicationRequest`, `BuildConfig.publish` (a `BuildPublication`), `PreparedIndexing.arrived`, `IndexingDependencies.publication`, and `describePublication(written, command?)`.
