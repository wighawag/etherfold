---
status: superseded in part by ADR-0061
---

# Duplicate events are keyed on `topic0`, and only a `topic0` collision is refused

> **SUPERSEDED IN PART by ADR-0061, on WHERE the refusal is evaluated.** The key is still `topic0` and never the NAME, identical declarations are still collapsed, the per-address refusal is unchanged, and a parse-config flag still may not decide WHICH EVENTS EXIST. What ADR-0061 replaces is "the same rule on every list": the refusal on the MERGED list is now conditional on that list being what DECODES a log, because `decodeOnto` resolves the ABI by the log's ADDRESS. The one clause below that is WITHDRAWN is "the verdict must not depend on `parseAllEventsIrrespectiveOfAddresses`" -- the REFUSAL verdict now may, and does; the EVENT SET still may not, which is what that clause was defending.

`LogEventFetcher` de-duplicates its ABI list on the canonical event SIGNATURE (so on `topic0`, which is its hash) rather than on the event NAME, and the same rule runs on every list it builds: two events with different `topic0`s are BOTH kept and both requested; two declarations of one `topic0` are collapsed if they decode identically and REFUSED at construction if they do not. What a log carries is `topic0`, so the name was never the thing that made two events the same or different, and the verdict must not depend on `parseAllEventsIrrespectiveOfAddresses`, which decides which ABI decodes a log and must never decide which events exist.

## Considered options

**Refuse a name clash on both paths** (make the global list throw the way the per-address merge did) was the other way to get one rule. Rejected: `Transfer(address,address,uint256)` and `Transfer(address,address,uint256,bytes)` are different topic0s, trivially told apart on the wire, and both legal at once: at an upgrade block both can occur, because the upgrade transaction sits mid-block and a transaction before it still fires the old event. Refusing them would make a contract that changed an event signature un-indexable at all, and it is the accept-both direction that lets `abi-versions-are-block-ranged` exist.

**Keep the flag and pick a default** was rejected on the same ground the whole defect rests on: a parse-config flag deciding which events exist is what made "no logs found" indistinguishable from "we never asked".

**Comparing declarations with a whole-object equality** (what the old per-address path did) was rejected because `internalType` is a Solidity-side annotation two compilations of the same event routinely disagree about, and this refusal stops the indexer starting. Declarations are compared on what decoding READS: parameter names, types, `indexed` flags, tuple components, and `anonymous`.

## Consequences

An ABI that previously lost an event silently now indexes it, so the fetch filter widens and a deployment sees logs it was never asking for; that is the fix, not a regression, but it is a behaviour change on existing sources. An ABI whose two declarations share a `topic0` and differ (typically the same signature with different `indexed` flags) now fails at construction instead of being truncated. And because a filter list in `LogParseConfig.filters` is keyed by event NAME, it applies to every `topic0` that name covers.
