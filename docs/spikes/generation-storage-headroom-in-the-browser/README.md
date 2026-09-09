# Spike: what does a generation cost in browser storage, and is a quota failure atomic?

Evidence for [`work/notes/findings/browser-storage-headroom-for-generations.md`](https://github.com/wighawag/etherfold/blob/main/work/notes/findings/browser-storage-headroom-for-generations.md), which is where the conclusions live. Spec whose open questions this answers: `work/specs/tasked/a-reconfigure-is-not-an-outage.md` (the `maxGenerations` cap, and the atomic segment-plus-cursor commit).

## The three questions

1. **Footprint** — what does one generation (stream segments plus state) actually occupy, as bytes written and as record counts?
2. **Estimate** — is `navigator.storage.estimate()` usable to size a cap at runtime, or is it as quantised and laggy as the sqlite spike found?
3. **Atomicity** — when a write exceeds the quota MID-TRANSACTION, does IndexedDB roll the whole transaction back, or leave part of it?

(3) is the one that could produce a defect, and it is why this spike exists. The spec commits a segment and its cursor in ONE `setMany` so nothing can separate the cursor from its events; a full disk is the failure mode a browser actually produces, so that is where the guarantee has to hold.

## How the quota is forced

Filling a real disk to find the wall is not a test, it is an outage. Chromium can be told to have a small quota over CDP (`Storage.overrideQuotaForOrigin`), so the failure is triggered deterministically at 8 MB. That is chromium-only; the other two engines run the footprint pass at their real quota.

## Reading the tear detector

Counting surviving KEYS cannot detect a torn commit, and the first version of this spike reported a false positive by trying. The cursor is ONE key overwritten on every commit while segments accumulate, so the counts differ by design. What identifies the pair is the cursor's VALUE, which records the segment index it was committed with:

```
whole  =>  highest surviving segment index  ==  cursor.lastToBlock
torn   =>  they differ; cursor-ahead is the dangerous direction
```

## Re-running it

```sh
npm install
npx playwright install chromium firefox webkit

npx playwright test --project=chromium          # footprint + the forced-quota run
npx playwright test --project=firefox           # footprint only (quota-tear skips)
SPIKE_REPEAT=4 npx playwright test --project=chromium   # a larger history
```

`SPIKE_REPEAT` multiplies the fixture (the captured `stratagems-alpha1` stream, 31,332 real logs). Results merge by `(mode, repeat)` rather than overwriting, so runs at different sizes accumulate.

## Reading the numbers honestly

The **written-bytes** figure is the JSON payload the harness handed to IndexedDB; `estimate().usage` is what the browser says it stored. They differ by 6–10x because the browsers compress, which is itself one of the findings — so do not read written-bytes as a storage cost, and do not read `estimate()` as a reliable budget. Wall-clock is not measured here at all: this spike is about capacity and atomicity, and timing is `docs/spikes/promotion-cost-of-a-two-label-stream`'s business.
