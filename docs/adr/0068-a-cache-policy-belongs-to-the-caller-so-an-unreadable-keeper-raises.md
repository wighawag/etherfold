# A cache policy belongs to the CALLER, so an unreadable keeper RAISES

A stream keeper whose substrate cannot be read now raises from `fetchFrom` and `clear` instead of answering ABSENT, and `degradingStream` is deleted. The rule it encoded is unchanged and still enforced -- a cache that cannot be read costs a re-index and never the indexer -- but it is applied at the CALLER that owns it (`IndexerGeneration.readStoredStream` / `clearStoredStream`) rather than at the seam. `installStreamSeed`, the other caller, applies the opposite policy and refuses with `subtree-unreadable`.

## The problem: a policy at the seam binds every caller, including one for whom it is false

`degradingStream` was a wrapper each keeper applied to ITSELF, so no caller could opt out. What it asserted is a statement about the load path: *a generation responds to an absent stream by re-indexing, so losing a cache costs time and nothing else.* True, and worth keeping.

It is not true of a caller that responds to an absent stream by WRITING. `installStreamSeed` reads emptiness as permission to install (ADR-0067: install only into an EMPTY subtree). Told "empty" about a subtree that was merely unreadable, it appended a seed underneath a stream that was really there, and the keeper's own guards do not catch it: `carryForward` keeps the existing cursor's `startBlock` and `nextOrdinal`, and the seed's first batch sits at or below `lastToBlock + 1`, so it is not declined as a hole.

The measured result, with a VALID seed against a subtree holding a real stream whose reads were failing while its writes worked: `{status: 'installed'}` returned, two segments where there had been one, and the cursor's `lastToBlock` moved BACKWARDS from 600 to 200 while `startBlock` stayed at 500 -- a cursor claiming a stream from 500 through 200 over events at 500 and 110. Reported as SUCCESS, silent, permanent, and re-folded by every later generation.

A keeper cannot know which kind of caller it has. So it stops deciding.

## Why not the alternatives

**Keep the wrapper and let the installer opt out.** There is nothing to opt out of: the wrapper is applied inside `createSegmentedStream`, so an installer handed an `ExistingStream` cannot reach the unwrapped keeper, and a caller-supplied flag would put the policy back at the seam with an extra parameter.

**`clear()` before the first write, to make emptiness true rather than assumed.** A no-op on the ordinary path, and it turns silent corruption into silent data loss: a stream that could not be READ is destroyed in order to install over it, chosen on a transient fault. It also puts a destructive call on the one path whose ADR is about not destroying.

**A separate presence read on the seam.** ADR-0067 already declined to widen `ExistingStream` for a weaker reason. It also adds a fifth thing to a seam whose problem is that one thing already means several.

## What each caller does now

- **The generation** catches and treats it as absent, logs the same message the wrapper logged, and re-indexes from the source's start block. Behaviour is unchanged, including for a raising `clear` -- reporting absent is what MAKES the load path clear, so a raising `clear` would move the outage one line down. Asserted by `anUnreadableCacheDoesNotWedgeOrCorrupt.test.ts` and, through the real IndexedDB keeper, by the browser's existing "an app whose stream store is unusable" case.
- **The installer** refuses with `subtree-unreadable`, as DATA, writing nothing and clearing nothing. It is deliberately its own reason and not `subtree-not-empty`: one says "there is a stream here", the other says "I cannot tell", and an app may want to say those differently. It is usually transient, so the remedy is to try again.

The WRITE side is unchanged and still raises through to `promiseToSave`, which counts, paces, freezes and does not process the batch until it succeeds -- a swallowed write failure would let the state advance past events the stream never received, which is a HOLE. That asymmetry is the whole reason only the read side ever degraded. One nuance the deleted wrapper also provided: it was `async`, so a keeper throwing SYNCHRONOUSLY still handed back a rejected promise. `promiseToSave` awaits inside a `try`, and a synchronous throw in a `try` is caught by the same `catch`, so both shapes land on `onStreamWriteFailed` either way.

## Timing

Done now because it is nearly free now and permanently expensive later: two implementations of `ExistingStream` and four `fetchFrom` call sites exist, all in this repository, and nothing is published (`CONTEXT.md`). Once `publish-etherfold-and-deprecate-old-names` lands this stops being a refactor and becomes a breaking change to a published seam with implementors outside our control.

## What this does NOT fix

`fetchFrom` still REPAIRS as well as reads: `createSegmentedStream` clears the subtree on four of its five absent branches, and callers cannot have the read without the repair. That is what still forces `installStreamSeed` to probe from `Number.MAX_SAFE_INTEGER` to dodge the clear-on-does-not-reach-back branch, and it is why a follower reading through `readOnlyStream` can still clear the writer's stream (`work/notes/observations/a-follower-can-self-clear-the-writers-stream-through-the-read-only-view.md`). Separating the repair from the read is the same principle applied one level further and is deliberately a separate change.
