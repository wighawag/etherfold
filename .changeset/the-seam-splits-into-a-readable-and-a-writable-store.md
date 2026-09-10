---
'@etherfold/state-store': minor
'@etherfold/state-store-conformance': minor
---

**The storage seam now has a READABLE shape and a WRITABLE one, and the ability to mutate is obtained by CLAIMING: `openForWriting` / `openForReading`** (ADR-0077).

ADR-0075 made a second writer's mutation land never. It left the rule as something a caller had to remember, because any value typed `StateStore` could still mutate. This makes it a fact of the TYPE, which is what ADR-0044 already does for streams by handing a follower a read-only stream view rather than asking it to behave.

```ts
const store = await openForWriting(await createBrowserStateStore(processor.entities));
await store.applyBlock(block, mutations, cursor);

function render(state: ReadableStateStore) { ... } // cannot write: `applyBlock` is not on the type
render(openForReading(store));
```

`openForWriting` MIGRATES (so it replaces the `migrate()` a host would otherwise call), then CLAIMS: it swaps the stored writer token, so an earlier writer's next mutation is refused from the moment this call returns rather than from whenever the new writer gets round to writing. It does not block and does not wait -- a loser is not queued, it has lost. It is IDEMPOTENT per store INSTANCE, which is load-bearing rather than a convenience: the shipped `createState: () => store` pattern hands ONE store to EVERY generation, so a second open returns the claim the first one made and building a successor cannot invalidate the canonical generation.

What it hands back carries a `token`, and that member is what makes the writable shape unforgeable: without it the type would be structurally satisfied by any store. It is deliberately NOT the token the backend compares in its transactions, which stays private -- a token a caller can read is a token a caller can hand back, and ADR-0075 rejected exactly that.

**Nothing breaks.** `StateStore` keeps its mutating members, so every existing consumer compiles and passes unchanged, and the concrete backend classes are untouched and still expose their full surface. Consumers migrate to the two new shapes one package at a time; a later change removes the mutating half of `StateStore` and folds `ReadableStateStore` into it.

**If you implement `StateStore`:** nothing to do, and one contract is now asserted that was previously only implied -- `clearCursor` on a key that was never written must still CLAIM on a backend reporting `singleWriter`, because that no-op is how `openForWriting` takes the store without touching a byte. It is exercised by the new conformance chapter `a writer claims by opening`.

**If you run the conformance suite:** every factory-driven chapter is now asked TWICE, once of the store your factory returns and once of the handle `openForWriting` gives back, so a handle that delegated a verb wrongly is caught. Your factory and options are unchanged.

**New exports from `@etherfold/state-store`:** `openForWriting`, `openForReading`, `WRITER_CLAIM_KEY` (a reserved cursor-port key nothing ever writes), and the types `ReadableStateStore`, `WritableStateStore`, `StateStoreMutations`, `WriterToken`.
