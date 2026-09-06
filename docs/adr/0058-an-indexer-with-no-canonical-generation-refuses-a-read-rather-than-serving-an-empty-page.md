# An indexer with no canonical generation REFUSES a read, and the refusal is about which generation answers rather than how far it has got

A read against a named indexer whose canonical pointer names NOTHING is answered `503 no-canonical-generation`, naming as `building` the generations that indexer does hold, instead of the `200` with an empty page it would otherwise produce. Both feed views resolve the pointer through ONE function below the routes (`resolveCanonicalGeneration`, `@etherfold/server`), so there is one place a read decides which generation answers it and one answer when none does — and a surface added later (a read tier answering over a database written elsewhere) inherits the refusal rather than having to remember it.

Recorded because it is a PUBLISHED REFUSAL on a public read surface, because the status code is a choice among four this surface already uses, and because the scope of the refusal is the part a reader would otherwise get wrong in either direction.

## Why a refusal at all

Because the alternative is a lie a consumer cannot detect. With no generation answering reads there are no rows to serve, so the feed would answer `entries: []` with `hasMore: false` — byte-identical to "you are caught up". "There is nothing here" and "this is still being built" would then arrive in the same shape, which is the absence-versus-contradiction distinction ADR-0015 refuses to lose on the state side and the reorg model keeps everywhere else. A consumer holding an unresolvable position is TOLD, never served an answer it cannot tell apart from a true one.

## Why `503`, and not one of the three refusals this surface already has

- Not the `400` family (the cursor refusals): nothing about the request is wrong, and no correction to it helps.
- Not `404`: the name resolved. That code means "this host was not built with that named indexer", which is a routing fact and stays one.
- Not `501`: this host CAN serve feeds. That code is the capability statement a host with no registry at all makes.
- `503` is the only one that says what is actually true — this indexer cannot answer YET — and it is the only one a caller should retry, which it should: the state it is waiting for is a build finishing.

`409` was available and is deliberately not used: ADR-0004 pins it as the ONE resumable refusal meaning "your position is not where mine is, carry on from HERE", and there is no position to carry on from here.

## What it does NOT refuse

A canonical generation that has folded LITTLE, or nothing at all. The question is WHICH GENERATION ANSWERS and never how far that generation has got, and the difference matters: refusing on progress would mean a feed could not be followed until its backfill had finished, when a short page plus a cursor is exactly how a stream is meant to be followed. A generation being REBUILT is never the one answering anyway, because the pointer moves at the END of a rebuild (ADR-0056), so no read is ever served from a generation that is still being built. What an operator watching a build in progress reads is `/status`, where the per-generation dimension inside the cursor envelope (ADR-0047) says which generation is canonical and how far each has got.

## Consequences

- **`IndexerRegistryEntry.canonicalGeneration()` may answer `undefined`**, and that is a state rather than an error. A host holding a fold always has a canonical generation (the first generation registered takes the pointer), so the answer belongs to a READ TIER, which resolves the pointer from the durable rows of a database somebody else is writing and can legitimately meet one that holds nothing yet.
- **The ADMIN route reports that state rather than refusing it** (`canonical` absent, the generations still listed). That is the right way round and not an inconsistency: a read served from nothing is a wrong answer, while "nothing answers reads yet, and here is what is registered" is precisely what an operator opened that route to see.
- **`building` carries opaque generation digests**, the same value a feed response advertises, so an operator matches them against the admin listing instead of taking them apart. A host that cannot list its generations reports an empty list rather than turning an operational read into a `500`.
