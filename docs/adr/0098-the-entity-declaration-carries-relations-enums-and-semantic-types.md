---
status: accepted, not yet implemented
---

# The entity declaration carries relations, enums and semantic types, and stays the one schema source

The entity declaration (`name`, `id`, `fields` of four storage classes) is the schema source for every surface above the store, so anything generated from it was a set of flat, unrelated tables of primitives: no relation, no enum, and a `uint256` stored as decimal text whose equality depends on an encoding rule nothing enforces and whose ordering puts `"10"` before `"9"`. We decide to extend the declaration itself rather than describe the data a second time beside it, with three opt-in additions, each describing what the system already does rather than inventing runtime behaviour. Decided with the maintainer on 2026-09-28, tasking the spec `a-declaration-a-schema-can-be-built-from`; the first user is `the-same-query-runs-against-a-worker-and-a-server` (ADR-0099).

## A relation is declared once, on the child, and its leading id columns ARE the parent's whole id

`parent: {entity, as}` on the child. The child's id is where the fact lives, so the parent-side collection is a projection of it and the two cannot disagree; the parent-side NAME (`as`) is the one thing the id does not supply, so it is declared rather than guessed by pluralising. The child's leading id columns must be the parent's WHOLE id, by name and in order, checked at declaration time on every backend identically (as the identifier and reserved-namespace rules are). The strictness is what makes the relation true: a child carrying part of its parent's key belongs to no single parent. The collection is the existing bounded id-prefix listing with the parent's key as the prefix (ADR-0021), so the seam's read shape does not change. The `as` name must not collide with a field or id column of the parent, another relation's `as` on the same parent, or a name the generated read surface already uses; a collision is refused at declaration time. A relation implies nothing about writes: no referential check and no write order, because that would cost per mutation on the path every event takes, and a subgraph's `@derivedFrom` does not enforce it either.

## Enums are in, interfaces are out

An enum is a declared value set over text (`{storage: 'text', enum: [...]}`), checked at write time for the cost of a set lookup, needing no per-backend query support. Its values must be legal GraphQL enum names, refused at declaration time, so the schema ADR-0099 builds maps them one to one. An interface would need a per-type hydration pass that no browser counterpart has been designed for, so it is deferred rather than declared on one backend only.

## A semantic type is a tag BESIDE the storage class, and owns encoding, equality and ordering

A field may declare `{storage, type}` (for example `{storage: 'blob', type: 'u256'}`) instead of a bare storage class. The key is `type`, not `as`, which already names a relation's collection. `FieldType` stays the four-value intersection of what backends can hold: storage and meaning are different axes, and a fifth `FieldType` would make every future semantic type a DDL case on every backend. A semantic type owns three things or it is not worth having: a canonical encoding, an equality and an ordering. At the store seam a `u256` is a `bigint`: a handler writes one and `get` answers one, and each backend (and the snapshot document, ADR-0095) holds it in its canonical encoding, big-endian fixed-width bytes, because binary keys sort bytewise on Chromium, Firefox and WebKit (`docs/spikes/a-multientry-index-over-computed-field-keys/`) and that is the same shape as a sortable BLOB in SQLite. Ordering is a promise of the layers that order (the accessor seam and the IndexedDB index, ADR-0099); the store seam still orders only ids, lexicographically (ADR-0021), and a semantic type does not change that. EVERY backend implements a semantic type in one change, never one backend at a time, because a half-migrated set means one declaration meaning different things on a server and in a browser, which fails silently.

## Existing declarations keep working

All three are opt-in per field and per entity: a bare `'text'` keeps its meaning, `parent` is optional. ADR-0025's decision (the read surface decodes nothing the declaration does not describe) is unchanged; what changes is that the declaration describes more, which it anticipated.

## Status

`accepted, not yet implemented`: the tasks with `spec: a-declaration-a-schema-can-be-built-from` build it, and the one that lands last, `the-browser-index-orders-a-u256-numerically`, removes this status line in the same change (if the IndexedDB index is measured not worth shipping, `an-indexeddb-index-serves-the-accessor` rewrites this section to say the index ordering was declined instead) (`work/protocol/ADR-FORMAT.md`).
