---
'@etherfold/core': patch
---

The in-process engine's cycle makes ONE `eth_chainId` call instead of two, and it is the one AFTER the fetch (ADR-0081).

`promiseToIndex` bracketed every log fetch with two identity calls and refused the cycle if either answer was not the chain the source names. The pair looked symmetric and was not: only the AFTER call is a guard, because the window that can corrupt anything is the fetch itself, where logs from chain B would be folded into chain A's stream and written to its cache. The BEFORE call only failed fast (it saved a wasted range when the provider had already moved between cycles) and caught nothing the after call does not. It is deleted, so every cycle costs one fewer round trip, in every deployment, with nothing new configured and nothing left undetected.

**What changes for a caller:** a provider that moved BETWEEN cycles is still refused and still folds nothing, but the range is now fetched before the refusal rather than after, and the cursor does not move either way, so the next cycle re-derives the same range. A provider that moves DURING the fetch is refused exactly as before.

The surviving call is unconditional and has no flag; making it optional was proposed and withdrawn, because nothing has measured its cost and it is the ONLY chain-swap detection that exists. The `chainChanged` event the old comment promised was never built: no listener exists anywhere, `EIP1193ProviderWithoutEvents` cannot structurally carry a subscription, and an asynchronously delivered event could not replace a check that runs at a known point, after the fetch and before anything is applied. The comment beside the surviving call now says that instead of promising a second line of defence.
