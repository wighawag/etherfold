---
'@etherfold/state-moved-conformance': minor
'@etherfold/browser': patch
'@etherfold/server': patch
---

An APPLIED block that touched NOTHING is a notification with an empty set, on every transport, and the suite now says so.

ADR-0083 makes "one notification per APPLIED block" ONE rule: a block whose handlers mutated nothing was still applied, its cursor still moved with it, so what crosses is an append naming it with `entities: []`. A transport is exactly where that gets quietly turned into two rules, because an empty array reads like nothing worth posting — and a reader that is not told cannot tell a fold that touched nothing from a fold that has STOPPED. The transport conformance suite asserted the empty case only as a TYPE (`entities` is an array of strings, of any length); it now drives one and asserts the value.

`StateMovedTransport` gains a required `applyNextEmptyBlock()`: make the canonical fold apply a block that touches no entity, and answer which block that was. REQUIRED rather than optional, because all three transports can produce one and a capability-driven case that can select nothing is how a suite becomes decoration — the same rule the claim-driven convergence chapter already follows. What produces it is a handler taking a branch it did not take (a burn the fixture's processor does not track), which is the ordinary shape of an empty changed-set and is deliberately NOT a block carrying no logs: that applies no block at all and correctly publishes nothing, since there is none to name.

The new case pins the whole reader consequence rather than only the payload: the notification carries the full five fields, its changed-set is empty, the coherence token has NOT moved (an empty block is an append, so nothing a reader holds became stale), and the two-line rule's narrow line therefore runs and yields nothing to re-read. Publishing it costs a reader nothing; withholding it costs it the truth. A `runStateMovedConformance` case asserts a transport that SWALLOWS an empty notification fails this case by name, so the case cannot rot into one that passes on a transport that drifted.
