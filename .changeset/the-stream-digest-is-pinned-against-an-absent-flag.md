---
'@etherfold/core': patch
---

**The answer, pinned as a test: deleting `alwaysFetchTimestamps` and `alwaysFetchTransactions` does NOT move the stream digest of a deployment that never set them.** No stream forks, nothing is orphaned, and no history is re-fetched from the node.

The mechanism, which is what `packages/core/test/aDeletedStreamFlagDoesNotMoveTheDigest.test.ts` asserts rather than assumes: `resolveStreamConfig` omits a key whose value is `undefined`, so an unset flag contributes NO KEY to the resolved config, and the stream digest is taken over that config's canonical bytes. A field that puts nothing into the preimage takes nothing out of it when it goes. Written out, the resolved config of a no-flag deployment is `{finality}` and nothing else, both before the deletion and after it.

The digest half asserts against LITERAL RECORDED BYTES and never against a recomputation, and that is the whole point of it: a test that computes both sides passes happily when the digest FUNCTION moves, which is precisely the failure worth catching, since a moved digest re-addresses every stored stream in existence and reports nothing while doing it. Those constants are not to be updated to match a new answer. The other half is the same claim where it bites -- a stored stream written under a no-flag config, read back through the ordinary load path against a keeper that ADDRESSES by the digest, landing on the same subtree with no fork, no clear and no re-fetch.

What does NOT survive, and is stated rather than engineered around (ADR-0073): a deployment that DID set one of the flags stored its stream at a different address, so it re-fetches from the source's start block and its old subtree is left where it is. Nothing is owed to it -- nothing is published, and a change that re-indexes is acceptable so long as it is known rather than discovered.

Tests only; no API, no behaviour and no stored format changes here. The deletion itself is a separate change.
