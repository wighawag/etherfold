# ADRs name the browser engine under a symbol that no longer exists

2026-09-03, spotted while building `the-old-indexer-shape-is-deleted`.

`docs/adr/0038` ("the decision is made in `EthereumIndexer`") and `docs/adr/0042` (`EthereumIndexer.feed()` / `.replay()`, twice in the decision sentence) still name the class under the identifier this task deleted; the class is `IndexerGeneration` (`@etherfold/core`, `src/indexer.ts`). ADR-0035's amendment shows ADRs in this repo are amended rather than frozen, so a reader following either one to a symbol nothing exports is a live dead end.

Not fixed here: the expand and migrate batches also left the ADRs untouched, so treating them as historical records may be deliberate, and deciding which is a call for a human rather than something to settle inside a contract batch.

## Update, 2026-09-06

Same class, a different ADR, found while citing it as a precedent from
`decide-who-verifies-a-stream-seed-and-against-what`: **ADR-0040** is written about
`BLOB_SNAPSHOT_FORMAT` and `isReadableBlobSnapshot` in `@etherfold/core`, and neither symbol exists.
They went with the free-form blob path (ADR-0037); the only surviving mention in the tree is a
doc-comment reference in `packages/state-store/src/snapshot.ts` (around line 68), which points at a
symbol nothing exports either.

What makes ADR-0040 worse than the two above is that its STANCE is still live and still cited --
"a published artifact a client cannot read is refused, not installed" is the precedent ADR-0064 and
ADR-0065 both build the seed-refusal rule on -- while its MECHANISM is gone. So a reader is sent to
it for a rule that holds and finds an implementation that does not exist, which is the most
confusing of the three cases.

`work/protocol/ADR-FORMAT.md` has vocabulary for exactly this and ADR-0040 carries no status at all;
`superseded in part by ADR-0037` plus a line naming which half is retired would say it. Still not
fixed here, for the same reason as above: whether this corpus is amended or treated as historical is
a human's call, and ADR-0035 shows it has been amended before.
