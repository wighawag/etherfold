---
title: 'Three docs say pre-0.20 EDR cache entries "keep answering"; the 0.20.0 release note says they are ignored'
slug: edr-cache-segmentation-claim-reads-backwards
observed: 2026-09-08
source: 'spotted while re-verifying the EDR version facts for the task `the-edr-requirement-and-the-scope-of-the-claim-are-documented`; upstream text is the `@nomicfoundation/edr@0.20.0` release notes, https://github.com/NomicFoundation/edr/releases, retrieved 2026-09-08'
---

ADR-0073 ("The refusal is PERMANENT machinery"), ADR-0002's block-timestamp bullet and the `TimestamplessLogError` docstring in `packages/core/src/errors.ts` all say EDR's on-disk RPC cache is version-segmented "so entries written before the change keep answering without the field", but the `@nomicfoundation/edr@0.20.0` release note says the opposite about those entries: the cache moved to `rpc_cache/v2` and "everything else in `rpc_cache` is ignored and can be deleted".

The conclusion those documents draw is unaffected (a stale cached ABSENCE is still reachable at any version, because a v2 entry recorded from a FORKED pre-spec remote persists until `rpc_cache` is dropped, and the forked-node cause stands on its own), so the refusal is still permanent machinery; only the mechanism named is wrong. The root README now states the accurate form; the ADRs, the changesets and the error docstring were left alone as out of scope.
