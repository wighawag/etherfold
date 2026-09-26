---
'etherfold': minor
'@etherfold/server': patch
---

**`etherfold upload` deploys an already-built processor bundle to a running node, and exits non-zero on anything short of a registration** (ADR-0085).

```sh
ADMIN_TOKEN=… etherfold upload ./dist/processor.bundle.js --to http://indexer:2000 --indexer my-indexer
```

It is the SENDER half of the upload: it reads the bundle, sends its raw bytes to the node's `POST /{indexer}/admin/upload` (`Content-Type: text/javascript`, `Authorization: Bearer <ADMIN_TOKEN>`) and prints the outcome the node answered, as `key: value` lines naming the outcome, the arrival and the generation. It never builds.

- **Exit codes.** `0` on `registered` and on `unchanged` (an honest "already deployed" does not fail a pipeline). `1` on everything else: a missing or refused input, a bundle that is not self-contained, `401`, `413`, `415`, `409 upload-failed`, `501`, any other status or body, and a node that cannot be reached.
- **The commonest mistake fails locally.** A path naming an entry point, or a build that has not run, is refused before any request by the same check and message `--processor` gives (`refuseUnbundledProcessor`, which now also resolves to the bytes it judged, so what is sent is exactly what was checked).
- **Inputs, from the one configuration table** (ADR-0048's 2026-09-26 amendment): the bundle as the argument (or `-p`, not both); `--to` / `UPLOAD_TO`, a new input and deliberately never `-n` / `ETH_NODE_URI`, which is the chain's endpoint; `--indexer` / `INDEXER_NAME`, REQUIRED and never defaulted here; `--admin-token` / `ADMIN_TOKEN`. Every other input is refused with the reason, and `--to` / `--admin-token` are refused on the other five commands.
- New exports: `upload`, `uploadMain`, `describeUpload`, `uploadRouteOf` and the `UploadAnswer` / `UploadDependencies` / `UploadedGeneration` / `UploadConfig` types; `CommandName` gains `'upload'`, and `ConfigInput` gains `'to'` and `'adminToken'`.

`@etherfold/server`: the admin API's documentation no longer says the command set is pinned at five verbs (ADR-0057's 2026-09-26 amendment). No behaviour changes.
