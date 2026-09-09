# The reactive update should be an ENVELOPE (handle plus where it has got to), not a bare handle

Once state stopped being a JS blob, the reactive story stopped being "here is your new state" and
became "something changed, re-read the store". `@etherfold/browser` still publishes the shape the
blob era gave it: a `state` store carrying a READ HANDLE with permanently stable identity, and a
separate `syncing` store carrying the cursor, mutated in place.

**Proposal: publish ONE value per update, a fresh immutable envelope, carrying the handle plus the
facts a reader needs to interpret it.** Roughly:

```ts
type IndexedUpdate<ABI, ProcessResultType> = {
	/** STABLE identity across updates: a held handle keeps answering the canonical generation. */
	readonly state: ProcessResultType;
	/** How far the fold that produced this has got. */
	readonly lastToBlock: number;
	readonly latestBlock: number;
	/** Which generation answered, so a reader can tell a promotion from an advance. */
	readonly generation: GenerationContext;
	/** Was the state discarded and is being rebuilt (the existing `stateDiscarded` signal). */
	readonly rebuilding: boolean;
};
```

The ENVELOPE is new on every update; the HANDLE inside it is not. That distinction is the whole
design and it must be stated wherever this lands: the envelope changing identity is what makes
reactivity work, and the handle NOT changing identity is what keeps
`a-reconfigure-is-not-an-outage`'s story 6 true (a reader holding a state handle across a promotion
keeps answering from whichever generation is now canonical).

## What it fixes, and they are three separate things

1. **Reactivity stops depending on the store library's equality rule.** Today updates fire only
   because `sveltore`'s `safe_not_equal` treats every object as changed, so a `===`-deduping consumer
   sees nothing, silently
   (`browser-reactive-updates-depend-on-a-store-that-never-dedupes`). A
   fresh envelope is a genuine change under every equality rule there is.
2. **A subscriber can snapshot and diff.** `syncing` is mutated in place today, so a captured
   previous value is the same live object and "what changed" is unanswerable. An immutable envelope
   makes the previous value a real previous value.
3. **The cursor and the state become ONE atomic publish.** Today they are two stores with a
   documented ordering rule ("the hook sets `syncing` before `state`, so the cursor can be one
   statement ahead of the rows and never behind"). That rule exists only because there are two
   publishes; with one envelope the pairing is structural and the rule can be deleted rather than
   documented. `checkTxInclusion` reads the cursor and pairs it with rendered state, so this is the
   pairing that actually matters to an app.

## What to be careful about

- **Do not put the unconfirmed window in it.** `LastSync.unconfirmedBlocks` carries EVENTS; publishing
  them per update would ship the reorg window to every subscriber for no reason. Project the two or
  three numbers a UI needs. `checkTxInclusion` stays the way to ask about a transaction.
- **`syncing`'s phase booleans are a different signal** (is it fetching, catching up, waiting for a
  provider) and are consumed by different UI than the data. This proposal does not require merging
  them in; the envelope is about the pair that must agree, which is the state and its position.
- **It is a breaking change to a published-intent surface**, so it costs a changeset and a docs pass
  (`docs/guide/indexing-in-a-browser-app/`, which today describes a reactive `state` without saying
  the payload is a handle carrying no data).

## Why now

Two things make it timelier than it looks. Running the indexer in a WORKER
(`work/notes/ideas/run-the-browser-indexer-in-a-worker.md`) changes what "the same object" even means
across a thread boundary: an envelope of plain data plus one proxied handle is exactly what survives
a structured clone, where a mutated-in-place object does not. And seeding
(`a-generation-can-be-seeded-from-a-published-artifact`) gives an app a state that arrives in bulk
rather than by folding, which is precisely when a UI needs to be told "this jumped to block N" rather
than "something changed".
