---
'etherfold': minor
---

`etherfold publish` and `etherfold build --publish` print a `new processor:` line, followed by one `  held: <identity>` line per processor the index already held, when the processor they just published is not among those `publication.json` held a snapshot of on the same stream. That is the bundle's identity moving since the last publication into the directory (its code changed, or a dependency it bundles did, such as an etherfold upgrade), which previously nothing reported. `WrittenPublication` gains `processorsHeldBefore`, and `processorIsNewTo(written)` is exported.
