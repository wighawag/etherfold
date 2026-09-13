# a-reader-tab-learns-from-the-indexing-tab: the cross-tab evidence

What the **state-moved signal** did between REAL TABS of one browser profile, kept so that ADR-0083's second transport points at an OBSERVATION rather than at a claim.

Nothing here was measured; the file is the structured output of one case, per engine. The claims are behavioural: a tab that is not doing the indexing, and holds no port to the host that is, re-reads to the writer's state because it was TOLD; a tab of a different store on the same origin hears nothing while that store is demonstrably being talked about; a listener that attaches half way through is handed nothing for the blocks it missed and converges on the next notification.

## How it is produced

```bash
pnpm --filter @etherfold/browser test:browser readerTabLearnsFromTheIndexingTab              # all three engines
pnpm --filter @etherfold/browser test:browser --project=webkit readerTabLearnsFromTheIndexingTab
```

The spec is `packages/browser/browser/readerTabLearnsFromTheIndexingTab.spec.ts`, on `playwright-browser-harness`: one lead harness builds and serves the bundle and the other tabs mount against the same `outdir` and `serverUrl`, which is what makes them tabs of one app on one origin. It is deliberately NOT part of `pnpm test` (the acceptance gate), because it needs `playwright install` and three browser binaries a clean checkout does not have. The node suite asserts the same claims over real `BroadcastChannel`s on every commit (`packages/browser/test/aReaderTabLearnsFromTheIndexingTab.test.ts`), with the two tabs as two objects in one process, because that is the only part a node process cannot have.

## Why it is not the shared-worker case

The nearest existing case puts several tabs on ONE host. Those tabs already hold a port to it and are already pushed its notifications, so a channel test there would pass while demonstrating nothing. The case that proves this signal is tabs with their OWN hosts against one database, which is also the shape an app has before `one-tab-indexes-and-the-others-read` exists.

## What is in `results/`

| file | what it holds |
| --- | --- |
| `two-tabs-one-database-<engine>.json` | the whole sequence: the reader tab opening its own host and its two channels, the app NEXT DOOR folding a chain into another store, the silence that produced, the indexing tab folding to a held block, a listener attaching half way through, the fold finishing, and what the reader tab was told and read because of it |

Two values in it are stabilised rather than recorded verbatim, for the reason the shared-worker results stabilise a host `instance`: a committed file must not churn on a re-run. Each distinct **coherence token** becomes `fold-1`, `fold-2`, ... in order of first appearance -- the relation is the evidence (every notification of one fold carries the same token, another fold's is a different one), the entropy is not -- and the run's timestamp inside a database name becomes `<run>`.

## What the three engines agreed on

Chromium, Firefox and WebKit, identically:

- **the reader tab was told, and read.** Three notifications, blocks `100, 102, 104`, each naming the entities that block touched (`counter`, `token`), all under ONE coherence token. The state it read after the last one is the state the indexing tab folded (`transfers: 5`), read through a handle it opened for READING and has held all along.
- **what crossed the channel is what crossed the port**, element for element: the reader tab's recording equals the indexing tab's own `onStateMoved` recording. That is the adapter claim -- an app writes one handler.
- **the app next door was not heard.** It folded the same fixture to its tip in its own tab, into its own database, publishing every block on its own channel; the reader tab heard all of it on the channel scoped to THAT store and not one word of it on its own, and had re-read zero times when it was asked.
- **nothing was buffered.** A listener attaching after blocks 100 and 102 had been published held nothing at all, was told about 104 alone, and read the whole fold -- including the two blocks nobody told it about.
- **nothing named a publisher.** Every notification carries exactly `{kind, block, coherence, entities, generation}`, on every channel, so no reader could have asked who was indexing.
