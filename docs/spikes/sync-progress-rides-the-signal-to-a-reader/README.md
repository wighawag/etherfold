# sync-progress-rides-the-signal-to-a-reader: what every tab rendered

What "syncing, N blocks behind" looked like in REAL TABS that were not the one folding, kept so that ADR-0083's claim about sync progress riding the cross-tab channel points at an OBSERVATION rather than at a sentence.

Nothing here was measured; the file is the structured output of one case, per engine. The claims are behavioural: a tab that holds no port to the host that is folding renders exactly the report that host made, in the same words and the same numbers; a tab that holds a host of its OWN, held at its first fetch, still renders the indexing tab's position rather than its own host's standstill; and a tab OPENED AFTER the fold reached the tip -- which nothing is ever going to push to -- renders where the fold is anyway, because attaching asks.

## How it is produced

```bash
pnpm --filter @etherfold/browser test:browser syncProgressRidesTheSignalToAReader              # all three engines
pnpm --filter @etherfold/browser test:browser --project=webkit syncProgressRidesTheSignalToAReader
```

The spec is `packages/browser/browser/syncProgressRidesTheSignalToAReader.spec.ts`, on `playwright-browser-harness`: one lead harness builds and serves the bundle and the other tabs mount against the same `outdir` and `serverUrl`, which is what makes them tabs of one app on one origin. It is deliberately NOT part of `pnpm test` (the acceptance gate), because it needs `playwright install` and three browser binaries a clean checkout does not have. The node suite asserts the same claims over real `BroadcastChannel`s on every commit (`packages/browser/test/syncProgressRidesTheSignalToAReader.test.ts`), with the tabs as objects in one process, because that is the only part a node process cannot have.

## Why it is not the port's progress push

A tab that holds a port is told where the fold has got to over that port, and that push (ADR-0082, `progressPushedFromTheWorker.spec.ts`) is untouched by this and stays exactly as it shipped. The case here is the tab with NO port: it cannot ask, and it cannot work the answer out either, because the **sync cursor** is opaque behind the storage seam (ADR-0027). So the only interesting shape is several documents, one of which is folding.

## What is in `results/`

| file | what it holds |
| --- | --- |
| `one-fold-every-tab-renders-it-<engine>.json` | the whole sequence: two reader tabs listening before anything folded, the indexing tab folding to a HELD block, what each reader rendered mid-flight, the fold finishing, what each reader rendered then, and a fourth tab opened afterwards into a chain that had stopped moving |

One value is stabilised rather than recorded verbatim, for the reason the neighbouring cross-tab results stabilise theirs: a committed file must not churn on a re-run, so the run's timestamp inside the channel name becomes `<run>`. Everything else -- block numbers, phases, percentages -- is what a re-run must reproduce.

## What the three engines agreed on

Chromium, Firefox and WebKit, identically:

- **every tab rendered the indexing tab's own report.** The sequence each reader was told is element for element the sequence the indexing tab's port pushed it: `waiting`, `loading`, `loading` at block 0, `catching-up` at block 0, `catching-up` at 103 (`blocksBehindTip: 2`, `syncPercentage: 60`), `catching-up` at 105, `at-tip`. No recomputation, no reader-side derivation, no second vocabulary.
- **the two readers agreed with each other**, one holding a dedicated worker of its own and one holding nothing at all.
- **its own host was no help, and it was not consulted.** The reader with a host was held at its first fetch: `phase: 'catching-up'`, `lastToBlock: 0`, and `blocksBehindTip` ABSENT rather than `0`, because it had learnt no tip. What it put on screen came from the channel.
- **the helper is the same one.** `createProgressReadable` bound to the cross-tab end holds the last report BY REFERENCE (`holdsTheLastOneByReference: true`), exactly as it does bound to a port, so an app that moves from hosting to reading keeps its progress bar.
- **the newcomer was answered.** A tab opened after `at-tip`, on a chain nothing was going to move, was handed exactly ONE report -- where the fold IS, `blocksBehindTip: 0` -- and rendered `live`. One, and not the seven that came before it: nothing is replayed, because nothing is kept per tab.
- **one channel carried both things.** The same run's notifications rode it unchanged, blocks `100, 102, 104`.
