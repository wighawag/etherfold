# replay-decode-cache

**Should the stream be able to SKIP decoding on a processor-change replay, by caching the decoded
`args` under a decode identity? Or should it store the raw log only, as
`work/specs/proposed/the-stream-stores-only-what-the-node-said.md` proposes, and pay the decode
every time?**

A decision memo. **Recommendation: neither A nor B as posed. Land the held spec unchanged, and
separately make the decoder 3.2x faster by memoising a lookup it currently redoes 31,330 times.**
That is a pure refactor storing nothing, and it removes 68% of the decode term the whole question is
about, which shrinks option B's remaining prize to a level that does not pay for its correctness
surface.

Everything below is measured on this machine at commit `2efd858`, on the same 31,330 real Base logs
`docs/spikes/replay-parse-cost/` used. Harness: `measure.ts`, `guard.ts`, `decode-breakdown.ts`;
raw output in `results/`.

---

## 1. The prior finding, re-verified: two seams held, one is INVALIDATED

`work/notes/findings/replay-parse-cost.md` measured read 488 ms, decode 1,962 ms, process 735 ms,
and concluded decode is ~62% of a processor-change replay. Checked seam by seam at HEAD:

| seam | status at `2efd858` | evidence |
| --- | --- | --- |
| decode (`LogEventFetcher`) | **unchanged** | `git diff 5e0f455..HEAD -- packages/core/src/internal/decoding/` is empty |
| read (gunzip + `parseStreamFixture` + `taggedBnReviver`) | **unchanged in substance** | `stream/fixture.ts` moved 12 lines, the codec did not |
| process (`fromJSProcessor` + `@etherfold/js-processor`) | **GONE** | ADR-0037 retired the JS-object path; `packages/js-processor` has ZERO tracked files, and `fromJSProcessor` has no definition anywhere in `packages/*/src` |

So the finding's 62% is **not reproducible at HEAD**, and not because the number was wrong: the
denominator's third term was measured through a package that has since been deleted. Worse, the
spike would still *appear* to run, because `packages/js-processor/dist/` survives on disk as stale,
untracked build output. Anyone re-running `docs/spikes/replay-parse-cost/measure.ts` today would get
a number produced by code that is no longer in the repository.

The read and decode terms reproduce within noise (read 461 ms vs 488; decode 1,794 ms vs 1,962, the
same 57–63 µs/event band). The process term is re-measured on the model that survives: the ENTITY
path (`replayIntoStore` + `stratagemsProcessor` into a `StateStore`), across the three backends the
conformance suite covers. Correctness is asserted, not presumed: the replay lands on the **committed
golden state** the original stratagems `JSProcessor` computed (1,040 blocks, 29,492 mutations,
`correctness.entityReplayMatchesGolden: true`).

### The corrected process term, and why "62%" was never one number

| term | median | per 1k events |
| --- | --- | --- |
| read, raw-only shape | 251 ms | 8.0 ms |
| read, raw+decoded shape | 456 ms | 14.6 ms |
| decode (`reparse`, per-address routed) | 1,794 ms | 57.3 ms |
| process, entity path on **memory** | 202 ms | 6.4 ms |
| process, entity path on **patch** (the light store) | 991 ms | 31.6 ms |
| process, entity path on **sqlite** (libSQL, the server) | 7,737 ms | 246.9 ms |

The process term spans **38x** across backends. Decode's share of a raw-only replay is therefore not
62% but a range:

| backend | replay total (option A) | decode share |
| --- | --- | --- |
| memory | 2,247 ms | **80%** |
| patch | 3,035 ms | **59%** |
| sqlite | 9,782 ms | **18%** |

The old finding's caveat ("an entity path with SQL writes would raise the process term, shrinking
decode's SHARE") was correct and is now quantified. **Any argument of the form "decode is most of a
replay" is a claim about the browser's light store, and is false on the server.**

### A second correction, on the READ term

The prior spike measured read once, on the full stored shape. It is not shape-independent: the
decoded half nearly **doubles** the read (456 ms against 251 ms). This matters because it is the term
option B pays extra, and no prior number in the repo exposed it.

---

## 2. Corrected framing of the question

Four things in the brief need restating before the options can be compared honestly.

**(a) The premise ("processor-logic changes are the most common change class") is UNEVIDENCED, and
it is also the wrong axis.** See §6. What actually decides option B's value is not
processor-vs-ABI frequency; it is *decode-shape-changing edits versus everything else*, because a
regenerated ABI is a cache **hit** under option B (measured, §4). ADR-0034's own claim points the
same way: "an ABI is REGENERATED and not hand-edited, so the things that move in it most often are
the things nothing depends on". The recommendation is therefore insensitive to the premise, which
is fortunate, because the premise cannot be established.

