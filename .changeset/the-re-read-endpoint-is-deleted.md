---
'@etherfold/core': minor
'@etherfold/server': minor
'etherfold': minor
'@etherfold/browser': patch
'@etherfold/utils': patch
---

The re-read endpoint is DELETED (ADR-0094): code reaches a running Node process only by an UPLOAD to `etherfold node`, and a configured `etherfold run` changes its code by restarting. The dev loop is `etherfold node` plus a watcher that calls `etherfold upload` on each build.

`@etherfold/core`: `ReconfigureArrival` loses its `re-read` value and is now `'upload' | 'hot-update'`. `ReconfigureReport` keeps its name.

`@etherfold/server`: `POST /{indexer}/admin/reconfigure` is gone from every host (it now answers as a route that does not exist), together with its `reconfigure-not-held` and `reconfigure-failed` answers and the `IndexerRegistryEntry.reconfigure` seam. The upload route documents the three answers and the `409` it spends on a failed arrival on its own account.

`etherfold`: the reconfigurer is deleted with its exports (`reconfigurerFor`, `ReconfigureContext`) and `PreparedIndexing.reconfigure`. `arrivalQueue` and `ArrivalQueue` are kept (the upload's arrivals still wait in one line) and are now exported from their own module. The `--promotion` rationale, the `--override` help and the `build` / `index` promotion refusals no longer cite the deleted route: `run` takes `--promotion` because a successor registered at START still catches up while it runs, and `node` because uploads register successors while it runs.

`@etherfold/browser`: documentation only. `reconfigureFromHotUpdate` answers the same `ReconfigureReport` the upload route answers, now one of two arrivals.

`@etherfold/utils`: a comment only.
