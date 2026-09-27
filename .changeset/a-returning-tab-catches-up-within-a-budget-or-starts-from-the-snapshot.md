---
'@etherfold/browser': minor
'@etherfold/processor-entities': minor
---

A returning tab catches up within a time budget, or starts from the published snapshot (ADR-0096).

`@etherfold/browser`: a tab that already holds local state and whose `publication` names a snapshot for its generation further along than that state catches up from its own cursor, and SWITCHES to the snapshot mid-run when the node refuses the catch-up as an archive refusal (`ArchiveRefusedError`), or when the rest of the catch-up is estimated (from the blocks its advances covered and the time they took) to take longer than the new `catchUpWithinSeconds` option: seconds, default `DEFAULT_CATCH_UP_WITHIN_SECONDS` (30), or `'always'` to catch up however long it takes and switch only on the refusal. The switch builds the generation again and hands `createState` the snapshot with the new `PublicationSnapshot.replaceLocal: true`, so the app's own `openAndBootstrap` wipes and installs; it is reported on `syncing.publication` as the new `switched` outcome (`reason: 'archive-refused' | 'over-budget'`, `at`, `left`, and for `over-budget` `estimateSeconds` and `budgetSeconds`). With no usable snapshot, or local state already at or ahead of it, nothing changes. `createState` must forward `published.replaceLocal` to `openAndBootstrap` for the switch to install. `SnapshotSwitchReason` is exported. A negative or non-finite `catchUpWithinSeconds` is refused at construction.

`@etherfold/processor-entities`: `BootstrapOptions.replaceLocal` lets `openAndBootstrap` install over a store that has already synced (it still keeps one at or ahead of every candidate); without it a synced store is kept without a request, as before.
