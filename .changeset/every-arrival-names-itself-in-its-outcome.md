---
'@etherfold/core': minor
'@etherfold/server': minor
'@etherfold/browser': minor
'etherfold': patch
---

Every processor arrival now names itself in the outcome it reports.

`ReconfigureReport` (`@etherfold/core`) carries a REQUIRED `arrival` field on all three arms, typed `ReconfigureArrival = 're-read' | 'upload' | 'hot-update'`. The three outcomes (`registered`, `unchanged`, `failed`) are unchanged and stay three: the arrival sits BESIDE the outcome rather than becoming a fourth one, so a watcher still branches on one contract while a log can tell "the endpoint said unchanged" from "HMR handed us the same module". The values name what arrived, not the package that received it.

- `POST /{indexer}/admin/reconfigure` (`@etherfold/server`, served by `etherfold run`'s re-read) answers `arrival: 're-read'` on all three outcomes, including the `409 reconfigure-failed` refusal and a host that threw.
- `reconfigureFromHotUpdate` (`@etherfold/browser`) reports `arrival: 'hot-update'`.
- `'upload'` is declared for the upload route (ADR-0085's amendment of 2026-09-22) and nothing produces it yet.

Breaking for anything that constructs a `ReconfigureReport` itself: it must now state its arrival.
