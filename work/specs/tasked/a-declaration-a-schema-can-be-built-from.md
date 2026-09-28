---
title: 'A declaration a schema can be built from'
slug: a-declaration-a-schema-can-be-built-from
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **Tasked 2026-09-28.** Its decisions (and their reasons) moved to ADR-0098; what to build moved to the tasks with `spec: a-declaration-a-schema-can-be-built-from`.

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

## Out of Scope

- **A join the ids do not already express.** A relation here is a parent-child edge encoded in the key. Anything needing a general join needs a query planner, which the browser substrate does not have and ADR-0021 exists because of.
- **Many-to-many.** Expressible today as an explicit join entity keyed by both sides, which is what a subgraph does too.
- **Changing the seam's read shape.** Still four reads, still a prefix and a required limit.
- **Materialised counts or aggregations.** The finding is explicit that a count in a versioned store opens a new parent version per child write (8,485 extra `placement` versions on the real stream), and that the cheaper fix is a modelling rule: key a child by something naturally ordered rather than by a dense array index.
- **Decoding anything the declaration still does not describe.** ADR-0025's rule is unchanged and this spec is how its precondition is met, not an exception to it.
