---
'@etherfold/core': patch
---

A generation frozen with reason `stream-not-fetched` now says WHY in words that fit the situation. At a pointer move it is still "a revert across a filter change". At `open` (for example an `etherfold node` over a database a `run` wrote with a `--deployments` or `INDEXING_SOURCE` source its bundle does not carry) it now says the stored bundle resolves to a different stream than the one the generation was registered on, instead of describing a revert that never happened and a stream the idle node was not fetching. The `reason` code is unchanged.
