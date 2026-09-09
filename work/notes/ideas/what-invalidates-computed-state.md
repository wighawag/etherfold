---
title: 'What should invalidate computed state, and why `version` is the right mechanism under the wrong name'
slug: what-invalidates-computed-state
---

## The question

`version` is how a processor tells the indexer that previously computed state is no longer something this code would produce. It buys the thing a content hash cannot: an edit that does NOT change meaning (a refactor, a comment, a rename) costs nothing. It pays for that with the failure everyone meets eventually: forget to bump, and state computed by the old logic is adopted and served forever.

So: is there a better mechanism?

## The modelling problem underneath the naming problem

The field is being asked two different questions at once:

1. **"Would this code produce a different state than the one stored?"** A fact about the CODE.
2. **"Do I need to re-scan history?"** A fact about the code AND the data AND the cursor.

They come apart, and the case that separates them is ordinary. "Update the processor to support the upgraded contract" needs a rebuild if the upgrade is already below the cursor, and needs none if it is above. **Same edit, same code, opposite answers.** No field on the processor can carry that, because it is not a property of the processor.

That is worth holding onto, because it explains why every candidate replacement below either over-invalidates or ends up needing a developer assertion somewhere else.

## Why the strict content hash is wrong, twice

Hashing the module (any byte change means "logic changed") was already rejected once, in ADR-0008's amendment: a minifier or transpiler re-emits identical behaviour differently, so every deploy would force a full rebuild for no logic change.

There is a second, independent reason, and it is the one that is not written down anywhere: **a processor edit can be additive with respect to existing state.** Adding an `onApproval` handler in preparation for an upgrade that adds `Approval` events changes nothing about how any `Transfer` was processed. The stored state is still exactly what this code would produce. A content hash cannot see that, and no refinement of hashing can, because the fact lives in the DATA (were there any `Approval` logs down there?) and not in the file.

So the content hash over-invalidates for two unrelated reasons. It stays rejected.

## The name

`version` invites bumping on release, which is over-invalidation, and does nothing to discourage under-bumping, which is silent staleness. It reads like metadata when it is actually a command.

What the field means is: **changing this throws away every previously computed state and re-indexes from the start block.**

`stateVersion` has the right precedent, since a schema version in a migration system means exactly this and nobody confuses it with a release version. `rebuildKey` or `invalidatesState` say it louder at the cost of reading oddly beside `entities`. Renaming changes no behaviour and only makes the doc line honest, so it is worth spending the breaking change only when something else touches that authoring surface.

## The cheap fix, and it needs no core change

The asymmetry that makes this tractable:

- **Forgetting to bump is a DEVELOPMENT-time failure.** You are editing handlers in a hot-reloading tab.
- **The minifier false positive is a BUILD-time failure.** You are shipping.

They never coincide, so the right behaviour differs by environment rather than being one global compromise. And the machinery is already there: the fingerprint is computed, the drift is detected, and it is detected in the adopt branch BEFORE the state is adopted.

Verified end to end (`fromJSProcessor` + `keepStateOnIndexedDB`, two sessions, an edited handler under an unchanged `version`):

| | result |
| --- | --- |
| session 1, `+= 1` | `{transfers: 5}` |
| session 2, edited to `+= 10`, version unchanged | `{transfers: 5}` — the stale state, adopted |
| drift reports | **1** |
| after the host calls `reset()` in response | `{transfers: 50}` — rebuilt under the new logic |

So **rebuild-on-drift is already expressible today**, with no API change:

```ts
let drifted = false;
core.onProcessorDrift = () => { drifted = true; };
// ...after load settles:
if (drifted && import.meta.env.DEV) await indexer.reset();
```

Turn it on in development, leave it off in production, and forgetting to bump stops mattering in the loop where it happens while re-minification never triggers a rebuild in the loop where it would hurt. This is a DOCUMENTATION change, not a feature, which is the main reason to prefer it: it belongs in the browser guide beside the axis-one warning, and possibly as a line in `createIndexerState`'s docs.

A first-class `onDrift: 'report' | 'refuse' | 'rebuild'` config would be tidier than the flag-and-reset dance (`strictProcessorDrift` already occupies two thirds of that enum). Worth doing only if the pattern proves awkward in practice; it is three lines of host code today.

**Caveat, and it is not small.** Drift detection has a hole: the fingerprint is blind to closure-captured values, so a factory-built processor fingerprints identically whatever it captures, and neither guard fires. See `work/notes/findings/the-processor-fingerprint-is-blind-to-closure-state.md`. Rebuild-on-drift inherits that hole exactly, so it makes the common case safe rather than making the mechanism sound.

## The more ambitious idea, recorded rather than proposed

**Fingerprint per handler, and compare only the handlers that actually RAN.** The cursor would record which event names were processed; on load, only those handlers' fingerprints are compared.

- adding `onApproval` for an event that never occurred: no stored entry, no mismatch, adopt. The additive case above, resolved with no human judgement at all.
- editing `onTransfer` when transfers were processed: mismatch, discard. Correct.
- editing `onTransfer` when none had occurred yet: adopt, and correctly, since nothing was computed by it.

The catch is the interesting part, and it is the same one that runs through this whole note: **"did an `Approval` occur below the cursor?" is unknowable to the indexer**, because `Approval` was not in the ABI, so its logs were never fetched. The indexer cannot distinguish "there were none" from "we never asked".

Which means this does not stand alone. It is the processor-side half of exactly the question `work/tasks/done/abi-versions-are-block-ranged.md` answers on the source side, and the two compose: the boundary block says "`Approval` could not have occurred before B", the handler map says "`onTransfer` is unchanged", so the state is adopted. Neither half is sufficient alone.

Costs: a per-handler map in the cursor (it rides in `ContextIdentifier`, which every persistence path already round-trips whole), and no help at all with the closure hole or with minification, so it still wants the dev/prod split above.

## Where this lands

`version` stays. It is the only mechanism that can express "this edit does not invalidate", and that is a judgement only the author can make: the content hash cannot make it, and the per-handler scheme still needs the author's assertion, merely relocated to the ABI boundary.

What is fixable is not the mechanism but the FAILURE MODE, in descending order of value per unit of work:

1. **Document rebuild-on-drift in development.** No code, verified working, closes the failure in the loop where it happens.
2. **Document routing behaviour-bearing parameters through `configure()`** rather than a factory closure, which is what makes both guards work at all (see the finding).
3. **Rename `version`**, when something else touches that surface.
4. **Per-handler fingerprints**, only alongside the ABI boundary work, and only if the additive-edit case proves common enough to be worth a cursor format change.
