---
'@etherfold/state-store': minor
'@etherfold/browser': patch
---

The generated read surface types a declared `u256` (`{storage: 'blob', type: 'u256'}`, ADR-0098) as a `bigint`, derived from the declaration (ADR-0025). `FieldValue` of a semantic field is now the value its registered type decodes to, through the new exported type `SemanticValue<Name>` (read off the registry, so a `u256` is `bigint`), where it was `unknown`; a row from `createReadSurface`, from `createQuerySurface` and, in `@etherfold/browser`, from `createPortReadSurface` therefore types such a field `bigint | null`. The run-time value was already a `bigint` on every backend and across the worker port, which carries it by structured clone as itself.