**(b) The byte arithmetic in the brief runs the wrong way.** Option A saves 24% of *today's* bytes
(27.8 MB → 21.1 MB JSON). Option B keeps today's shape, so B is **+32% over A** in JSON, and
**+54% over A gzipped** (0.98 MB against 0.63 MB), which is the ratio that matters on a substrate
that compresses.

**(c) Generations do NOT multiply the stream.** The brief weighs B's bytes against
`browser-storage-headroom-for-generations.md` "since generations multiply stored state". They
multiply STATE. A generation is keyed by `{stream, processor version}` and a processor-only change is
a new generation over the **same** stream digest, sharing one stream subtree. That is exactly
ADR-0008's amendment and the reason the server's `_emissions` table has no generation column. The
headroom spike wrote a full stream copy per generation, which models the *reconfigure* case (the
filter moved, so the stream genuinely forked), not the processor case. So option B's byte cost is
paid **once per stream**, not once per generation. At the ~8.9x IndexedDB compression that finding
measured on this very fixture, that is roughly **3.1 MB against 2.4 MB stored** for this history.
**Bytes are not the deciding axis for either option.**

**(d) "Decode is already paid unconditionally" is true but hides the real finding.** It is paid
unconditionally *and it is paid 3.2x more expensively than it needs to be* (§5).

---

## 3. What option B would actually be built out of

The key the brief suspects already exists does exist, in the sense that its *rule* does, but the
value does not: `streamDigestOf` rolls up the per-entry **`streamHash`** (address, topic0, range) and
is deliberately decode-insensitive. Its mirror over the per-entry **`hash`** (address, canonical
signature, `decodingShapeOf`, range) is what a decode identity would be, and `decodingShapeOf` is
exactly parameter names + types + `indexed` + components + `anonymous`, which is the complete input
to `decodeEventLog` besides the log itself. No such digest is computed anywhere today.

**Granularity is settled by what already landed.** `StreamSegment` is one save's batch and nothing
else, written under one source at one moment, while the `context` lives once per subtree in
`StreamCursorRecord`. So **per-segment** is both available and exactly right: one fixed-length
32-char digest per segment record. Per-event is available too and is 4.8% of stored JSON at one event
per segment; per-segment is 0.05% at 100 events per segment (`results/measure.json`,
`segmentOverhead`). **Storage cost of the guard itself is negligible at any sane batch size**: the
cost of option B is the `args` it exists to keep, not the key.

**Cost to check it: 1.27 ms per replay** (`identity.decodeDigestCandidateMsPerCall`, 25 source
entries), once, not per event. Free.

---

## 4. Does the guard hold? Measured, four ways (`guard.ts`)

A real source mutated four ways, each digest recomputed, and a real log decoded under each:

| mutation | stream digest | decode digest | wire `{source,config}` | `args` actually changed | verdict under B |
| --- | --- | --- | --- | --- | --- |
| rename a NON-INDEXED parameter | still | **MOVED** | MOVED | **yes** | miss → reparse from raw, no re-fetch |
| add a VIEW FUNCTION (regeneration) | still | still | **MOVED** | no | **hit** |
| add a NEW EVENT (filter widens) | **MOVED** | **MOVED** | MOVED | no | new stream, re-fetch (same under A) |
| PROCESSOR-ONLY change | still | still | still | no | **hit** |

All four expectations held (`results/guard.json`, `failures: []`). Two things follow:

- **The candidate identity is behaviourally correct on every change class in the repo's own
  vocabulary**, including the one the two-digest split exists for.
- **The wire `{source, config}` identity is NOT a usable cache key**, and this is measured rather
  than argued: it moves when a view function is added, so under it every regenerated ABI is a cache
  miss, which is the exact over-invalidation ADR-0034 was written to stop. Any option-B build must mint a new
  digest; it cannot reuse the wire hash. (It also must not roll up the per-entry `hash` values
  directly the way `guard.ts` does for measurement convenience: those are `simple_hash`, 32 bits, and
  this repo already ruled 32 bits out as a KEY in
  `the-emission-stream-table-is-created-with-every-column-it-needs`. The preimage must be the
  canonical decoding shapes themselves, under a 128-bit digest, exactly as `streamDigestOf` does.)

### Where the guard is INCOMPLETE, and this is the honest answer to "does the guard make it safe or merely move the failure"

**It moves the failure, and it moves it somewhere the repo cannot see.**

