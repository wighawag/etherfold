---
'@etherfold/browser': patch
---

**The legacy whole-blob stream compatibility path is deleted.**

`keepStreamOnIndexedDB` carried a probe for a stream written by an older, flat-key format: a `legacy` address beside every stream subtree, a `hasLegacyBlob` read on the way into every `fetchFrom`, an `inconsistent` status reporting a blob this build cannot adopt, and a paired delete in `clear`.

It was already decided that such a blob would never be ADOPTED, and for the right reason, recorded where the probe lived: adopting it "would spare a re-index for users who do not exist". The detection was kept anyway. So every indexing cycle paid an IndexedDB read looking for data that cannot exist, through a wrapper whose only other job was to forward five calls, for a status branch that could never fire.

It also propped up a live decision from a dead one. `keyval.ts` justified sharing `idb-keyval`'s default store partly because "a keeper that quietly opened a store of its own would never SEE the legacy blob it is required to delete". That store choice stands on its two remaining reasons, which are about `clear` semantics and are unaffected; the justification no longer leans on a blob nobody has.

Nothing about the stream format changes, and nothing that could exist is read differently. `fetchFrom` and `clear` go straight to the segmented keeper, and both still RAISE through on an unreadable store, which the degradation suite asserts independently of which call gets there first.
