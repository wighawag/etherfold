---
'@etherfold/core': patch
---

An ERC-721 and an ERC-20 in one source no longer refuse to construct a fetcher.

`LogEventFetcher`'s constructor ran its ambiguity guard over the MERGED event list of every contract, and that guard throws "ambiguous ABI" when one canonical signature is declared twice with different decoding shapes. Both standards declare `Transfer(address,address,uint256)` and `Approval(address,address,uint256)`, differing only in their `indexed` flags, so mixing the two in one source refused to construct at all. That took out `new IndexerGeneration(...)`, `captureStream` and the load and replay path over any such source, including this repository's own conformance workload (Stratagems as ERC-721 plus Gems and GemsGenerator as ERC-20).

The refusal now follows the DECODE path (ADR-0061). Per ADDRESS it is unchanged and unconditional, because within one address the ambiguity is real and undecidable. On the merged list it applies only where that list is what decodes a log: when no contract is declared per address, or when `parseAllEventsIrrespectiveOfAddresses` ignores the address. Otherwise a shared `topic0` with two shapes is tolerated, each declaration reachable only at its own address, and the shared `topic0` enters the fetch filter ONCE rather than throwing on the second sighting.

Which events EXIST is untouched, which is what ADR-0031 protects: every `topic0` is still requested on either path and nothing is spliced out of the filter.

Two honest consequences. Turning `parseAllEventsIrrespectiveOfAddresses` ON for such a source now REFUSES at construction, since with the address ignored the ambiguity is genuine. And a `LogParseConfig.filters` entry is keyed by event NAME, so on a tolerated collision one name covers one `topic0` and two indexed layouts: a filter constraining a position only one of them indexes (an ERC-721 `Transfer`'s token id sits in `topics[3]`, where an ERC-20 `Transfer` log has nothing) reaches the other address too and matches nothing there. That configuration was previously unreachable, because construction threw.
