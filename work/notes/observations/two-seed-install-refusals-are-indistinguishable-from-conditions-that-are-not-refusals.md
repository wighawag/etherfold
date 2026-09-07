---
title: Two stream-seed install refusals are indistinguishable from conditions that are not refusals
slug: two-seed-install-refusals-are-indistinguishable-from-conditions-that-are-not-refusals
---

2026-09-07, spotted while reviewing PR #99 (`a-published-stream-seed-installs-through-the-keeper-seam`). Both are about the loader's probe and its refusal vocabulary, so the admission task that extends that vocabulary is the natural place to look at them.

**A corrupt or truncated artifact is reported as `unreachable`, not as an unreadable format.** `streamSeedPayloadFrom` runs inside `fetchSeedPayload` in `packages/core/src/stream/seedInstall.ts`, and everything that throws in there maps to `unreachable`. So a host that is perfectly reachable and serving a damaged file is rendered to the application as "could not reach it". Walking to the next location is arguably the right BEHAVIOUR either way, so this is about what an app is told rather than about what the loader does; it matters because "the mirror is down" and "the mirror is serving garbage" are different things for an operator to act on.

**An unreadable substrate is indistinguishable from an empty subtree.** `degradingStream` answers `undefined` when `fetchFrom` throws (`packages/core/src/stream/degrading.ts`), and the install's emptiness probe reads `undefined` as "nothing stored, safe to write". If a subtree were in fact populated while reads were failing and writes were not, the keeper would take the seed's first batch as an overlap and store events twice, which is exactly the duplication ADR-0067's empty-subtree rule exists to prevent. This is not reachable through the seam as it stands (the install is handed a keeper directly, and the degrading wrapper is not in that path), so it is a latent shape rather than a live defect. Worth confirming it stays unreachable when the install becomes a public entry point and a caller can hand it any `ExistingStream` it likes.

Neither blocks anything today. Recording them because the admission task owns the refusal vocabulary and the public export, which is when both become decisions rather than observations.
