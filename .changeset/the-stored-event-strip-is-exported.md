---
'@etherfold/core': minor
'@etherfold/browser': patch
---

`storedEventOf` and `storedStreamOf` are exported from the package entry, so code OUTSIDE the package reduces a decoded event to a stored one through the ONE implementation of that rule.

```ts
import {storedEventOf, storedStreamOf} from '@etherfold/core';

await keeper.saveNewEvents(source, {
	eventStream: storedStreamOf(events), // no local copy of the three-key destructure
	lastSync: {context, latestBlock, lastFromBlock, lastToBlock, unconfirmedBlocks: []},
});
```

**What justifies the export, because it decides how far it goes.** The keeper seam takes only what the node said and the decoded half (`args` / `eventName` / `decodeError`) is a cache re-derived on read (ADR-0060), so anything that WRITES a stream applies this strip. The engine's own writes reach it internally; what could not was a seed PRODUCER or an installer written outside core, and the evidence is committed — `docs/spikes/pin-the-seam-a-published-stream-arrives-through/install.mjs` copied the destructure, which is the duplication ADR-0060 exists to prevent. ADR-0063 names publishing these as a build item.

**The cursor strip stays internal.** `storedLastSyncOf` is not published: an installer BUILDS the cursor it writes (an empty window and the capture's own block numbers, ADR-0063) rather than stripping a live one, so publishing it would offer an outside caller a tool for a job it does not have. It is one addition to widen if a producer turns out to need it.

Nothing inside core changed: this is a re-export of the module the engine already uses, so the strip still happens once, on the way into `saveNewEvents`, and no existing behaviour or test moves. Reachability THROUGH THE ENTRY is pinned from a consumer's suite (`@etherfold/browser`'s `storedStripIsPublished.test.ts`), because a test beside the function cannot see it — which is the whole of that package's change here, and why it is a patch with no runtime difference.
