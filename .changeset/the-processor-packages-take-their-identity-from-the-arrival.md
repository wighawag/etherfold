---
'@etherfold/processor-sqlite': minor
'@etherfold/processor-entities': patch
---

**`VersionedStateEventProcessor` takes its fold's identity from the ARRIVAL that produced it, through a new `identity` option** (ADR-0086).

A processor's identity has always been author-declared: `getVersionHash()` is the `version` field plus the entity and config declarations, and the core discards persisted state when it changes. An author who edited a handler and forgot to bump `version` got state computed by the previous logic, served for ever and silently. ADR-0086's invariant removes the possibility rather than reporting it: an author cannot STATE their processor's identity, so a fold is HANDED one, derived from what the processor IS -- the SHA-256 of a self-contained bundle's octets where a deployment read one off disk -- and never asks where it came from.

`EntityEventProcessorOptions.identity` already carried that value into the neutral fold. This adds the same option, spelled and meaning the same, to the SQLite convenience class:

- `VersionedStateProcessorOptions.identity` is what `getVersionHash()` answers with when a host supplied one, so a deployment folding a bundle names its generation by those bytes and a later `configure()` cannot move it (the config a bundle was built with is in the bundle);
- it is FORWARDED to the `EntityEventProcessor` this class builds on first use, so the wrapper and the fold underneath give ONE answer to "which fold is this" rather than two.

That type is therefore no longer purely a pass-through to the store it builds: the store never sees an identity.

**Nothing is removed and no caller has to move yet.** The option is OPTIONAL, and absent means the identity falls back to the author's `entityProcessorVersionHash` exactly as it always did -- so `version`, `getVersionHash()`, `getCodeFingerprint()` and the `PROCESSOR DRIFT` report all still exist and still work. This is one MIGRATE batch of an expand -> migrate -> contract sequence (`work/protocol/TASKING-PROTOCOL.md` 3a); the later contract step is what deletes the declared path, once every package has moved.

Also documentation, in `@etherfold/processor-entities`, where a docstring told a caller to reach for the declared hash: `BootstrapOptions.processor` and `createSnapshot`'s `processor` now describe WHICH FOLD computed the rows (a value compared for equality and never parsed) rather than "the version hash", and `bootstrapFromSnapshot`'s example passes the identity the deployment's arrival handed its fold instead of calling `getVersionHash()`. The candidate rule itself is untouched. `EntityProcessor.version` now says plainly that it is superseded and is not for new code.
