---
'@etherfold/state-store': patch
---

`readSnapshot` installs a state snapshot whether its host served the `.gz` body opaque or with `Content-Encoding: gzip` (already inflated by the runtime). It decides from the body's first two bytes, the gzip magic, peeked off the stream so the install stays chunk by chunk, and peels exactly one gzip layer: a body gzipped twice, and a format-1 plain-JSON document, are still refused with `SnapshotFormatError`. Before this, an already-inflated body failed to inflate and `bootstrapFromSnapshot` / `openAndBootstrap` answered `not-bootstrapped / unreadable-format`, so an app under `vite dev` silently indexed from the start block.
