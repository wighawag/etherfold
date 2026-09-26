---
'@etherfold/server': minor
'etherfold': minor
---

A processor bundle can now be UPLOADED to a running node: `POST /{indexer}/admin/upload` takes the bundle's raw bytes on the admin credential and registers the generation they name as `successor` beside the incumbent, exactly as the re-read does. The incumbent goes on answering, the successor catches up, and the promotion policy moves the pointer (ADR-0085's amendment of 2026-09-22).

```sh
curl -X POST "$NODE/$INDEXER/admin/upload" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: text/javascript' \
  --data-binary @dist/processor.js
```

**Everything that can refuse happens before anything is registered**, so a refused upload leaves the registry, the slots and the held folds exactly as they were: `401` without the admin token; `415 upload-wrong-content-type` unless the body is declared `text/javascript`; `413 upload-too-large` over 16 MiB (`MAX_UPLOAD_BYTES`, exported beside `UPLOAD_CONTENT_TYPE`); and `409 upload-failed` for a bundle that is not self-contained, throws on evaluation, carries no processor or no contracts, or carries contracts that do not match a source the node was STARTED with (`--deployments` or `INDEXING_SOURCE`), named against each other. A node whose source came from its processor module takes an upload carrying different contracts as a successor on its new stream, as a re-read after a filter change does.

**The identity is the receiver's hash of the bytes** (ADR-0086), and the bytes are stored on the generation's row through the one registration path every Node generation takes (ADR-0092). The answer is the shared three-outcome report (`registered`, `unchanged`, `failed`) with `arrival: 'upload'`.

`@etherfold/server`: `IndexerRegistryEntry` gains an optional `upload(bundle)`, forwarded by `indexerEntryOn`; a host without it answers `501 upload-not-held`.

`etherfold`: `run` serves the route. `uploaderFor` builds the receiving arrival, and `arrivalQueue` is the one line a process's re-read and upload now share, so two arrivals never decide against one registry at once; `reconfigurerFor` takes that queue as an optional second argument.
