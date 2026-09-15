---
status: proposed
---

# A generation is held by NAMED DURABLE SLOTS, and `canonical` is merely the first one

A registry holds generations keyed by CONTENT (`GenerationId` is `{stream, processor}`) and exactly one durable named pointer at them, `canonical`. Every other lifecycle question -- which generation is a pending successor, which is dead work, which a revert returns to -- is answered in MEMORY, by what one container has done since it opened. We propose to record that a generation is held by a small set of DURABLE NAMED SLOTS, of which `canonical` is simply the one that already exists: a slot is an assignment pointing at a generation, `successor` holds at most one so registering into it REPLACES what it held, `predecessor` is what a revert returns to, and a generation no slot names is dead.

## One missing fact, showing up as four separate bugs

The registry records THAT a generation is not canonical and never WHY. Four independent problems are that one gap:

**The abandoned-successor predicate could not be durable.** `a-successor-that-was-never-canonical-is-superseded` needed "has this generation EVER been canonical" and found the durable answer does not exist: the row is `{stream, processor, createdAt}` and nothing more, and it cannot be derived, because with the pointer at C and a newer generation N, "N was never canonical" and "N was canonical and the pointer was reverted away from it" are indistinguishable from the rows. It narrowed to what one process can honestly answer, and the code states the residual: across a restart nothing is recognised as abandoned, so nothing is dropped.

**That residual becomes a start-up outage once `version` is generated.** `assertProcessorVersion` already tells authors to generate it ("ideally generated, so it changes whenever the code does"). Then every build is a new identity, so every restart registers a new generation; `maxGenerations` is four; and a cap REFUSES at `open`. A deployment redeploying per commit stops STARTING on about the fourth deploy, with no remedy but deleting generations by hand.

**The promotion policy is silently inert on every path but one.** `open()` adds the fold the host was built with and only THEN sets `opened = true`; `add()` ends in `applyPolicyTo`, whose first line is `if (!this.opened) return`; `settlePromotion()`'s first line is `if (this.candidates.size === 0) return`. So a generation arriving at open is never armed and therefore can never be promoted -- not late, ever. Restarting with a changed processor leaves the incumbent canonical permanently, and on `index` the successor is not even advanced (`an-index-process-can-never-finish-a-processor-upgrade`). The gate's reasoning is sound and is exactly this ADR's subject: applying the policy at open would let `immediate` promote whatever the host was built with, and `on-catch-up` undo a revert recorded in a previous session. Telling a deliberate revert from a fresh successor needs the missing fact.

**The armed-candidate set has to be in memory.** `candidates` is documented as deliberately not "every non-canonical generation", because that rule would re-promote a successor on the cycle after a revert. It is the same distinction again, kept in memory because nothing durable carries it.

A slot carries it. `successor` names a generation meant to take over; `predecessor` names one a revert returned to; the difference is read rather than inferred, by any process, after any restart.

## What a slot is, and what it is not

A slot is an ASSIGNMENT: a durable name pointing at a generation, exactly as `canonical` already is. It is NOT part of the identity. The same content under two slots must remain ONE generation, because identity is content-addressed for reasons ADR-0053 and ADR-0036 record, and a slot inside `GenerationId` would fork one fold into two namespaces both folding the same stream.

- **`canonical`** -- what answers every read. Unchanged; this ADR renames nothing that exists.
- **`successor`** -- the generation being built beside it, and the only thing auto-promotion promotes. Holds AT MOST ONE: registering into an occupied `successor` replaces its occupant, whatever stream either sits on.
- **`predecessor`** -- what a revert moves back to, which is what retention after a promotion is for.

A generation no slot names, and that is not canonical, is GARBAGE and may be collected. That is a refcount, and far easier to prove safe than the three-way in-memory predicate it replaces.

## Naming, which is a decision and not a detail

The working name through the design discussion was `staging`, and it is rejected for two specific reasons rather than taste. It collides with this repo's own protocol vocabulary, where STAGING is the review-first position of `work/tasks/backlog/`. And the industry meaning actively misleads: a staging ENVIRONMENT is one you deliberately do not promote automatically, whereas this slot's defining property is that it is exactly what auto-promotion promotes.

