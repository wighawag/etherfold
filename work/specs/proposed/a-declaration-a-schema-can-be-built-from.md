---
title: 'A declaration a schema can be built from'
slug: a-declaration-a-schema-can-be-built-from
humanOnly: true
needsAnswers: true
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

<!-- open-questions -->
<!--
  TRANSIENT BLOCK — stripped by the apply rung on full resolution.
-->

## Open questions

1. **How is a relation declared: on the CHILD, on the PARENT, or both?** The child already carries the truth, since its id begins with its parent's key, so the minimal declaration names which leading id columns are the parent and which entity they name. A parent-side `@derivedFrom`-style field is then DERIVED from that rather than declared twice, which is the property that makes the two halves unable to disagree. Against it: a schema generator wants the parent-side field NAME, which nothing on the child supplies.
2. **Is a semantic type a new `FieldType`, or a tag beside the storage class?** `u256` as a `FieldType` reads best (`fields: {amount: 'u256'}`) and forces every backend's DDL, the conformance suite and the write path to grow a case. A tag beside it (`{amount: {storage: 'text', as: 'u256'}}`) leaves storage alone and makes decode/encode/compare a layer above. ADR-0025 says a field must carry "a semantic type (or a codec) alongside its storage class" without choosing.
3. **Are interfaces and enums in scope, or explicitly deferred?** The research prototype modelled both (a `Node` interface, a `Rarity` enum) and produced a concrete finding about interfaces: a `UNION ALL` returns only the shared columns plus `__typename`, so answering `... on Token { rarity }` needs a per-type hydration pass. Enums are cheap; interfaces are a query-planning feature with a browser twin nobody has designed.
4. **Does a relation imply anything about WRITES?** Today nothing enforces that a child's parent exists, and a subgraph does not either. Declaring the relation makes a referential check expressible, which is a new refusal on the write path with a cost per mutation, on a path that runs once per event on every backend.
5. **What happens to a declaration that names a relation a backend cannot serve?** The seam's rule is that declaration legality is a fact about the declaration and not about the backend (refused at declaration time, on every backend), so a relation must either be universally serviceable or refused universally.

<!-- /open-questions -->

## Problem Statement

The entity declaration is the schema source for everything above it. It is:

```ts
type FieldType = 'text' | 'integer' | 'real' | 'blob';
type EntityDeclaration = {name; id: string | readonly string[]; fields: Record<string, FieldType>};
```

Nothing else. No relation, no derived collection, no interface, no enum, no semantic type. So anything generated from it is a set of **flat, unrelated tables of primitives**, and that is the ceiling for every consumer that promises to be generated from the declarations: `createReadSurface` today, and a GraphQL schema tomorrow.

**This removes the argument that chose GraphQL.** On the research's own matrix, oRPC beats it on bundle (roughly 4x), on native `bigint`, on codegen and on realtime; GraphQL wins two rows, "subgraph-style surface" and "nested relations in ONE round-trip". Both are unimplementable against this declaration. Shipping a GraphQL layer over it means paying 47.3 to 86.3 KB gzip of `graphql` runtime while losing on the criteria that selected it.

**And the relation already exists. It is just not written down.** In the promoted conformance workload, `placementPlayer` is keyed `['ordinal', 'position', 'moveOrdinal']` where `ordinal` is its parent `placement`'s key, and its own comment says what that buys: "every player of an arrival is `{ordinal}`, every player of one cell is `{ordinal, position}`". That is `@derivedFrom` in all but name. The bounded id-prefix listing (ADR-0021) is the read that serves it, on every backend, by design. The runtime does this correctly today; nothing above can SEE it, because the declaration does not say which leading id columns are a parent.

The same silence blocks the other half. `FieldType` is the intersection of what backends can hold and SQLite's INTEGER is 64-bit, so every `uint256` is decimal TEXT. On the real measured stream **16,046 of 31,332 events write nothing but u256 fields**, and as the workload's own comment puts it, equality then "depends on the encoding being CANONICAL (decimal, no leading zeros, never hex), which is a rule nothing in the model states or enforces", making it "an equality bug waiting to happen rather than a theoretical one". Ordering is worse than equality: `"10"` sorts before `"9"`, so `orderBy` on a u256 is simply wrong on both backends.

