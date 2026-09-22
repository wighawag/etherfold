---
title: 'A promotion on the chain-facing container assigns no `predecessor`, because a tab can never run one'
slug: a-promotion-in-a-browser-tab-assigns-no-predecessor
blockedBy: []
covers: []
---

> **DRIFT CORRECTION (2026-09-22): THIS TASK WAS RE-SCOPED AFTER A MEASURED STOP. READ THE ANSWERED SIDECAR FIRST; IT IS AUTHORITATIVE WHERE IT DISAGREES WITH THE TEXT BELOW.** A previous build implemented this decision in full, measured it, and found that BOTH wins ADR-0089 claims are false, for one shared reason: the ADR assumes UNSLOTTED implies COLLECTED, and on the chain-facing container nothing collects an unslotted generation. **Acceptance criterion 5 is OVERRIDDEN** (it is replaced, not deleted, by two assertions covering the cross-stream and same-stream cases), and ADR-0089's body is corrected IN PLACE rather than amended. The task is otherwise unchanged and still in scope. The deferred half, what collects an unslotted generation on this runtime, is out of scope and carried by the observation `an-unslotted-generation-on-the-chain-facing-container-is-collected-by-nothing`.

## What to build

ADR-0089, implemented. Read it first: it is short, it is the decision, and it carries the argument this task does not repeat.

**The rule.** A pointer move on the CHAIN-FACING container (`Indexer`, a browser tab) assigns no `predecessor`. The generation the pointer moved off becomes UNSLOTTED and is collectable like any other generation no slot names. On the RECEIVING container (server and CLI) nothing changes: `predecessor` is assigned exactly as it is today, and a revert there still works exactly as it does today.

**Why, in one line, so you can tell a correct implementation from a plausible one:** in a browser the code that a predecessor's fold needs is not in the build, so the slot names something the tab is structurally unable to instantiate.

**Where the assignment actually is, and the constraint that makes this more than deleting a line.** It is in the shared registry, not in either container: `moveCanonicalTo` (`packages/core/src/generation/registry.ts`) drafts `{canonical: ...}` and adds `slots.predecessor = identityOf(movedOff)` in the SAME commit. That atomicity is deliberate and the registry's own comment says so. **So this must be a move that never drafts the assignment, not a move followed by a clear.** A second act can fail on its own and leave the slot populated, which is the state this task exists to make unreachable.

**Where the runtime's answer lives is yours to decide, and one place is ruled out.** It must be readable at the moment of the commit. It must NOT be added to `GenerationCaps`: that type is documented as "A COUNT of generations or streams an indexer may hold. Never *retention*", and a policy boolean in it would be the second thing that type means. `openGenerationRegistry(port, caps)` is where the runtime difference is supplied today, which is a reasonable place to look, but the shape is your call. Record it in `## Decisions`.

**Check the premise before you build, because this task rests on one.** ADR-0089 argues the slot is valueless in a browser partly because `GenerationRegistry.create` RESOLVES an identity it already holds rather than registering a second one, so supplying the old code again lands on the same generation record. Confirm that is still true. If it is not, the revert story in a browser is worse than the ADR believes and that is a finding worth stopping for.

## Acceptance criteria

- [ ] A promotion on the chain-facing `Indexer` leaves the superseded generation named by NO slot, asserted on the slots the registry actually holds after the move.
- [ ] The move remains ATOMIC: there is no observable state in which the pointer has moved and a `predecessor` is still assigned, and no second write is issued to clear one. A test that only checks the end state does not cover this; assert that the move itself drafts no such assignment.
- [ ] A promotion on the RECEIVING container still assigns `predecessor` exactly as it does today, and a revert on that runtime still works. This is the criterion that catches a fix applied in the shared registry with no runtime distinction.
- [ ] The superseded browser generation is COLLECTABLE and is not deleted on the spot: this task adds no new deleter, and ADR-0087's removal of the automatic reap is untouched.
- [ ] A tab at `BROWSER_GENERATION_CAPS` can now save repeatedly without meeting the cap on a third seat. The registration that previously failed with `GenerationCapReachedError` because a `predecessor` held the second slot is the case to assert; the cap itself is UNCHANGED and a genuine third generation must still be refused.
- [ ] `CONTEXT.md` states the rule, and its generation-slot entry stops saying a browser tab holds `canonical` + `predecessor` after a promotion, since that is no longer reachable. The arithmetic paragraph about what a cap of two means needs rewriting rather than deleting: it is teaching something real and the numbers changed.
- [ ] ADR-0084 is amended to record that `predecessor` is assigned by the receiving runtime only. Its three slots and their meanings are unchanged; do not rewrite the decision, add the dated amendment this repo already uses.
- [ ] ADR-0089's `status: accepted, not yet implemented` line is REMOVED, and only if the decision is actually implemented. The correct end state is NO status line at all, because `work/protocol/ADR-FORMAT.md` says an absent status means accepted and current. Do not invent a value: `accepted, implemented` is not one of its seven and a previous build in this repo had to have it reverted.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

None -- can start immediately. ADR-0089 is landed and ADR-0088's fix is already in.

## Prompt

The goal is that a browser tab stops reserving a seat for a generation it could never run, and that the server keeps its revert window untouched.

Read `docs/adr/0089-a-browser-tab-holds-no-predecessor-because-it-can-never-run-one.md` in full. Then `docs/adr/0084-...` for what the three slots are, and `docs/adr/0086-...` for why supplying the same code resolves to the same generation rather than making a new one, which is what makes the browser revert story work without a slot. `docs/adr/0087-...` is why losing a generation is cheap now: the STREAM outlives every fold, so a re-fold is a local scan rather than a re-fetch a public node may refuse.

The decision most likely to be got wrong is applying this in the shared registry without a runtime distinction, which would silently remove the server's revert window. The receiving container is where `predecessor` is genuinely useful, because an operator reverts without redeploying and the code arrives by a route the browser does not have. There is an acceptance criterion aimed squarely at this; treat it as the main risk rather than a formality.

The second is reaching for a clear-after-the-move because it is the smaller diff. Do not: the registry sets both slots in one commit deliberately, and a two-act version reintroduces exactly the partially-assigned state this removes.

The third is scope. This changes who is ASSIGNED a slot. It does not change the caps, it does not add a deleter, it does not touch `dropOnPromotion` (which stays a policy about whether a demonstrated promotion discards what it superseded, and is a different question), and it does not remove `predecessor` from `SLOT_NAMES`, which stays live on the other runtime.

The seam to test at is the core package's registry and container tests, plus the browser package's own container tests, which already stand a container up over a durable registry and a fake chain and reload it.

Done means: a browser promotion leaves nothing slotted behind it, atomically; the server is untouched and proven so; the cap headroom is real; the glossary teaches the new arithmetic; and ADR-0089 stops saying it is unimplemented.

FIRST, check this task against current reality. It was written immediately after ADR-0089 was decided, so the code under it is hours old at most, but the `create`-resolves premise named above is load-bearing and worth confirming rather than assuming. Builders in this family have contradicted their task text repeatedly and have been right to every time.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in particular where you put the runtime's answer to "does this registry assign a predecessor" and why. Do not write the done record, the commit message or the PR body yourself.
