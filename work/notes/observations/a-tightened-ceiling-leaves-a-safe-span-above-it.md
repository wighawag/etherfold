# A tightened ceiling leaves a safe span above it, and the next range asks for ONE block

2026-09-08, noticed while building `the-learned-range-is-reported-and-can-be-configured-back-in`.

In `RangeLogFetcher` (`packages/core/src/internal/engine/RangeLogFetcher.ts`), `lowerBlockCeilingTo` can put `foundNumBlockToHigh` BELOW a `safeNumBlock` that an earlier successful fetch had already established -- a provider that tightens its cap mid-run, or states a cap smaller than a span it has already answered, does exactly that. Two things then follow, both pre-existing and neither introduced by the reporting/configuration change:

1. the pair is INCOHERENT: a span cannot be both known-safe and at or above a width that was refused. It is now visible, because `learnedRange` reports both numbers (the configuration side drops such a span rather than believing it);
2. the error-path bisection reads `Math.floor((foundNumBlockToHigh - safeNumBlock) / 2)` -- a bisection STEP with no base, unlike the success path one screen down, which reads `safeNumBlock + Math.floor(...)`. With the ceiling under the safe span that expression is negative, so the `Math.max(1, ...)` guard fires and the next request asks for a SINGLE block before climbing back. Pinned incidentally by the `lowers a configured CEILING the provider refuses` case in `packages/core/test/rangeLogFetcher.test.ts`.

Costs round trips and nothing else (it recovers on the following call), which is why it was not touched here: changing that arithmetic moves the halving path every deployment depends on, and this task's fence is reporting and configuring the range rather than re-deriving how it adapts.

## Resolved 2026-09-08

Fixed. `lowerBlockCeilingTo`, the only writer of the ceiling, now DROPS a `safeNumBlock` the new ceiling contradicts (the same rule the seeding path already applied to a configured range), so the incoherent pair cannot form. The error-path bisection was also given the base it was missing, `safeNumBlock + Math.floor((ceiling - safeNumBlock) / 2)`, matching the success path one screen down: without it, knowing a safe span made the fetcher ask for LESS than the no-safe-span branch would have. Both are covered by tests in `packages/core/test/rangeLogFetcher.test.ts` (`drops a safe span the newly lowered ceiling contradicts`, `bisects UP from the safe span on the error path`), and the `lowers a configured CEILING the provider refuses` case now expects a 1,999-block recovery request instead of the single block that documented this defect.