ADR-0025 already decided the shape of the answer and delegated it: a field "would have to carry a semantic type (or a codec) alongside its storage class, every backend would have to agree on the encoding, and equality/ordering would have to be defined for it", and it pointed at `tagged-bigint-codec-across-storage-adapters`. That task is **done** and did a different job (the `LastSync` wire codec). So the delegation is an orphan and nothing carries this.

## Solution

**Make the declaration carry what a schema needs, and derive everything else from it.**

Two additions, each described so that it says what the system ALREADY does rather than inventing new runtime behaviour:

**A relation is a declaration that a leading run of a child's id names a parent.** That is descriptive: it is already true of every one-to-many in this codebase, it is what the bounded prefix listing already reads, and it costs nothing at write time because the collection is derived when read, which is exactly a subgraph's `@derivedFrom` ("a virtual field... never actually created during indexing"). Declaring it lets a generated surface offer the parent's children as a field, lets a query layer batch that read instead of issuing one per row, and lets a renamed parent key break compilation.

**A semantic type is a declaration that a stored value means more than its storage class.** `u256` is the case that forces it, and once declared, three things become possible that are impossible today: a canonical encoding every backend agrees on, an ordering that is not lexicographic (the spike measured that binary keys sort bytewise on all three engines, so a big-endian fixed-width encoding is orderable in IndexedDB exactly as a sortable BLOB is in SQLite), and a decode the read surface can perform honestly. ADR-0025 already says the surface follows "for free" the day this exists, "because its types are derived from the declaration rather than written beside it".

**What this deliberately is not** is a query language, an ORM or a general graph. A relation here is a parent-child edge that the id encodes. Anything that would require a join the id does not already express is out, because the seam's read is one indexed range scan on a substrate with no query planner (ADR-0021) and that constraint is not being relaxed.

## User Stories

1. As a processor author, I want to declare that a child belongs to a parent, so that the relationship my ids already encode is written down rather than implied by a comment.
2. As a processor author, I want that declaration checked against the ids, so that a relation that does not match the key structure is refused rather than silently wrong.
3. As a processor author, I want a renamed parent key to break compilation in every consumer, so that a rename is a refactor rather than a runtime surprise.
4. As a processor author, I want to declare that a field holds a `uint256`, so that the encoding is one decision rather than one per call site.
5. As a processor author, I want the store to enforce that encoding, so that equality on a u256 does not depend on every handler spelling it the same way.
6. As a processor author, I want ordering on a u256 to be numeric, so that `orderBy` does not put `"10"` before `"9"`.
7. As a consumer, I want a parent's children as a field, so that I do not reconstruct the relationship from id conventions in my own code.
8. As a consumer, I want that field to cost one batched read for a page of parents, so that a nested collection is not N+1.
9. As a consumer, I want a u256 to arrive as something I can compute with, so that I am not calling `BigInt()` on every field and hoping the encoding was canonical.
10. As a consumer, I want the generated read surface to gain all of this without a second description of my data, so that ADR-0025's "for free" is actually free.
11. As an app developer, I want a GraphQL schema with nested types, so that the reason GraphQL was chosen over oRPC is realised rather than paid for and discarded.
12. As an app developer, I want the same nested query to work in the browser and against a server, so that the relation is not a server-only feature.
13. As a maintainer, I want the declaration to remain the single schema source, so that storage, reads and any query layer cannot disagree.
14. As a maintainer, I want relation legality decided at DECLARATION time on every backend, so that this follows the rule the identifier and reserved-namespace checks already follow.
15. As a maintainer, I want the conformance suite to ask every backend about the new semantics, so that a backend cannot accept a declaration and diverge later.
16. As a maintainer, I want the browser's index path to order a semantic type correctly, so that the measured bytewise ordering of binary keys is actually used rather than noted.
17. As a maintainer, I want ADR-0025's delegation closed, so that its pointer at a completed task that did a different job stops misleading readers.
18. As a maintainer, I want an existing declaration to keep working unchanged, so that adopting any of this is opt-in per field and per entity.

### Autonomy notes

- **`humanOnly: true`.** This changes `EntityDeclaration`, which is the central schema source: every backend's DDL and read path, the conformance suite, the generated read surface, and the shape every processor is authored against. The scope questions (relations only, or interfaces and enums too) also decide how much of subgraph parity this project is committing to, which is a product boundary.
- **`needsAnswers: true`.** Five questions, of which 1 and 2 change the type itself and therefore every task cut from this spec. Question 4 is the one that can quietly grow the work: a referential check on the write path runs once per event on every backend, and deciding it late would mean re-cutting the storage tasks.

