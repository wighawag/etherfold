# A rebuild (and a follow) cannot start while the fold is within `finality` of the stream's start block

2026-09-13, noticed while building the state-moved transport conformance fixtures (`one-handler-for-every-transport`).

A FOLLOWER asks the stored stream from `getFromBlock(...)` = `latestBlock - finality` once it is level, and a receiving container's `rebuildMore` does the same. The stream's own `startBlock` is where its first batch was accepted from, which is the source's `startBlock`. So while the canonical fold's cursor is still within `finality` blocks of that start block, the replay asks from BELOW it, the keeper honestly answers `does-not-reach-back`, and the follower/rebuild makes no progress at all and reports the same stop reason every call. It resolves itself as soon as the chain moves `finality` blocks past the start, so on a real chain it is a few seconds; it bites in FIXTURES, which routinely sit level with their own start block (it cost two rounds of debugging here, once in `packages/browser` and once in `packages/server`, before both fixtures were given a lead). Not investigated: whether a caller can tell this apart from a genuinely damaged stream, and whether `retryCanAdvance` says "call again" here or "this needs a human".

## 2026-09-13, the mechanism located, and the open question sharpened

It is one expression, `getFromBlock` (`core/src/internal/engine/utils.ts`):

```ts
lastSync.latestBlock === 0
  ? defaultFromBlock
  : Math.max(Math.min(lastSync.lastToBlock + 1, lastSync.latestBlock - finality), 0)
```

The `min` has two terms and both are wanted: `lastToBlock + 1` is "carry on from where I stopped", and `latestBlock - finality` is "but never start above the bottom of the unconfirmed window", because anything inside that window can still reorg and must be re-read rather than trusted. When a fold is LEVEL the second term wins and deliberately pulls the read start BACKWARDS by `finality`.

**The defect is the floor: it is `0`, not the stream's start.** With a stream starting at 100, a fold level at 100 and `finality: 3`, the read start is `min(101, 97) = 97`, the stream begins at 100, and the keeper honestly answers `does-not-reach-back`.

The same condition then produces two DIFFERENT behaviours, which is what makes it confusing to meet:

- A generation reading its OWN cached stream clears it and re-indexes ("it starts at X and does not reach back to Y ... costs a re-index and nothing more"). Self-healing, and cheap while the stream is young.
- A FOLLOWER or `rebuildMore` reaches the same code through `readOnlyStream`, whose `clear` is a no-op by design so a follower cannot destroy the stream its writer is still appending to (ADR-0044). It therefore cannot repair and cannot progress, and returns the identical stop reason on every call until the chain moves `finality` blocks past the start.

So the open question above is a real diagnosability defect, and it is now stateable: `does-not-reach-back` means BOTH "this stream is younger than the finality window, wait a few seconds" AND "this stream genuinely cannot serve that range, intervene". A caller cannot tell them apart and they want opposite responses.

**Candidate fix, wanting verification rather than a drive-by edit.** `getFromBlock` already receives `defaultFromBlock`, documented as "the earliest block a source can have anything to say about ... the floor `getFromBlock` returns before anything has been indexed". It applies that floor on the `latestBlock === 0` branch and drops to `0` on the other. Clamping up to it never skips anything, since blocks below it do not exist. The caveat that needs checking first: `defaultFromBlock` is the SOURCE's earliest block while this note is about the STREAM's start, and those can diverge for a seed-installed stream. It is also the read-start rule for EVERY fold, so it wants a test rather than confidence.
