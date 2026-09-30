---
'@etherfold/core': patch
'@etherfold/processor-entities': patch
'@etherfold/state-store': patch
'@etherfold/utils': patch
---

Declare `"sideEffects": false`, so a bundler drops the etherfold modules a processor never uses. Until now every module the package barrel reached kept its module-level `logs('...')` call in an app's processor bundle, so an etherfold release that added or removed a logger anywhere moved the bundle's SHA-256, which is the processor's identity (ADR-0086) and the key its published snapshots are found by (ADR-0095), though the app's code had not changed. A processor that imports `declareEntities` now bundles to no etherfold logger at all.

**This fix itself changes downstream bundle hashes ONE more time.** The first build after upgrading drops those loggers, so its bundle has a new identity and no existing publication is found by it: rebuild the bundle, let the snapshot job republish once (`etherfold build --publish` or `etherfold publish`), and ship the app with the rebuilt bundle. After that, an upgrade moves the identity only when code the bundle actually carries changes.
