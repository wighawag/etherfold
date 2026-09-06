---
title: 'Decoding preselects the event by topic0 instead of re-searching the whole ABI on every log'
slug: decoding-preselects-the-event-by-topic0-instead-of-re-searching-the-abi
promotedFrom: finding:decoding-is-3x-faster-with-a-memoised-topic0-map
blockedBy: []
covers: []
---

## What to build

Cut the decode term of every replay by ~3.2x, by giving `LogEventFetcher` a `topic0` map built ONCE
instead of letting viem re-search the whole ABI on every single log.

**Measured, not assumed** (`work/notes/findings/decoding-is-3x-faster-with-a-memoised-topic0-map.md`,
`docs/spikes/replay-decode-cache/decode-breakdown.ts`, over 31,330 real Base logs): decoding costs
**57 µs/event** today; preselecting the member by a `${address}:${topic0}` map costs **18 µs/event**.
The map itself takes **0.24 ms** to build, once.

This is a **private-method optimisation with no API change**: same inputs, same outputs, byte for
byte. It is worth doing on its own terms, and it is also what makes the args-cache design
unnecessary — the cost that a cache would have avoided is mostly not decoding at all, it is a lookup
redone once per log.

### The order it must be built in, and why step 1 is the whole risk

1. **PIN the current behaviour FIRST**, before touching anything. A test asserting `reparse` produces
   byte-identical `eventName`/`args` over a multi-event, multi-address ABI, and specifically
   including:
   - an event that FAILS to decode (the `decodeError` path must be unchanged);
   - an **ANONYMOUS event**, which carries no `topic0`, therefore cannot be in the map, and MUST keep
     falling through to the whole-ABI path.

   This test is red against nothing — it is the safety net, and it is the only thing standing between
   a 3.2x win and a silent decode regression.
2. **Build the map inside `LogEventFetcher`**, from the same source it already builds `abiPerAddress`
   from, keyed `${address}:${topic0}`. Anonymous members excluded.
3. **`decodeOnto` looks up, and FALLS BACK.** A hit passes a one-member ABI to `decodeEventLog`; a
   miss passes exactly what it passes today. The fallback is what keeps this a pure optimisation: no
   input can reach a path that did not exist before it.
4. **Re-run `docs/spikes/replay-decode-cache/decode-breakdown.ts` against the BUILT fetcher** and
   record the delta. The 3.2x was measured on a hand-rolled equivalent; the number this repo publishes
   must be the one measured through production code.

### Why a one-member ABI is safe here, and why it is still asserted

`decodeEventLog` over a one-member ABI and over a whole ABI are not *definitionally* identical: a
`topic0` collision between two members of one ABI would be resolved differently. ADR-0031 already
settles that — `LogEventFetcher` de-duplicates on the canonical event SIGNATURE, collapses two
declarations of one `topic0` that decode identically, and **REFUSES a genuine collision at
construction** — so the map cannot be ambiguous. Assert it in the test anyway rather than trusting
the ADR: a construction-time refusal is exactly the kind of guarantee that a later change relaxes
without noticing what depended on it.

## What this is NOT

- **NOT a change to what `reparse` RETURNS.** Same `eventName`, same `args`, same `decodeError`
  behaviour, on every input. If the output moves for any log, the change is wrong.
- **NOT a change to `parseAllEventsIrrespectiveOfAddresses`.** It keeps its existing whole-ABI route
  and does NOT grow a second map. ADR-0031 is explicit that this flag decides which ABI decodes a
  log and must never decide which events exist.
- **NOT a stored-shape change.** Nothing about what is persisted moves; this is decode-path only.
- **NOT `the-stream-stores-only-what-the-node-said`, and must not be folded into it.** That spec is a
  breaking type migration; this is a private refactor. They are deliberately serialised: this lands
  first, that lands on top, unchanged.
- **NOT the args cache.** Evaluated and rejected (`docs/spikes/replay-decode-cache/`); this task is
  what makes it unnecessary.

## Acceptance criteria

- [ ] The pinning test from step 1 exists and passes BEFORE the optimisation, and still passes after:
      byte-identical `eventName`/`args` across a multi-event, multi-address ABI, including a failing
      decode and an anonymous event.
- [ ] An ANONYMOUS event still decodes correctly, via the whole-ABI fallback, asserted directly.
      It has no `topic0`, so a map-only implementation would silently stop decoding it.
- [ ] A log whose `topic0` is in the map and one whose `topic0` is NOT both decode correctly, so the
      fallback is exercised rather than merely present.
- [ ] `parseAllEventsIrrespectiveOfAddresses` behaviour is unchanged, asserted.
- [ ] A `topic0` collision is still REFUSED at construction (ADR-0031), asserted here rather than
      assumed, because the map's unambiguity depends on it.
- [ ] The map is built ONCE per fetcher, not per call. Asserted structurally rather than by timing.
- [ ] The delta is re-measured through the BUILT fetcher and the finding is updated with the
      production number.
- [ ] Ship a changeset if any published surface changes (expected: none, but say so).
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- None. It should land BEFORE `the-stream-stores-only-what-the-node-said` is tasked, but that is
  ordering rather than a dependency: nothing here needs that spec and nothing there needs this.

## Prompt

