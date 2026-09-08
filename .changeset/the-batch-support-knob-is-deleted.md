---
'@etherfold/core': minor
'@etherfold/fetcher-host': minor
'@etherfold/platform-nodejs-fetcher': minor
---

**A DOCUMENTED DEPLOYMENT VARIABLE IS REMOVED, not an internal flag.** `PROVIDER_SUPPORTS_ETH_BATCH` was an environment variable `platforms/nodejs-fetcher` documented in its configuration table, and it is gone from that table, from `@etherfold/fetcher-host`'s resolved config and overrides, and from `@etherfold/core`'s `ProvidedIndexerConfig` and `ProvidedLogFetcherConfig` as `providerSupportsETHBatch`. An operator who sets it now sets nothing: it is ignored like any other unrecognised variable, with no warning, no alias and no deprecation period, on the same ground as `STREAM_ALWAYS_FETCH_TIMESTAMPS` before it (CONTEXT.md: nothing is published, so backward compatibility with what was released is not an obligation, and a variable that is read and ignored is indistinguishable from one that works).

**Why it buys nothing any more.** The knob existed so the per-hash block and transaction fetches could go out as ONE batched request instead of N. Those fetches are DELETED (ADR-0073), so the engine's whole chain-facing surface is one `eth_getLogs` per range, one `eth_blockNumber` for the tip and one `eth_chainId` for the identity guard: there is no request left that a batch could carry, and therefore nothing for a deployment to tell the engine about its provider's batch support.

**This is NOT a re-prohibition of batch RPC.** A caller's provider may batch whatever it likes, transparently, and the engine neither knows nor cares. ADR-0002's consequence bullet is rewritten to say exactly that rather than deleted, because a bullet that simply disappeared would read as a reversal of the correction it was written to make.

**No stream forks and no history is re-fetched.** The flag was a SIBLING of `stream` rather than a member of it, so it was never part of the resolved stream config and never in the digest taken over it. Unlike the `stream` flags removed alongside it, this one is digest-neutral for every deployment, including one that set it.
