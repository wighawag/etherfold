---
'@etherfold/core': minor
'@etherfold/browser': patch
---

**A generation the CHAIN-FACING container holds NO FOLD for is COLLECTED when a registration needs room** (ADR-0090, point 3). On that runtime a record no slot names, that no fold exists for and that is not canonical, goes when a save arrives. On the RECEIVING container (server, CLI) nothing changes at all: collecting one there is still the operator's `reclaim` verb and nothing else (ADR-0084).

**The case.** A tab promotes, the page reloads, and the new bundle carries one processor. The superseded generation is then a row nothing can run: its code is absent from the build, so it can never answer a read and can never fetch. Measured, it survived every session and the developer's next save was REFUSED with `GenerationCapReachedError` behind a wall no page reload could clear. It is now collected and the save lands.

**It is collected at a REGISTRATION and at no other moment.** Nothing fires on a timer, nothing sweeps at `open`, and no background deleter is added: a tab that promotes, reloads and then sits there indexing collects nothing, because the fold it arrived with is the one `canonical` already names and so displaces nobody. The deletion is a consequence of an act the developer just performed, which is what ADR-0084's refusal of an automatic reclaim was about. The STREAM is kept (ADR-0087), so supplying the old code again derives the same identity (ADR-0086) and re-folds bytes already on disk.

**The IN-SESSION case is unchanged.** A same-stream save loop still retains the superseded generation and still meets the cap, because that generation is HELD and is the FETCHER of the stream the arriving fold is on (ADR-0044). Moving the fetch duty at the promotion is ADR-0090's points 1 and 2 and lands separately; `dropOnPromotion`, the promotion path and the caps are untouched here.

**Two API changes in `@etherfold/core`.** `displacedBySuccessor`'s fourth argument is now an object, `{heldHere, unheldIsCollectable}`, both stated by the caller: the chain-facing container passes `true`, the receiving one `false`. And `Indexer.wouldStrandAFollower` derives the stream's fetcher from the records this container HOLDS A FOLD FOR rather than from every registered record, which is ADR-0088's PRESENT-not-REGISTERED rule applied to the second of the two sites that ask it (recorded as a dated amendment on that ADR). The in-session decline is unaffected: there the superseded generation is held and is the oldest fold present.