## Implementation Decisions

**Declared on the child, derived for the parent.** The child's id already begins with its parent's key, so the child is where the fact lives and the parent-side collection is a projection of it. That keeps one source of truth and makes the halves unable to disagree (question 1 is about what else the parent side needs, chiefly a field name, not about where the truth lives).

**The read a relation compiles to already exists.** A parent's children is `listCurrent` / `listAsOf` with the parent's key as the prefix and a required limit, which is one indexed range scan on every backend by construction (ADR-0021, and on IndexedDB literally `IDBKeyRange.bound([entity, ...prefix], [entity, ...prefix, []])`). Nothing new is added to the seam's read shape; a name is added to something that is already a prefix.

**A semantic type owns three things or it is not worth having**: a canonical encoding, an equality, and an ordering. Any two without the third leaves the bug the workload already documents. The encoding must be one every backend can store and order, and the spike result is directly usable: binary keys sort bytewise on Chromium, Firefox and WebKit, so a big-endian fixed-width encoding is orderable in IndexedDB and is the same shape as the sortable BLOB the SQL research recommends.

**Existing declarations must keep working.** Everything here is additive and opt-in: a declaration with no relations and no semantic types means exactly what it means today, on every backend.

**One schema source, still.** The point of adding to the declaration rather than beside it is that `createReadSurface`, the accessor seam the query spec defines, the storage layout and any future schema all continue to read one object. A relation described in a GraphQL layer instead would be a second description of the data, which is the thing this project has consistently refused.

## Testing Decisions

- **Conformance, parameterised by the factory**, for the semantics every backend owes: a declared relation reads back the same children on each backend; a declared semantic type round-trips, compares equal across encodings that should be equal, and orders numerically rather than lexicographically.
- **Declaration-time refusals**, tested on every backend identically: a relation whose columns are not a leading run of the child's id, a relation naming an entity that does not exist, a semantic type a backend cannot encode. The precedent is the identifier and reserved-namespace rules, refused at declaration time everywhere rather than at `migrate()` on one backend.
- **The generated read surface follows automatically**, asserted by type-level tests rather than prose, since ADR-0025's "for free" claim is exactly what would rot.
- **The real workload as the subject.** `@etherfold/conformance-workload-stratagems` already contains the shapes this is for (`placementPlayer` under `placement`, and u256 fields in `globalRate`), plus a frozen golden state, so a declaration that changes meaning shows up as a diff in a known-good output rather than as an opinion.
- **Ordering on the browser index path**, in the real-engine run rather than under `fake-indexeddb`, since the ordering claim is the engine's.

## Out of Scope

- **A join the ids do not already express.** A relation here is a parent-child edge encoded in the key. Anything needing a general join needs a query planner, which the browser substrate does not have and ADR-0021 exists because of.
- **Many-to-many.** Expressible today as an explicit join entity keyed by both sides, which is what a subgraph does too.
- **Changing the seam's read shape.** Still four reads, still a prefix and a required limit.
- **Materialised counts or aggregations.** The finding is explicit that a count in a versioned store opens a new parent version per child write (8,485 extra `placement` versions on the real stream), and that the cheaper fix is a modelling rule: key a child by something naturally ordered rather than by a dense array index.
- **Decoding anything the declaration still does not describe.** ADR-0025's rule is unchanged and this spec is how its precondition is met, not an exception to it.

## Further Notes

The dependency worth stating plainly: **the query spec's accessor seam should not be finalised before this lands.** That seam is its central decision, and defining "find the rows matching this predicate, ordered, bounded" against a declaration that cannot name a relation would bake the limitation into the one place both backends and every resolver share. Relations are the part of that seam that has to be batched rather than resolved per row, and a seam that cannot express them is a seam that gets re-cut.

ADR-0025 should be amended when this lands rather than superseded: its decision (the read surface decodes nothing the declaration does not describe) is correct and unchanged. What changes is that the declaration starts describing more, which that ADR anticipated in as many words. Its delegation pointer needs correcting either way, since it names a task that has since completed without doing this half.