Decoded `args` are a function of three things: the ABI (in the source, hashable, and the guard covers
it), the parse config (in `ProvidedStreamConfig.parse`, already inside the digest's config half), and
**the decoder**: `viem`'s `decodeEventLog`, plus this repo's bigint codec on the way to and from
storage. The decoder is in **neither** the source nor the config, so no digest built from a source
can move when it moves.

That is not theoretical:

- `@etherfold/core` depends on `viem: ^2.52.0`. A **caret** range. A lockfile refresh moves the
  decoder with no code change, no source change, and no digest movement.
- viem exports **no runtime version**. It exists only at `viem/_esm/errors/version.js`, which is not
  in the package's `exports` map, so core cannot read the version of the decoder it is running
  through any supported route (verified).
- The only remaining mechanism is a hand-maintained constant in core, bumped when a maintainer
  notices viem's decode semantics moved. **That is precisely the mechanism ADR-0008's 2026-08-21
  amendment and `processor-version-hash-cannot-silently-lie` litigated and called a silent lie**, one
  layer further down and with a smaller audience to notice.

Under today's unconditional reparse this failure class **cannot exist**: the decoder in force is
always the one that produced the `args` handed to the processor, so it cannot disagree with itself.
Option B creates the class. It is a low-probability class (decode output for a fixed ABI is close to
a public contract for viem, and ADR-0029 pins the bigint convention), but the held spec's whole
argument is that *only the derived half can be wrong*, and this is the derived half being wrong for a
reason the guard is structurally blind to.

### The brief's third threat, answered directly

> *If we cannot reliably tell that the processor changed, can we reliably tell that the ABI did NOT?*

**Yes, and the asymmetry is real.** `the-processor-fingerprint-is-blind-to-closure-state` is a
finding about hashing **code**: `Function.prototype.toString()` is all a fingerprint can see, and a
closure-captured value is not in the source text. An ABI is **data**, and the source value is passed
into `fetchFrom`/`saveNewEvents` on every call, so `sourceHashesOf(source)` hashes the actual runtime
value rather than a description of it. There is no closure to be blind to. So option B is **not**
unsound for the reason the brief feared.

It is unsound for a *different* reason, one layer out: the ABI is not the only input to a decode. The
guard can prove the ABI did not move and still be wrong, because the decoder moved.

---

## 5. The finding that decides it: the decode term is 3.2x too big (`decode-breakdown.ts`)

`decodeOnto` calls `decodeEventLog({abi: <every event of that address>, data, topics})` **once per
event**. viem must then work out which member the log's `topic0` names, and does so by walking that
ABI and computing an event selector (a keccak over the canonical signature) per candidate, per call.
Nothing memoises it.

Same 31,330 logs, same viem instance (resolved from core's own `node_modules`), asserted to produce
**identical** `eventName`/`args` all three ways:

| variant | median | per event |
| --- | --- | --- |
| production `reparse` (whole address ABI per call) | 1,791 ms | 57.2 µs |
| bare `decodeEventLog`, whole address ABI per call | 1,769 ms | 56.5 µs |
| bare `decodeEventLog`, **one-member ABI preselected by a topic0 map** | **564 ms** | **18.0 µs** |
| building that map | 0.24 ms, **once per fetcher** | n/a |

**3.2x, for a map built in a quarter of a millisecond.** Production overhead above the raw viem call
is ~1%, so this is entirely viem's per-call ABI search. And the ABIs here are *small* (14, 6 and 4
events), so the effect grows with ABI size rather than being an artifact of a pathological one.

This is a **refactor, not a cache**: nothing is stored, the map is rebuilt from the source whenever a
fetcher is constructed, and there is no derivation on disk to go stale. `decodeOnto` already exists
precisely so the fetch path and the replay path decode through one rule; memoising inside it fixes
both at once.

---

## 6. The frequency premise: it CANNOT be evidenced here, and the recommendation does not need it

Everything the repo can offer:

- **Git history of the processors.** `examples/event-processor-nfts/src/entities.ts`: 2 commits.
  `examples/browser-reference/src/processor.ts`: 1. The two ABI/source files in the tree
  (`eip721.ts`, the vendored `stratagems/abi.ts`): 1 commit each. This is a library, and its examples
  were ported once; the sample says nothing about deployments. **No frequency claim survives it.**
- **ADR framing.** ADR-0008 exists for processor upgrades and its amendment states a processor-only
  change is a new generation over the same stream. That establishes the case is *designed for*, not
  that it is *frequent*.
- **ADR-0034 framing.** "An ABI is REGENERATED and not hand-edited, so the things that move in it
  most often are the things nothing depends on." This is the only frequency claim written down
  anywhere in the repo, and it is about ABIs, not processors.

**Sensitivity.** Under option B the change classes partition as: processor-only → hit; ABI
regenerated with nothing indexed moved → hit; decode-shape change → miss (7–9% worse than A); filter
change → new stream either way. So B's expected value depends on the frequency of **decode-shape
changes alone**, and by ADR-0034's own claim those are the rare ones. **Option B's case is stronger
than the brief's premise, not weaker**, which is exactly why the premise being unevidenced does not
rescue it. What sinks B is §4's incompleteness and §5's cheaper alternative, neither of which is a
frequency argument at all.

---

## 7. The option comparison, in numbers

Replay of 31,330 events. **A** = raw-only stored, decode always. **B-hit** = raw+decoded stored,
identity matches. **B-miss** = identity moved, reparse from raw. **C** = A plus the memoised decoder.

| | memory | patch (light store) | sqlite (server) |
| --- | --- | --- | --- |
| **A** raw-only | 2,247 ms | 3,035 ms | 9,782 ms |
| **B-hit** | 660 ms | 1,448 ms | 8,194 ms |
| **B-miss** | 2,454 ms | 3,242 ms | 9,988 ms |
| **C** = A + memoised decode | **1,017 ms** | **1,806 ms** | **8,552 ms** |
| B-hit against A | −71% | −52% | −16% |
| B-hit against **C** | **−35%** | **−20%** | **−4%** |
| C against A | −55% | −41% | −13% |

B's advantage over C is a constant **359 ms per 31,330 events, or 11.5 µs/event**, on every backend
(the 564 ms residual decode, less the 205 ms of extra read B pays for storing `args`).

| | option A | option B | option C (recommended) |
| --- | --- | --- | --- |
| stored JSON | 21.1 MB | 27.8 MB (+32%) | 21.1 MB |
| stored gzipped | 0.63 MB | 0.98 MB (+54%) | 0.63 MB |
| guard bytes | none | 0.05% of stored, per segment at 100 ev/seg | none |
| guard check cost | none | 1.27 ms per replay | none |
| new staleness class | none | **yes: decoder version, unguardable** | none |
| new persisted format | none | per-segment identity field, plus an upgrade path for segments written without one | none |
| breaks the server's raw-only `_emissions` shape | no | **yes** | no |

---

## 8. Recommendation

**Adopt option C: land `the-stream-stores-only-what-the-node-said` exactly as held, and land the
decoder memoisation as a separate, non-breaking change to `LogEventFetcher.decodeOnto`. Do not build
option B.**

Reasons, in order of weight:

1. **C captures 68% of the decode term for zero stored bytes and zero new correctness surface.** The
   thing option B exists to avoid is largely not a decode cost at all; it is a lookup redone 31,330
   times. Caching a derivation to avoid work that can simply be deleted is the wrong trade.
2. **What is left after C does not pay for B.** 11.5 µs/event. On the server path that is 4% of a
   replay. On the light store it is 20%, on a replay that has fallen from 3.0 s to 1.8 s, and the
   remaining 1.8 s is then dominated by the fold, where the next optimisation belongs.
3. **B's guard is incomplete in a way the repo cannot close** (§4), and it creates a staleness class
   that is structurally impossible today. The held spec's central argument survives contact with the
   guard: a guarded cache is still a derivation, and the guard covers the ABI but not the decoder.
4. **B forks the storage shape** from the server's `_emissions`, which already stores raw only with
   an explicit written rationale ("persisting them would persist an opinion that a decode-only change
   invalidates"). C keeps core and server saying the same thing. On the brief's question (is
   divergence acceptable, or should both move together?) the answer is that they should move
   together, and A/C is the direction in which they already agree.
5. **B lands on top of a spec that is already a breaking public API change entangled with a third
   seam implementation**, which was split out of a larger spec after four review rounds *because*
   every blocker landed in this half. Adding a cache with an identity, an upgrade path for
   pre-identity segments, and a new persisted field to that spec is how it acquires a fifth round.

### The strongest argument AGAINST this recommendation

**On the browser's light store, B-hit is 1,448 ms against C's 1,806 ms, and the browser is the
primary runtime (ADR-0002).** A 20% cut in a user-visible wait is not nothing, the guard was measured
correct on all four change classes, the byte cost is ~1 MB gzipped once per stream (not per
generation), and the check costs 1.27 ms. If you believe the decoder-version hazard is negligible,
and it is a genuinely low-probability hazard, since viem's decode output for a fixed ABI is close to
a public contract and ADR-0029 pins the bigint convention, then B is a real 20–35% win on the
runtime that matters most, and this recommendation trades it away for a purity the user cannot
observe.

The counter is that the same 20% is available again, and larger, in the fold: `process` on the patch
store is 991 ms against memory's 202 ms for identical work, a 4.9x gap that nobody has yet looked at.
Spending the correctness budget on a cache to save 359 ms, while a 789 ms unexplained gap sits beside
it, is the wrong order. But the argument above is the honest one, and if the fold gap turns out to be
irreducible, B deserves re-opening, with the decoder-version question answered first.

---

## 9. What would have to change in the held spec

**If option C is adopted: nothing.** The spec is untouched. That is a property of the
recommendation, not a coincidence. Two additions are worth making to it as *notes*, and neither
changes a decision:

- Its Problem Statement says size is not the case and cites three disagreeing inherited figures.
  Those are now retired twice over; it can cite the measured 27.8 / 21.1 / 17.0 MB.
- Its story 3 ("reuse across a decode change") is delivered by `reparse`, and §4 above establishes
  that a *decode identity* could make the reuse conditional. Worth one line recording that it was
  evaluated and rejected, so the next reader does not re-derive it.

**If option B were adopted anyway, the spec would need:** the stored type to stop excluding the
decoded half (its `StoredLogEvent`'s `args?: never` is precisely what B needs to permit), a new
per-segment identity field on `StreamSegment` plus a rule for segments written without one, a new
128-bit decode digest beside `streamDigestOf`, a decision on the decoder-version input, and a
reconciliation with the server's `_emissions`. That is a different spec, not an amendment.

---

## 10. De-risked build plan (for the recommendation only)

The memoisation is one small change and does not need a spec. It is **not** part of
`the-stream-stores-only-what-the-node-said` and must not be folded into it: that spec is a breaking
type migration, this is a private-method refactor, and serialising them costs nothing while merging
them entangles a behavioural change with an API change.

1. **Pin the current behaviour first.** A test asserting `reparse` produces byte-identical
   `eventName`/`args` on a multi-event, multi-address ABI, including an event that fails to decode
   and an **anonymous** event (which has no `topic0` and therefore cannot be in the map, so it must
   keep falling through to the whole-ABI path). Red against nothing; it is the safety net.
2. **Build the map inside `LogEventFetcher`**, from the same source it already builds `abiPerAddress`
   from, keyed `${address}:${topic0}`. Anonymous members excluded. `parseAllEventsIrrespectiveOfAddresses`
   keeps its existing whole-ABI route rather than growing a second map.
3. **`decodeOnto` looks up, and falls back.** A hit passes a one-member ABI to `decodeEventLog`; a
   miss passes what it passes today. The fallback is what keeps this a pure optimisation: no input
   can reach a path that did not exist before.
4. **Re-run `decode-breakdown.ts` against the built fetcher** and record the delta. The 3.2x here is
   measured on a hand-rolled equivalent; the claim to publish is the one measured through production
   code.
5. **Then land the held spec** on top, unchanged.

Step 1 is the whole risk. `decodeEventLog` on a one-member ABI and on a whole ABI are not
*definitionally* identical (a topic0 collision between two members of one ABI would be resolved
differently), and ADR-0031 already decided that a topic0 collision is REFUSED at construction, so the
map cannot be ambiguous. That should be asserted in the test rather than trusted to the ADR.

---

## Caveats, stated rather than hidden

- One laptop (Ryzen 7 PRO 6850U, node 24.13.1, Debian 13), medians of 5 warm runs, single-threaded.
  Ratios are the finding; absolute numbers will move.
- **The read term is a browser-shaped read** (gunzip + JSON.parse of a whole stream). A server replay
  reads `_emissions` through SQL and its read term is a different thing entirely, unmeasured here.
  The sqlite column above is an entity-store write cost against an in-memory libSQL, not a full
  server replay.
- `sqlite` is `:memory:` libSQL. A disk or D1 process term would be higher, which pushes decode's
  share down further and weakens option B further, so the direction of the error is known.
- The decode measurement routes events to per-contract fetchers by address, because the merged
  three-contract source cannot construct a fetcher at all
  (`work/notes/observations/the-conformance-workloads-merged-source-cannot-construct-a-fetcher.md`,
  still open). The per-event decode decision is the same one `decodeOnto` makes.
- `guard.ts`'s candidate digest rolls up the 32-bit per-entry `hash` values for measurement
  convenience. A real implementation must not; see §4.
- The golden-state check passes on 31,330 events against a golden computed from 31,332: the two
  absent ones are the pre-#26/#27 unparsed `OwnershipTransferred` logs today's topic0-filtered fetch
  never requests, and no handler consumes them.
