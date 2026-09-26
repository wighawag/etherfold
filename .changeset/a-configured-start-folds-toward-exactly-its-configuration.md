---
'@etherfold/core': minor
'etherfold': minor
---

A configured start folds toward EXACTLY its configuration (ADR-0094). A `run`, `build` or `index` whose `-p` names the CANONICAL generation while a DIFFERENT generation is pending in the `successor` slot now DISCARDS that successor (its row, its state and its stored bundle) instead of leaving it to be promoted, so a configured command never serves, and a re-run `build` never publishes, code its configuration does not name. It is guarded exactly as a replacement is: asked at a terminal, refused elsewhere unless `--override`, and a refusal deletes nothing. `-p` naming the pending successor itself, or the canonical generation with nothing pending, still changes nothing.

`@etherfold/core`: `ReceivingIndexer.open` discards the pending successor before instantiating it, and `SuccessorReplacementAtStart` (what `confirmReplacingSuccessorAtStart` is asked with) is now a union discriminated by `kind`: `{kind: 'replace', pending, arriving}` or `{kind: 'discard', pending, canonical}`. A host that passes no `confirmReplacingSuccessorAtStart` discards without asking, as it already replaced without asking.

`etherfold`: the start guard words a discard as a discard ("Discard it? [y/N]"), and the `--override` help says it covers both.
