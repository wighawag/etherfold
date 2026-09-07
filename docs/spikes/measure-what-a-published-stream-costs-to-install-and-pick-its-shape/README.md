# Spike: what does installing a published stream seed cost a browser?

Evidence for [`work/notes/findings/what-a-published-stream-seed-costs-to-install.md`](../../../work/notes/findings/what-a-published-stream-seed-costs-to-install.md), which is where the conclusions and the recommendation live. Task: `measure-what-a-published-stream-costs-to-install-and-pick-its-shape`, from the exploration spec `a-generation-can-be-seeded-from-a-published-artifact`. The install being measured is the one [ADR-0063](../../adr/0063-a-published-stream-seed-arrives-through-its-own-loader-and-installs-through-the-keeper-seam.md) pinned.

## The question

Can a published stream seed be ONE document, fetched, parsed and installed in one go, or does it have to be chunked and resumable? On numbers, not on the intuition that 30-odd MB feels like a lot.

## What is compared, and why it is two axes and not one

The obvious experiment (one document versus chunks) confounds two independent choices, so both are varied:

- **DELIVERY**: one document, or a manifest plus contiguous chunks.
- **CONTENT**: the capture's DECODED events, or only the STORED (raw) half the keeper actually keeps. Installing strips `args`, `eventName` and `decodeError` before anything reaches the keeper (ADR-0060), so a seed carrying them ships bytes the client parses and throws away. That is measurable, so it is measured rather than argued.

A third variable falls out of the second: the tagged-BigInt revive. `parseStreamFixture` revives every decoded argument in the document, and on this path every one of them is then discarded, so `parse: 'fixture'` and `parse: 'json'` are measured separately to price it.

## Files

| file | what it is |
| --- | --- |
| `prepare.mjs` | builds the artifacts once, offline, into `assets/`. Run it first. |
| `browser/cut.ts` | the code under test: fetch, gunzip, parse, install, measure. Imports the PINNED install path from the seam spike rather than re-deriving one. |
| `browser/install-cost.spec.ts` | the desktop driver: three engines, repeats, optional CPU throttle. |
| `android.mjs` | the SAME cut on a real phone over USB. |
| `sampler.mjs` | the driver-side CDP heap sampler both drivers use, so desktop and device are measured by one instrument. |
| `report.mjs` | prints the comparison the finding quotes: medians with spread. |

## Re-running it

```sh
npm install
npx playwright install chromium firefox webkit

node prepare.mjs                                  # build the artifacts (needs the committed fixture)
npx playwright test                               # all three desktop engines
SPIKE_THROTTLE=cpu4 npx playwright test --project=chromium
node android.mjs                                  # a real phone over USB, see below
node report.mjs                                   # the table
```

`SPIKE_REPEATS` (default 3) controls repeats per case. Results merge by `(case, throttle, repeat)`, so runs at different throttles accumulate instead of overwriting.

### The phone

`node android.mjs` needs a phone with USB debugging on and visible to `adb devices`, with Chrome installed. It installs nothing on the device. The harness serves from the DESKTOP and `adb reverse` makes the phone's own `localhost` reach it, so **transfer time on the device run is a USB measurement and not a mobile-network one**: the phone is there to measure parse, heap and storage, which are the parts a laptop flatters. The device's model, SoC, RAM, Android release and Chrome version are recorded in the results file beside the numbers.

Three gotchas, all of them cost a run before being fixed here, so they are worth reading before driving a device:

- **Chrome needs its OWN debugging permission**, separate from Android's USB debugging, and without it both available routes hang rather than failing. Set `chrome://flags/#enable-command-line-on-non-rooted-devices` to Enabled, relaunch Chrome, and run with `ANDROID_MODE=launch`. (The default `cdp` route wants Chrome's Developer options instead, which on a Pixel 8a running Chrome 152 exposed only a "Tracing" entry and no web-debugging switch, so the flag is the route that actually works there.) The runner fails fast with these instructions instead of hanging.
- **The phone sleeps.** A sleeping device stops servicing navigations and the run dies on a Playwright `waiting until "load"` timeout that says nothing about why. The runner now sets `svc power stayon usb` and wakes the screen; that setting reverts when the cable comes out.
- **Results are written after EVERY run, not at the end.** The first full pass completed all 21 runs and then hung in teardown, so nothing was saved and the device had to be driven again for data already collected. The process also `process.exit(0)`s once the last row is on disk rather than waiting on a teardown that can hang.

If `adb` restarts its daemon mid-run (`daemon not running; starting now`), the `adb reverse` goes with it and the phone can no longer reach the server. Re-run; the incremental results file means only the unfinished cases are lost.

## Reading the numbers honestly

**The desktop runs are a PROXY and are labelled as one everywhere.** What they cannot show: real mobile memory pressure and the eviction that follows it, slower storage, and a background tab being suspended mid-install. `SPIKE_THROTTLE=cpu4` slows the CPU and nothing else, so it is not a phone either. That is exactly why `android.mjs` exists.

**Peak heap is a FLOOR, not a ceiling.** `JSON.parse` blocks the main thread, so nothing inside the page can observe the peak DURING it, and the driver-side sampler only gets an answer when the inspector can give one. Both instruments therefore report the heap at moments they could reach; the true peak can only be higher.

**Two heap instruments, because neither is sufficient.** In-page `performance.memory` is exact enough to read between two statements but needs Chromium's `--enable-precise-memory-info` (without it every sample here read exactly 10,000,000 bytes and never moved) and cannot be enabled on a phone. The driver-side `Runtime.getHeapUsage` needs no flag and works identically on both, which is what makes desktop and device comparable. `performance.measureUserAgentSpecificMemory()`, which would be the right instrument, exists and throws `SecurityError: not available` in this Chromium even cross-origin-isolated; the reason travels with the results rather than being reported as a missing number.

**The heap instrument is calibrated, not assumed.** Every memory claim here is a MULTIPLE, so what matters is that the counter moves in proportion to what was allocated: the cut allocates N and then 2N objects and records the ratio, which comes out at 1.99 to 2.00. Two things it learned the hard way and now documents: a single large allocation is not tracked at all (a 20 MB string moved the counter by 1,920 bytes), and a delta can come back NEGATIVE when garbage collection lands inside the window.

**Long tasks are reported as `n/a` on Firefox and WebKit, never as zero.** Neither implements the `longtask` entry type; saying "0 long tasks" about an engine that does not measure them would be the most flattering possible way to be wrong. Support is decided by `PerformanceObserver.supportedEntryTypes`, not by whether `observe()` threw.

**Medians over repeats, with the spread beside them.** Peak heap depends on when garbage collection lands, and the same case measured twice in one session differed by a quarter. A single-shot number would be quoting that noise as a result.

## What this spike does NOT do

It does not fetch from a node (a seed exists precisely because the node will not serve those logs), it does not verify anything about the seed (two later tasks own identity and verification), and it does not freeze the artifact's field list: the manifest deliberately has room for an identity and a verification claim, because a shape that could not carry them would be re-opened as soon as those decisions land.
