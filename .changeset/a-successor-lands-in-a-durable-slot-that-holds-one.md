---
'@etherfold/core': minor
'@etherfold/server': minor
'@etherfold/browser': patch
'etherfold': patch
---

**A generation is held by a durable named SLOT, and `canonical` is merely the first one** (ADR-0084). Registering a successor while one is already pending REPLACES it, and because the fact is a ROW rather than a memory, that holds ACROSS A RESTART -- so a deployment whose `version` is generated at build time stops accumulating one generation per deploy until a cap refuses it at start-up.

The registry now holds THREE assignments instead of one:

- **`canonical`** -- what answers every read. Unchanged: moving it is promotion, moving it back is revert.
- **`successor`** -- the generation being built beside the incumbent, holding AT MOST ONE. Registering into an occupied `successor` replaces its occupant, whatever stream either sits on, and the replaced generation is dropped: its registry row, its state namespace (ADR-0053 makes that a `DROP`) and its stream where no registered generation is left folding it.
- **`predecessor`** -- what a revert moves back to. ASSIGNED by the move that creates one, in the SAME commit as the pointer write, and never inferred -- because it cannot be inferred: with the pointer at C and a newer generation N, "N was never canonical" and "N was canonical and the pointer was reverted away from it" are the same rows.

**A slot is an ASSIGNMENT and never part of `GenerationId`.** The same content under two slots stays ONE generation, one state namespace and one fold of one stream, which is why the slots sit beside the records rather than inside the identity. A generation NO slot names, and that is not canonical, is collectable; the operator verb that reclaims one is `a-generation-no-slot-names-is-reclaimed-on-request` and is not in this change.

**This is a net DELETION of machinery.** `ReceivingIndexer`'s two in-memory sets are GONE rather than left beside the slot agreeing with it most of the time: `everCanonical` (which generations the pointer had named, as far as one process had seen) and `successorsAddedHere` (which generations this container had registered since it opened). What they approximated, a slot reads -- durably, for every process. Drop-on-promotion now applies to a move onto what `successor` names and to nothing else, which is strictly stronger in the direction ADR-0057 was worried about, since a restarted process no longer forgets and therefore no longer misreads a genuine promotion as a revert.

**The caps are UNCHANGED** (`SERVER_GENERATION_CAPS` is still four generations and two streams, `BROWSER_GENERATION_CAPS` still two of each), a cap still REFUSES and never evicts, and this is deliberately not cap-pressure eviction: a replaced successor is dead the moment a newer one takes the slot, whether the registry has room or not. The drop is still DECLINED, and said out loud, while the replaced generation WRITES a stream another held fold follows (ADR-0044); it then names no slot, so it is collectable rather than forgotten. Every replacement is reported through `named-logs`, naming what went, what took its place and why it was safe.

**API, `@etherfold/core`:** `GenerationRegistryState.canonical` becomes `GenerationRegistryState.slots`, and `GenerationRegistryWrite.canonical` becomes `GenerationRegistryWrite.slots`, where an absent slot name LEAVES that slot, `null` CLEARS it and an identity assigns it. `GenerationRegistry` gains `slots()` (every slot resolved against the records, in one read) and `create(id, {slot})`; `canonical()` is unchanged. New exports: `SLOT_NAMES`, `SlotName`, `GenerationSlots`, `SlottedGenerations`, `SlotAssignment` and `slotHolding`. A custom `GenerationRegistryPort` must carry the slots through; the three substrates in this repository do.

**API, `@etherfold/server`:** the `_generation_pointer` table is RENAMED to `_generation_slots` and carries a column pair per slot (`GENERATION_SLOT_TABLE` replaces `GENERATION_POINTER_TABLE`), so the promotion shuffle stays one guarded write (ADR-0054). `HeldGenerations` gains `slots` beside its `canonical`. `SCHEMA_VERSION` stays 1 and NO migration is provided, deliberately: nothing is published and no database anywhere holds state this must preserve (`CONTEXT.md`), and `predecessor` could not be reconstructed for a registry that predates slots anyway -- the missing fact this change exists to supply is the one its own migration would need.

**`@etherfold/browser`** carries the IndexedDB substrate's half: one small record per slot beside the entries (`['generation', <name>, 'successor']`), outside the entry key range. The chain-facing `Indexer` is deliberately UNCHANGED and still keeps its in-memory `everCanonical` flag; porting slots to it is `the-chain-facing-container-holds-its-generations-in-slots`. Promotion still arms from the in-memory candidate set; arming from the slot is `promotion-arms-from-the-slot-so-a-restart-can-finish-an-upgrade`.

**`etherfold`** carries no code change: the behaviour is asserted at the seam it actually lives at, which is one container over a REAL database plus a SECOND CONTAINER opened over the same substrate to stand in for the restart (`packages/cli/test/aSuccessorLandsInADurableSlot.test.ts`). That file replaces `anAbandonedSuccessorIsDropped.test.ts`, whose last case asserted the residual this removes.
