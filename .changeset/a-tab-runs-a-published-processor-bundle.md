---
'@etherfold/browser': minor
'@etherfold/core': minor
'@etherfold/utils': patch
---

A tab can run the processor bundle a build PUBLISHED, and its generation is named by the SHA-256 of those bytes (ADR-0086, ADR-0095).

`@etherfold/browser`: a generation spec takes `processorBundle: {url}`. The host (main thread, dedicated worker or SharedWorker) fetches the bytes once, hashes them exactly as `etherfold build` does, refuses them if they still import anything, and instantiates the processor FROM THOSE BYTES inside the host, before it builds the generation's state. The instantiated bundle is handed to `createProcessor` as a new third argument (`new EntityEventProcessor(state, bundle.processor)`), and the generation is registered under its identity. A spec naming both `processorBundle` and `processorIdentity` is refused: the bytes name themselves. `loadProcessorBundle(url)` is the same load as data, for an app that drives it itself. Refusals are distinct reasons (`unreachable`, `not-self-contained`, `unreadable-module`, `not-a-processor`, `forbidden-by-policy`), raised by a host as `ProcessorBundleRefusedError` before anything is claimed or folded: `init` rejects with it, and a worker host reports it as `phase: 'refused'` with the refusal's fields on `failure.details`. A Content-Security-Policy that forbids both `data:` and `blob:` modules is `forbidden-by-policy`, decided by probing each scheme with a trivial module so a policy refusal is never mistaken for damaged bytes, and it names the directive and policy from the `securitypolicyviolation` events where the context delivers them. The module arrival (HMR) is unchanged and keeps its module identity.

`@etherfold/core`: exports `processorArtifactIdentity`, `moduleReferencesOf`, `instantiateProcessor` and the `ProcessorModule` / `InstantiateProcessorOptions` types, the runtime-agnostic half of a processor artifact, so the identity a tab derives and the one the CLI publishes under are one function. The identity is computed with `viem`'s SHA-256 (no secure context needed); the output is unchanged.

`@etherfold/utils`: `processorArtifactIdentity`, `instantiateProcessor` and `ProcessorModule` are now re-exported from `@etherfold/core`, and `unresolvedImportsOf` is core's scan minus Node's builtins. No behaviour changes.
