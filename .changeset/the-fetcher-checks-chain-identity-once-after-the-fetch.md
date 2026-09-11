---
'@etherfold/core': patch
---

The split deployment's `LogFetcher` makes ONE `eth_chainId` call per cycle instead of two, and it is the one AFTER the fetch (ADR-0081).

`fetchAndPush` opened every cycle with a chain-identity assertion and made a second one between the fetched range and the push. The pair looked symmetric and was not: only the AFTER call is a guard, because the window that can corrupt anything is the fetch itself, where chain B's logs would cross the wire under chain A's `{source, config}` and be indexed as ours by a receiver that makes no chain calls at all (ADR-0003) and so cannot check. The opening call only failed fast (it saved a wasted range when the provider had already moved between cycles) and caught nothing the surviving one does not. It is deleted, so every fetch cycle costs one fewer round trip with nothing new configured and nothing left undetected.

**What changes for a caller:** a provider serving the wrong chain is still refused with `UnexpectedChainError` and still pushes nothing, but the range is now fetched before the refusal rather than skipped by it, and the fetcher holds no cursor, so the next cycle asks the receiver and re-derives the same range. A provider that moves DURING the fetch is refused exactly as before. A host counting a cycle's chain calls sees `eth_getLogs` then `eth_chainId`, in that order.

`UnexpectedChainError`'s exported signature is unchanged: it still takes the expected chain, the actual one and which side of the fetch caught it. `'before'` is no longer reachable from a fetch cycle, and narrowing the constructor would be a breaking change on an exported type that buys nothing, so the parameter keeps both values and says so.

The surviving call is unconditional and has no flag; making it optional was proposed and withdrawn, because nothing has measured its cost and it is the only chain-swap detection this deployment shape has.
