---
'@etherfold/browser': minor
---

**A browser indexer takes a generation's identity from the ARRIVAL that produced it, instead of asking the processor what it is called** (ADR-0086).

A processor's identity has always been author-declared: `getVersionHash()` is the `version` field plus the entity and config declarations, and the core discards persisted state when it changes. An author who edited a handler and forgot to bump `version` got state computed by the previous logic, served for ever and silently. ADR-0086's invariant removes the possibility rather than reporting it: an author cannot STATE their processor's identity, so a fold is HANDED one, derived from what the processor IS -- the SHA-256 of a self-contained bundle's octets where an app was handed bytes -- and never asks where it came from.

Both places this package needed the fold half of a generation now read the identity it was handed:

- `BrowserGenerationSpec.processorIdentity` (and therefore `HostedIndexerSpec`, plus the generation `createIndexerState(...).addGeneration` takes) is passed straight to `GenerationSpec.processorIdentity` in `@etherfold/core`, so the container registers the generation under it;
- it is ALSO what both hosting paths key their own per-generation STORE record on (`createIndexerState` and `serveIndexerHost` each keep one, for the scheduled prune and for the read a tab makes across the port), so the name the registry files and the name a store is looked up by cannot be two different values;
- `createIndexerState`'s `createIndexer` factory option gains a fifth argument carrying that resolved identity, mirroring the container's `createGeneration`, so an injected engine cannot answer to a different name than the registry recorded. An existing four-parameter factory still compiles, and would silently DROP the identity, which is why the option says so.

**Nothing is removed and no caller has to move yet.** `processorIdentity` is OPTIONAL, and absent means the identity falls back to the processor's own `getVersionHash()` exactly as it always did -- so `version`, `getVersionHash()`, `getCodeFingerprint()` and the `PROCESSOR DRIFT` report all still exist and still work. This is one MIGRATE batch of an expand -> migrate -> contract sequence (`work/protocol/TASKING-PROTOCOL.md` 3a); the later contract step is what deletes the declared path, once every package has moved.

**The HMR arrival is deliberately untouched.** `updateProcessor` is where a dev server's hot update lands, and a module object has no bytes to hash, so its identity is derived from the handler sources by `a-module-handed-to-a-tab-is-identified-by-its-handler-sources` rather than supplied by the app. It still compares declared hashes here, and the suites that drive it still declare versions, labelled as that task's.

Also documentation: `createBrowserStateStore`'s bootstrap example passes the identity the app's arrival handed the hook rather than calling `eventProcessor.getVersionHash()`, since a snapshot's `processor` label is compared for equality and never parsed.
