---
'@etherfold/state-store': minor
'@etherfold/state-store-conformance': minor
'@etherfold/state-store-sqlite': patch
'@etherfold/state-store-indexeddb': patch
'@etherfold/state-store-patch': patch
'@etherfold/processor-entities': patch
---

A field can declare an enum (ADR-0098): `{storage: 'text', enum: ['open', 'closed']}`, a value set over text (new types `EnumField` and `FieldDeclaration`; `EntityDeclaration.fields` and `NormalizedEntity.fields` now hold a `FieldDeclaration`, and a bare storage class means exactly what it meant). `normalizeEntity` refuses, at declaration time, an enum over anything but `text`, an empty one, a repeated value, and a value that is not a legal GraphQL enum name (a GraphQL `Name`, not `true`, `false` or `null`, not starting with `__`). Every backend (memory, SQLite, IndexedDB, patch) checks an upsert's enum values at WRITE time through the new `assertFieldValues`, where it plans the block, so a value outside the set is refused with the same sentence everywhere, naming the field and the allowed values, and the block writes nothing; NULL stays legal. New helpers `fieldStorage` (the storage class of either shape, which is what the SQLite DDL uses) and `describeField`. The snapshot document writes an enum field as its `{storage, enum}` object on the entity's declare line (every other line is byte-identical) and compares declarations structurally on install, and `assertDeclaredBy` does the same. `FieldValue` / `EntityRow` type an enum field as the union of its declared values. `@etherfold/state-store-conformance` gains the group `a declared enum is checked at write time`: declared values and NULL are stored, other values are refused in the seam's own words leaving the store unchanged, illegal enums are refused at declaration time, and an entity with an enum field survives a snapshot-document round trip and install, on every backend. `@etherfold/processor-entities` re-exports `EnumField` and `FieldDeclaration`.
