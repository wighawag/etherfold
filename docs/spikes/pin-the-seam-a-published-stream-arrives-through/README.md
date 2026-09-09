# Spike: can a published capture be installed into a keeper and folded with no node?

Evidence for [ADR-0063](../../adr/0063-a-published-stream-seed-arrives-through-its-own-loader-and-installs-through-the-keeper-seam.md), which is where the decision lives. Task: `pin-the-seam-a-published-stream-arrives-through`, from the exploration spec `a-generation-can-be-seeded-from-a-published-artifact`.

## The one question

A captured fixture is not a stream keeper and cannot be handed to an indexer as one (ADR-0059), and the keeper seam takes only the raw stored event (ADR-0060). So seeding has to WRITE into a keeper, and the question this spike exists to answer is whether that write is expressible through the PUBLIC seam alone:

> Can a published capture be installed with nothing but `ExistingStream.saveNewEvents`, and then folded by a generation that never reaches a node and never re-scans from the start block?

Yes, on all three counts. The answer is the deliverable; this code is not.

## What it runs

`install.mjs` is the candidate install, kept separate on purpose so the measuring task (`measure-what-a-published-stream-costs-to-install-and-pick-its-shape`) can measure the install that was actually pinned rather than one it re-derives. **That file is the install path.** It cuts the capture into batches on block boundaries, strips each event's decoded half, and calls `saveNewEvents` once per batch with the block arithmetic ADR-0063 describes.

`spike.mjs` drives three cases against the real `keepStreamOnIndexedDB` keeper on `fake-indexeddb`:

1. **install, then fold with no node.** The provider answers `eth_chainId` and THROWS on everything else, so "no node in the loop" is enforced rather than checked afterwards.
2. **the reload.** A second generation over the same keeper: nothing is cleared, nothing is fetched.
3. **a negative control.** The same capture with `data` and `topics` removed. `reparse` refuses an event with no raw log and the load path CLEARS the subtree (ADR-0034), so a decode-only capture is a valid replay input and is not a seed. The committed fixture WAS this case until 2026-09-06.

## Re-running it

```sh
pnpm install && pnpm build     # it imports the built dist/ of core and browser by relative path
node docs/spikes/pin-the-seam-a-published-stream-arrives-through/spike.mjs
```

It takes a few seconds, asserts every claim it prints, exits non-zero if any case fails, and writes `results/seam.json`.

## Reading the numbers honestly

**The timing it records is worthless and is labelled as such in the output.** `fake-indexeddb` is a shim whose write cost is known to grow quadratically (`fake-indexeddb-write-cost-grows-quadratically`), and node is not a browser. This spike establishes that the seam is CORRECT, never what it costs. Cost is the next task's entire subject, in real browsers.

Two numbers in the output that ARE meaningful, because they are structural rather than timed: 31,332 events install as **30 segments plus exactly one cursor record**, and the cursor after loading reads `lastToBlock 23400000`, which is the capture's coverage end and above its last event-bearing block (23,303,136). The second one is the whole point: a seeded client resumes from where the capture REACHED, not from where its last log happened to be, and not from the start block.

## What this spike does NOT do

It does not fetch anything (the loading interface is the ADR's decision, and this takes a fixture already in hand), it checks nothing about whether the seed is for this stream or whether it is trustworthy (two later tasks in the same spec own those), and it changes no shipped code. It is prototype code answering one question, per the source spec's rule that a spike must not quietly become the implementation.
