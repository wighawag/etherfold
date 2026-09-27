---
'@etherfold/browser': minor
'@etherfold/core': minor
'@etherfold/server': patch
---

A tab can start from a PUBLICATION INDEX (`publication.json`, ADR-0095), the document `etherfold publish` and `build --publish` write.

`@etherfold/browser`: `createIndexerState` takes a `publication: {locations, seed?, fetch?}` option. At `init` the hook reads the first index any location serves (failing over on a location that does not answer or serves something that is not an index), and picks the STATE SNAPSHOT entry for the generation it builds, by its stream digest AND its processor identity. The entry is handed to `createState` as a new fourth argument (`published: {locations, processor, entry, index}`), which starts from it through the existing bootstrap: `openAndBootstrap(backend, published.locations, {processor: published.processor})`. The STREAM SEED the index lists for this stream is installed into `keepStream` only when `publication.seed` asks for it (`true`, or the install's own knobs); by default no seed is fetched. `publication.seed` beside the `seed` option is refused at `init`. What the lookup gave is published on a new `syncing.publication` field: `reading`, `found` (the index, the body, the block), or `refused` with a reason, `unreachable`, `unreadable-format`, `no-entry`, `stream-mismatch` (an entry for this processor over another stream only, named in `streams`; nothing beyond the index is fetched) or `no-processor-identity` (a module arrival, which has no identity before its state is built). A refusal never gates the boot: the tab indexes from the chain as it does with no snapshot. `readPublicationIndex`, `publishedSnapshotFor` and `publishedSeedLocationsFor` are the same lookup for an app that drives it itself.

`@etherfold/core`: exports the publication index document, `PublicationIndex`, `PublishedStateSnapshot`, `PublishedStreamSeed`, `PUBLICATION_INDEX_NAME`, `PUBLICATION_INDEX_FORMAT`, `isPublicationIndex`, and `publishedBodyLocation` (a body named relative to its index, including at a hostless, build-embedded path), so the producer and a tab read one definition.

`@etherfold/server`: the publication index types and constants are now re-exported from `@etherfold/core`, and `parsePublicationIndex` checks the document with core's `isPublicationIndex`. No behaviour changes.
