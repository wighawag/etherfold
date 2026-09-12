---
'@etherfold/browser': minor
---

`checkTxInclusion` asked from a TAB and answered by its HOST, so an app whose indexer runs in a worker can still lay an optimistic update over indexed state without double-counting.

The verdict is the one answer on this port that must not be simplified on the way across, and it is not: `IndexerPort.checkTxInclusion` takes the app's whole pending set in ONE round trip and hands back `@etherfold/core`'s `TxInclusionVerdict` per hash, unchanged -- a STATUS and the BASIS for it.

```ts
const verdicts = await indexer.checkTxInclusion(pending.map(({hash, block}) => ({txHash: hash, minedAtBlock: block})));
for (const {hash} of pending) {
  if (verdicts[hash].status === 'included') overlay.drop(hash); // the fold has it: stop predicting it
}
```

**The basis is what an app renders, not the status alone.** `unknown` has two distinct causes -- nothing is synced yet (`not-synced`), and the fold is so far behind the tip that its window says nothing about the region asked about (`window-not-covering`) -- and both mean KEEP the optimistic update, where an honest `absent` means the fold has looked and not found it. Collapsing any of that into a boolean at the boundary is exactly the double-count the call exists to prevent.

**`minedAtBlock` crosses per query.** The unconfirmed window is SPARSE, so `absent` means only "not in the window"; a caller holding a RECEIPT closes that through the `below-window` branch, and a tab is precisely where a caller has one. The receipt's block HASH is still never compared, because a reorg can re-include the same transaction in a different block.

**A verdict is a SNAPSHOT.** It is answered from the cursor the host is reporting at the moment of the call and from the finality depth its container actually runs with, so an app watching a transaction asks again -- when `onProgress` says the fold moved, which is when the answer can have changed. It follows the **canonical pointer** for the same reason: the retired cursor is dropped when a promotion moves it, so a tab is never answered from a window nothing is maintaining any more.

**It answers rather than waiting.** Unlike a read, which waits for the host's first store because "read me the rows" has no honest answer until there is one, this call does not wait for the container to open: a host that has synced nothing says `unknown`/`not-synced`, which is a verdict an app renders, so asking early is answered instead of hanging on however long a provider takes.