`next` was considered and rejected because "the next generation" is unavoidable in this domain's prose and reads as "the following one in a listing", so the slot name would be ambiguous in every sentence it appears in. `candidate` was considered and rejected because it is taken by the in-memory armed set that this replaces, and one word meaning both a thing and its replacement is the collision `a-successor-that-was-never-canonical-is-superseded` refused when it declined to reuse `superseded` and `retired`.

`successor` and `predecessor` are chosen because they are ALREADY the words the prose and the ADRs use for exactly these two roles ("a successor is registered beside the incumbent"; "the incumbent becomes the predecessor and is RETAINED, because the pointer must be able to move back to it"). The three slots therefore introduce no new vocabulary at all: they promote three existing nouns to durable names. The residual to watch is a host using hash-named slots for several coexisting successors, where a generation can be conceptually a successor while not being in the `successor` slot; those are named by their slot rather than called successors.

## Considered options

**A durable `everCanonical` column**, which `a-successor-that-was-never-canonical-is-superseded` weighed and rejected. It answers a harder question than the one that needs answering, costs a field plus a migration across the SQL, IndexedDB and memory substrates plus the conformance surface, forces a decision about what legacy rows default to (and "never canonical" would make the first pass eligible to delete precisely the predecessor a revert wants), and amends ADR-0046 and ADR-0057. Decisively it would still not bound restart accumulation, and still not tell a deliberate revert from a fresh successor at open: knowing a promotion from a revert is not knowing what a generation is FOR.

**The in-memory narrowed predicate**, which is what shipped. Correct, and mostly unnecessary under slots: what it infers, a slot reads.

**Raising the caps.** Moves the wall, which is the argument `SERVER_GENERATION_CAPS` already makes against itself.

**A slot as part of `GenerationId`.** Rejected above: it would make one fold into two.

## Consequences

**The cap stops being load-bearing without being removed.** `open` no longer grows the count (it finds the pointer already names its fold, or replaces what `successor` holds), so the start-up refusal becomes unreachable on the default path. The cap survives as a backstop on the deliberate opt-in of several coexisting successors, which is what a cap is for. It should NOT be removed: `BROWSER_GENERATION_CAPS` guards a storage quota whose overflow surfaces as an error at an arbitrary write, which is a worse failure than a refusal at registration. What is missing beside it is an operator verb for "what is held, and reclaim what no slot names".

**The `opened` gate can key on the slot instead of on arrival.** Arm what `successor` names; never arm what `predecessor` names. The restart path then gets the documented promotion behaviour while the hazard the gate exists to prevent stays prevented, so the gate's reasoning is honoured rather than reversed. This removes the correctness cliff where a restarted deployment waits for ever for a promotion that cannot happen.

**The in-memory `candidates` set collapses into the slot**, since the candidate for promotion IS what `successor` names, subject to the policy. Together with the abandoned-successor predicate, three in-memory structures reduce to one durable fact.

**The default must be the `successor` slot, not a slot per identity.** A default of "each identity gets its own slot" reproduces today's unbounded accumulation exactly. Hash-named slots are the deliberate opt-in, which is also the honest answer to the cross-stream question that `a-successor-that-was-never-canonical-is-superseded` answered by fiat.

**The safety obligation moves and gets easier.** It becomes: replacing what `successor` holds must be provably unable to touch `canonical` or `predecessor`. That is a statement about one slot, assertable directly, rather than a conjunction of three in-memory facts.

**No upgrade path is provided, deliberately.** A registry predating slots holds generations no slot names, and `predecessor` could not be reconstructed for them: which generation a revert would want is exactly the fact that was never recorded, so the missing fact this ADR exists to supply is also the one its own migration would need. That is moot rather than unsolved. Nobody runs these packages, every consumer is a repository we own, and `CONTEXT.md` records this as a standing convention, so the correct shape is built directly and no persisted state is carried forward. This consequence is the one to revisit if slots land after something outside our repositories holds state.

**Reaping follows the generation, unchanged.** Replacing a successor that was the last registered on its stream reaps that stream, which is already what `deleteGeneration` does and already why a drop is declined while another held fold follows the stream.
