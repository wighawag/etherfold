---
'@etherfold/core': minor
'etherfold': minor
---

**An arrival naming the generation `predecessor` holds now RE-ARMS it as `successor`, so a rollback by upload or by configuration actually rolls back** (ADR-0094; ADR-0084's and ADR-0092's amendments of 2026-09-26).

- `GenerationRegistry.create(id, {slot: 'successor'})` for the generation `predecessor` names MOVES it into `successor` and empties `predecessor` in the same commit (one generation is never named by two slots). It used to leave it where it was. The pointer does not move: the promotion policy decides, as for any successor. `canonical` and `successor` arrivals are unchanged.
- `displacedBySuccessor` displaces the pending successor when the arriving generation is what `predecessor` names, since it takes that slot. It still displaces nothing for an arrival `canonical` or `successor` already names.
- `ReceivingIndexer.add` of a generation this container already FOLDS builds no second fold: it registers it again (re-arming a held predecessor) and applies the policy to the fold it holds. At `open`, a configured fold naming the predecessor while a DIFFERENT successor is pending asks `confirmReplacingSuccessorAtStart` with `kind: 'replace'`; with nothing pending it re-arms unasked.
- `etherfold upload` of the previous version's bundle to a `node` answers `registered` and the node goes back to it through a normal promotion, with no engine left for the generation `predecessor` names. `unchanged` is answered only for a held generation `canonical` or `successor` already names.
- `run`, `build` and `index` started with a `-p` naming the predecessor re-arm it (a rollback by configuration), behind the start guard where a different successor is pending. This includes a `run` restarted with an unchanged `-p` after an operator's revert: it names the generation reverted away from, so it rolls forward again. To keep a revert across a restart, change `-p`, or revert on a `node`.
