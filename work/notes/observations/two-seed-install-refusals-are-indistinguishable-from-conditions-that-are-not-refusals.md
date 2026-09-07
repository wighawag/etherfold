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
