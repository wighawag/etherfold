---
title: Two stream-seed install refusals are indistinguishable from conditions that are not refusals
slug: two-seed-install-refusals-are-indistinguishable-from-conditions-that-are-not-refusals
---

2026-09-07, spotted while reviewing PR #99 (`a-published-stream-seed-installs-through-the-keeper-seam`). Both are about the loader's probe and its refusal vocabulary, so the admission task that extends that vocabulary is the natural place to look at them.

**A corrupt or truncated artifact is reported as `unreachable`, not as an unreadable format.** `streamSeedPayloadFrom` runs inside `fetchSeedPayload` in `packages/core/src/stream/seedInstall.ts`, and everything that throws in there maps to `unreachable`. So a host that is perfectly reachable and serving a damaged file is rendered to the application as "could not reach it". Walking to the next location is arguably the right BEHAVIOUR either way, so this is about what an app is told rather than about what the loader does; it matters because "the mirror is down" and "the mirror is serving garbage" are different things for an operator to act on.

**An unreadable substrate is indistinguishable from an empty subtree.** `degradingStream` answers `undefined` when `fetchFrom` throws (`packages/core/src/stream/degrading.ts`), and the install's emptiness probe reads `undefined` as "nothing stored, safe to write". If a subtree were in fact populated while reads were failing and writes were not, the keeper would take the seed's first batch as an overlap and store events twice, which is exactly the duplication ADR-0067's empty-subtree rule exists to prevent. This is not reachable through the seam as it stands (the install is handed a keeper directly, and the degrading wrapper is not in that path), so it is a latent shape rather than a live defect. Worth confirming it stays unreachable when the install becomes a public entry point and a caller can hand it any `ExistingStream` it likes.

Neither blocks anything today. Recording them because the admission task owns the refusal vocabulary and the public export, which is when both become decisions rather than observations.

## Update, 2026-09-07 (reviewing PR #100, where the install became public)

**The second half's reachability claim above is WRONG and should not be relied on.** It said the degrading-read hazard is "not reachable through the seam as it stands (the install is handed a keeper directly, and the degrading wrapper is not in that path)". `createSegmentedStream` wraps its own return value in `degradingStream` (`packages/core/src/stream/segments.ts:224`, and it did so already when the note was written), so EVERY segmented keeper the install can be handed goes through the wrapper. The emptiness probe therefore does read a failed `fetchFrom` as "empty" on a real keeper, not merely on a hypothetical one.

What keeps it narrow is different from what the note claimed: the corrupting window needs `port.readCursor` to FAIL inside `fetchFrom` and then SUCCEED inside `saveNewEvents` — the same call on the same port, moments apart — so a substrate that is broken enough to hide a populated subtree is almost always broken enough to fail the write too. That is a probabilistic argument rather than a structural one, which is worth knowing when deciding whether to close it.

The first half (a corrupt artifact reported as `unreachable`) is unchanged by PR #100 for the fetch/decompress path. Note though that PR #100 moved the INTEGRITY check ahead of the parse, so a corrupted document that still gunzips now reports `integrity-mismatch` when a pin was supplied, which is both accurate and more useful than either of the two reasons discussed above.

## Update, 2026-09-07 (the first half is FIXED; the second is a decision, not a repair)

**The first half is discharged.** `fetchSeedBody` (was `fetchSeedPayload`) now stops at the transport and the INFLATE happens at the call site under its own refusal, so a host that answers `200` with a corrupt or truncated body is reported `unreadable-format` rather than `unreachable`. A reached host serving a broken artifact no longer sends an operator looking at their network. Pinned by `a body that will not DECOMPRESS is an unreadable document, not an unreachable host` in `packages/core/test/streamSeedInstall.test.ts`, which truncates a real gzip so the magic bytes are present and the inflate is what fails.

**The second half is NOT a repair, and should not be fixed by whoever next reads this without a decision being made.** Tracing it properly:

- `subtreeIsEmpty` reads `undefined` from a degraded `fetchFrom` and calls the subtree empty.
- The install then writes, and `carryForward` (`packages/core/src/stream/segments.ts`) on an existing cursor keeps that cursor's `startBlock` and `nextOrdinal`. The seed's first batch has `lastFromBlock` at the capture's coverage start, which is at or below the stored `lastToBlock + 1`, so it is NOT declined as a hole. It is appended after the existing segments, and the cursor's `lastFromBlock`/`lastToBlock` are overwritten with the seed's, moving them BACKWARDS.
- So the outcome is duplicated events under a cursor that lies, inherited by every later generation. Not a crash, and nothing detects it.

The window needs `port.readCursor` to throw inside `fetchFrom` and then succeed inside `commitSegmentWithCursor` — the same call on the same port, moments apart. Narrow, and transient IndexedDB failures are exactly that shape.

There are at least three candidate shapes and they trade differently, which is why this is a fork rather than a fix:

1. **Accept and document.** Cheapest. Leaves a silent-corruption path open on a transient fault.
2. **`clear()` before the first write.** Makes emptiness TRUE instead of assumed, and is a no-op on the ordinary path. But it puts a destructive operation on a path whose whole ADR (ADR-0067) is about not destroying, and on the bad branch it deletes the stream rather than corrupting it — better, but still data loss from a transient read error.
3. **Let the keeper report an unreadable read distinctly from an absent one.** The honest fix, and the expensive one: `ExistingStream` has one read and third parties implement it, and ADR-0067 already declined to widen this seam for a weaker reason (a presence read for the ordinary case). An optional method degrades gracefully for keepers that do not implement it.

This is the same shape as the `readOnlyStream` self-clear defect (`a-follower-can-self-clear-the-writers-stream-through-the-read-only-view.md`), which `a-browser-app-starts-from-a-published-artifact` deliberately kept out of scope on exactly this ground: a design call with several candidate shapes belongs to the seam's own ADR, not to a task that happens to touch it. It probably belongs with ADR-0044/ADR-0067 and with that observation, since both are `degradingStream`/`readOnlyStream` behaving correctly for a READER and wrongly for a WRITER.
