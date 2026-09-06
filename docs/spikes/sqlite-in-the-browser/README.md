# Spike: does wasm SQLite ever beat the IndexedDB backend for OUR workload?

Evidence for [`work/notes/findings/sqlite-in-the-browser.md`](https://github.com/wighawag/etherfold/blob/main/work/notes/findings/sqlite-in-the-browser.md), which is where the conclusions live. This folder holds the harness, the fixtures and the raw output, so every number in that finding can be re-run rather than believed.

Task: `work/tasks/done/spike-sqlite-in-the-browser.md`. Spec whose open questions this answers: `work/specs/tasked/one-processor-everywhere.md`.

> **FIVE SCRIPTS HERE NO LONGER RUN, deliberately (2026-09-02).** `run/verify-port.ts`, `run/build-traces.ts`, `run/measure-patch-replay.ts`, `run/sharing-probe.ts` and `browser/patch-cut.ts` import `../../../../packages/js-processor/dist/...`, and that package is DELETED (ADR-0037, `work/tasks/done/retire-the-js-object-processor-path.md`): the free-form authoring path it provided is gone, so the import does not resolve and those five cannot be re-run as written. They are KEPT rather than pruned, because this folder is the evidence store behind `work/notes/findings/sqlite-in-the-browser.md` and a measurement whose harness has been deleted is a number with no method. What they measured is still readable, and what they drove (the vendored stratagems `JSProcessor`) is still committed, at `packages/conformance-workload-stratagems/vendor/stratagems/js-processor.ts`; what is gone is the runtime that could execute it. Anyone re-running them would have to supply that runtime first. `docs/spikes/` is not a workspace package, so `pnpm typecheck` does not see this and will not tell you: this paragraph is the marker.

> **Two of these folders were PROMOTED and no longer live here.** `promote-stratagems-conformance-workload` moved the captured streams, the golden states and the vendored oracle into **[`packages/conformance-workload-stratagems`](https://github.com/wighawag/etherfold/tree/main/packages/conformance-workload-stratagems)**, where they are production test material rather than evidence, and rewrote the port onto the idiomatic model (children keyed by their parent, read through the bounded id-prefix listing: three entities instead of six, no CSV index, no hand-maintained count) while still landing on the byte-identical golden state. The scripts below read them from their new home; `src/port/` STAYS here, unchanged, because it is the exhibit the finding's contortion list describes.

## What is here

> **Which deployment.** stratagems has TWO deployment folders on Base (both `.chain` files say `chainId: 8453`): `base/`, an early one that saw 45 logs and was abandoned, and `alpha1/`, which is the LAUNCHED game, 26,308 logs. The task named the `base/` addresses; this spike uses `alpha1` for every result and keeps `base` as a small smoke fixture. If you are comparing against the task text, that is why the numbers are not the ones it implies.

```
capture/     the ONE script that talks to a node, run once per deployment
src/port/    the stratagems processor ported to MutationContext, and the projection back
             (the PRE-listing port: what the contortion list is about. The promoted,
             rewritten one is in packages/conformance-workload-stratagems/src/)
src/store/   the candidates behind one seam: memory, IndexedDB, whole-blob, versioned SQL
src/workload/ the deterministic generator that makes the sweep sizes
run/         node-side: equality, trace shapes, store agreement, patch replay, summary
browser/     the Playwright cuts and the spec, on playwright-browser-harness
results/     raw JSON per engine, plus results/summary.md

... and, since the promotion, in packages/conformance-workload-stratagems/:
fixtures/    the captured Base streams, the golden states, the golden traces
vendor/      stratagems source, copied verbatim, GPL-3.0 (see its vendor/stratagems/README.md)
```

## Re-running it

```sh
npm install
npx playwright install chromium firefox webkit

npx tsx run/verify-port.ts             # BROKEN: needs @etherfold/js-processor, deleted by ADR-0037
npx tsx run/verify-port.ts base        # BROKEN, same reason
npx tsx run/build-traces.ts            # BROKEN, same reason
npx tsx run/verify-store.ts            # the trace applies to the REAL versioned SQLite store (libSQL)
npx tsx run/measure-patch-replay.ts    # BROKEN, same reason
node --expose-gc --import tsx run/sharing-probe.ts tip|last256|all   # BROKEN, same reason

npx playwright test --project=chromium # the browser measurements
SPIKE_SIZES=tiny,small npx playwright test --project=firefox   # a quicker pass
npx tsx run/summarise.ts               # results/*.json -> results/summary.md
```

Re-capturing the stream needs `CHAIN_8453` in the repo's `.env.local` and is deliberately a separate, manual step:

```sh
npx tsx capture/capture-stratagems-base.mjs                    # alpha1, the launched game
npx tsx capture/capture-stratagems-base.mjs --deployment base  # the abandoned early one
npx tsx capture/capture-stratagems-base.mjs --full             # keep `data`/`topics` too
```

The committed fixture omitted each log's `data` and `topics` when this spike ran, which are the encoded form of the `args` it already carries decoded. **That is no longer true of the file on disk**: it was re-captured with `--full` on 2026-09-06, because an event with no raw log cannot be re-decoded, so a stream seeded from it was cleared on load (ADR-0034, ADR-0063). Nothing this spike measured is affected, since it replays decoded events into a store; the file is simply bigger now.

The launched game's fixture is stored **gzipped** (`.json.gz`, 1.05 MB against 33.8 MB of JSON, so the compressed form saves 33 MB in every working tree; it was 0.6 MB against 20.5 MB in the decode-only form this spike measured). `loadStreamFixture` (promoted with the fixtures, now `packages/conformance-workload-stratagems/src/fixture-file.ts`) gunzips by extension, and the browser side does it with the native `DecompressionStream` (`src/workload/load-fixture.ts`). The abandoned deployment's fixture stays plain JSON because it is small enough to read. The derived `*.trace.json` files are gitignored: `run/verify-port.ts` regenerates them, identically, in about three seconds. The golden `*.state.json` IS committed, because it is the expectation and a diff on it means the processor changed meaning. All of them now live in `packages/conformance-workload-stratagems/fixtures/`, which carries their labels and provenance in its own README.

The full Chromium sweep takes about 15 minutes; `sweep` and `large` are the slow ones, and they are the two that matter.

## The rules this spike holds itself to

- **No node is in any measurement loop.** The chain is queried once, by `capture/`, and every run after that replays a file. Two candidates that saw different bytes cannot be compared.
- **One block is one batch.** Every backend applies a block as a single atomic unit, because that is how blocks arrive. A loop of single-row inserts flatters everything and predicts nothing.
- **Trace generation is outside every timed section.** It is processor work, identical for all candidates.
- **The oracle is not ours.** The expected state was computed by the stratagems `JSProcessor`, vendored verbatim, which is code that has been running on Base. An expected value we wrote ourselves would prove nothing. (Since ADR-0037 there is no longer a runtime here that can drive it; the golden states it produced are committed in `packages/conformance-workload-stratagems/fixtures/` and are now a frozen expectation.)
- **A candidate that cannot start is a result, not a broken test.** WebKit has no OPFS under Playwright, so the SQLite route fails there, and the run records what it said rather than going red.

## What is real and what is generated

(Paths below are relative to `packages/conformance-workload-stratagems/`, where they were promoted.)

| | Real | Generated |
| --- | --- | --- |
| `fixtures/stratagems-alpha1.stream.json.gz` (workload size `real`) | every log from the three `alpha1` contracts, blocks 12,082,307 to 23,400,000: 31,332 events, 1,042 blocks, 38,192 mutations, 4,072 live rows | |
| `fixtures/stratagems-alpha1.state.json` / `.trace.json` | computed from that stream by the real processor | |
| `fixtures/stratagems-base.*` | the abandoned deployment: 42 events, 9 blocks | |
| the sweep sizes (`tiny` to `sweep`) | the event SHAPES, the handlers, every mutation | which player moved where, and when |

The real stream drives the port equality, the head-to-head at the real size, and the sparsity result. It cannot locate a CROSSOVER, because the game never reached the dataset sizes where one occurs, which is what the generated sizes are for. The finding keeps the two apart.

## Known limits of this evidence

- The IndexedDB and blob backends are **prototypes written for this spike**, faithful to the design but not tuned. The SQLite candidate is the real `@etherfold/state-store-sqlite` running unmodified, so the comparison is slightly unfair IN SQLITE'S FAVOUR on code maturity, and unfair against it on payload and cold start.
- The mid-range device profile is **CPU throttling on Chromium**, so it models single-core speed and not slower flash, less memory, or thermal throttling. It is a floor on the gap, not a measurement of a phone.
- `navigator.storage.estimate()` is quantised and lags, so IndexedDB footprints are reported as **record counts** where precision matters; SQLite's page count is exact.
- Everything was measured on one machine (Debian 13, this laptop). Ratios between candidates travel; absolute milliseconds do not.
- The real stream's event-bearing blocks are median 429 block numbers apart. Anything that reasons about "the last N blocks" (the immer patch window in particular) behaves completely differently on it than on the generated workloads, whose blocks are consecutive. That is a result, recorded in the finding, not a defect of either workload.
