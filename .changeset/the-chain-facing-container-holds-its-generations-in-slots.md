---
'@etherfold/core': minor
---

**The chain-facing container holds its generations in DURABLE NAMED SLOTS too, so a browser tab reconfigured all afternoon never meets its cap of two** (ADR-0084).

`Indexer` (`container.ts`, what a browser tab runs) registered every generation added beside the live one with no slot, and told a PROMOTION from a REVERT with an in-memory `everCanonical` boolean on the held entry. Both are replaced by the row the receiving twin already reads:

- **`add` registers into `successor`**, which holds AT MOST ONE, so a second save REPLACES the first pending successor instead of adding a second nobody retires. What it replaced is DROPPED — its registry row, its state store (`dropState`) and its stream where no registered generation is left folding it — unless dropping it would leave a fold following a stream nothing appends to (ADR-0044), in which case it is retained, named by no slot, and goes on the next registration that moves off its stream.
- **Because the slot is a ROW, a RELOAD replaces what it finds there** having registered nothing and remembered nothing. That is the case no in-memory rule could reach, and it is the one a browser lives in: a page reload is a fresh process with an empty memory.
- **`everCanonical` is DELETED.** Whether a pointer move is a promotion is now read from the `successor` slot before the move applies, exactly as `ReceivingIndexer` reads it, so drop-on-promotion no longer misreads a genuine promotion as a revert after a reload. It is also strictly more conservative in the destructive direction: promoting a generation no slot names now drops nothing.

**What is shared and what is repeated.** One pure function is shared, `displacedBySuccessor` (exported from `@etherfold/core`): what a registration into `successor` displaces, including the clause the whole rule is safe on — a generation any OTHER slot names is untouchable, which covers the incumbent and the revert target together. The ACTION is repeated in each container and worded alike, because stopping an engine and stopping a receiver are different acts on different runtimes.

**The caps are UNCHANGED, and what they mean under three slots is arithmetic worth knowing.** At `BROWSER_GENERATION_CAPS` (two of each) a tab holds `canonical` + `successor` — the reconfigure loop, which this makes unbounded — or `canonical` + `predecessor` — the revert window a promotion opens — and never all three. A registration that would need all three meets `maxGenerations` and is REFUSED, exactly as it was before this change. The revert target is never dropped to make room: an eviction picks a victim by a policy that cannot know which generation was being kept, and the re-index it costs may not be available at all from a public node.

**If you drive `Indexer` yourself:** nothing in the API changed, and a host holding one generation sees no difference. A host opened with SEVERAL generation specs now puts every one after the first into `successor`, so the LAST spec in the list is the pending successor and the ones between are replaced and dropped as they are added.
