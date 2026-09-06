---
'@etherfold/core': patch
---

An unfiltered event is still requested when another event is filtered

Configuring `parse.filters` for even one event silently stopped every OTHER event being fetched, whenever two or more events were left without a filter. Their logs were never asked for, so nothing downstream could tell "the chain had none" from "we never asked".

An `eth_getLogs` topics array is POSITIONAL: slot 0 is the event selector, every later slot constrains an INDEXED ARGUMENT, and an array WITHIN a slot is an OR list. The shared request for the unfiltered topic0s was built by pushing them FLAT into one array, so `{topics: [approvalSelector, approvalForAllSelector]}` asked for a log whose selector is `Approval` AND whose first indexed argument equals the `ApprovalForAll` selector. Nothing can satisfy that, and a node answers it with an empty result rather than an error. They are now emitted NESTED in slot 0, which is what the no-filter path already did.

WHO IS AFFECTED, and what to do. Any deployment that set `parse.filters` and left two or more event topic0s unfiltered has a stream with those events missing from it, from the first block it indexed. An ordinary ERC-721 filtered on `Transfer` lost `Approval` and `ApprovalForAll` entirely. The stored logs are wrong rather than merely stale, so the remedy is to re-index that stream rather than to resume it. With exactly ONE unfiltered topic0 the flat form was accidentally correct and nothing was lost.

The test helper that could not see this is fixed too: `topicsRequested` read `request.topics?.[0]` alone, so a flattened conjunction read back as a single topic0 and the extra positional constraint was invisible to every assertion in a file whose subject is that an event is never silently dropped. It now reads the whole topics array and refuses a request carrying an event selector below slot 0.