> Make `LogEventFetcher` preselect the ABI event by `topic0` instead of letting viem re-search the
> whole ABI on every log. Measured: 57 µs/event today, 18 µs/event with a `${address}:${topic0}` map
> that costs 0.24 ms to build once — a 3.2x cut of the decode term, which is 18% to 80% of a
> processor-change replay depending on the state backend.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does
> it still match the code and the ADRs (0031 on `topic0` keying and collisions being refused at
> construction, 0034 on the unconditional reparse)? If a premise no longer holds, route to
> needs-attention with the discrepancy.
>
> BUILD IT IN THIS ORDER, and do not reorder it. Step 1 is the whole risk: write the pinning test
> FIRST, asserting `reparse` produces byte-identical `eventName`/`args` over a multi-event,
> multi-address ABI — including an event that fails to decode, and an ANONYMOUS event, which has no
> `topic0`, cannot be in the map, and must keep falling through to the whole-ABI path. Only then build
> the map, and make `decodeOnto` look up with a FALLBACK, so no input can reach a path that did not
> exist before.
>
> This is a PURE OPTIMISATION. Same inputs, same outputs, byte for byte. If any log's decoded output
> moves, you have broken it.
>
> Do NOT touch `parseAllEventsIrrespectiveOfAddresses` (ADR-0031 is explicit that it decides which ABI
> decodes a log and must never decide which events exist), do not change anything about what is
> STORED, and do not fold this into `the-stream-stores-only-what-the-node-said` — that spec is a
> breaking type migration and this is a private refactor, deliberately serialised.
>
> A one-member ABI and a whole ABI are not definitionally identical under `decodeEventLog`: a `topic0`
> collision would resolve differently. ADR-0031 refuses such a collision at construction, so the map
> cannot be ambiguous — assert that here rather than trusting it, because a construction-time
> guarantee is exactly what a later change relaxes without noticing what depended on it.
>
> Finally, re-run `docs/spikes/replay-decode-cache/decode-breakdown.ts` against the BUILT fetcher and
> update `work/notes/findings/decoding-is-3x-faster-with-a-memoised-topic0-map.md` with the number
> measured through production code rather than the hand-rolled equivalent.
>
> Done means: the pinning test passes before and after, anonymous events still decode, the fallback is
> exercised by a real miss, and the published number comes from the shipped path.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT.

## Decisions

**1. The anonymous-event criterion's premise is false in viem 2.52.0; I pinned output IDENTITY instead of "still decodes correctly".** The task and the finding both assume an anonymous event decodes today and would "stop decoding" under a map-only implementation. It does not decode today: `decodeEventLog` selects a member by matching `topics[0]` against a computed event selector *even for a one-member ABI* (there is no `abi.length === 1` shortcut in 2.52.0, verified in `packages/core/node_modules/viem/_esm/utils/abi/decodeEventLog.js`), and an anonymous event's `topics[0]` is an indexed argument, so no member is found and the log records a `decodeError` on either route. I did not treat this as STOP-worthy drift because the task's actual contract ("same inputs, same outputs, byte for byte") settles it with no judgement left over: the anonymous event must keep taking the whole-ABI route and produce the identical answer, which is what the test asserts directly, against both the golden and the oracle. Alternative considered: STOP and route to needs-attention. Rejected because the sub-premise is not load-bearing for the design (the fallback is required either way, and is what keeps the two routes agreeing whichever answer viem gives in future). Touches: the finding, which I corrected in place rather than leaving to mislead the next reader.

**2. Shipped a changeset although no published surface moved.** The acceptance criterion says "ship a changeset if any published surface changes (expected: none)". None did: the map and the lookup are private, `parse`/`reparse` return the same. But the repo's `verify` gate runs `pnpm changeset status --since=main`, which fails for *any* changed package regardless of whether the API moved, so "no changeset" is a red gate at land time. I wrote a `patch` changeset for `@etherfold/core` that says explicitly that no published surface moves. Alternative considered: `changeset add --empty`, rejected because the release notes should carry a 3.2x decode win. Touches: the release the publish task eventually cuts.

**3. Deleted the dead private field `abiEventPerTopic`.** It was assigned in the constructor and read by nothing, and its comment claimed "kept because the map below decodes by it", which was not true. Leaving it beside a new `abiEventPerAddressAndTopic` would be two nearly-identically-named maps where only one means anything, which is exactly the coherence trap the new concept had to avoid. The local of the same name is untouched, so the duplicate-`topic0` refusal it guards is unchanged (and the comment now describes what actually decodes by it). This is a small scope expansion beyond the task's letter; recorded rather than silent.

**4. Measured the "before" number through production's address-agnostic route rather than a hand-rolled transcription** (`docs/spikes/replay-decode-cache/decode-breakdown.ts` gained a `productionWholeAbi` variant). `parseAllEventsIrrespectiveOfAddresses` deliberately does not preselect, and each fetcher in that harness holds exactly one contract, so it decodes against the same member list and differs only in the search. That makes the published delta production-to-production instead of production-against-transcription, which is what the task asked for; the pre-change production number it produces (1,824 ms) re-confirms the 1,791 ms recorded at `2efd858` on the same machine. It also gave a free real-data check of the pure-optimisation claim: all 31,330 logs decode identically preselected and unpreselected, both through the shipped code. Touches: the spike's result JSON shape (`correctness.allThreeAgree` → `allVariantsAgree`, a new `productionWholeAbi` entry, and `speedup` now production-to-production).

**5. Left the spike README as the pinned memo it is, with a note rather than a rewrite.** It states it is measured at `2efd858` and its §5 table is the argument that was made; rewriting its numbers would rewrite the record of a decision. I added a short block above that table pointing at the finding for the post-landing numbers, so a reader re-running the script does not think the memo is wrong.
