---
'@etherfold/utils': minor
---

**A processor ARTIFACT is bytes, the identity derived from them, and a loader: `processorArtifactIdentity`, `unresolvedImportsOf` and `loadProcessorArtifact`** (ADR-0086, ADR-0085).

A processor's identity has always been AUTHOR-DECLARED -- `version`, hashed with the declarations into `getVersionHash()` -- so an author who edited a handler and forgot to bump it got state computed by the previous logic, served for ever and silently. ADR-0086 makes that unrepresentable: a processor IS a self-contained bundle and the hash of its octets IS its name. This is the unit that rests under it.

- **`processorArtifactIdentity(bytes)`** is SHA-256 over the octets, rendered `sha256:<hex>` -- the convention the stream-seed content hash already established, so a literal pasted into a build says which function produced it. Identical bytes give an identical name and one changed byte gives a different one, with no author action either way.
- **`unresolvedImportsOf(bytes)`** is what SELF-CONTAINED means, CHECKED rather than promised: a bundle that survived bundling with `import 'viem'` still in it looks exactly like one that did not, until it is instantiated in another process or -- for a specifier only a dynamic `import()` carries -- until the first event it folds. Both are decidable statically, and both are reported, bare specifiers and relative ones alike. A BUILTIN is admitted (`node:crypto` and unprefixed `crypto`), because a `data:` URL really does resolve one; measured against Node rather than assumed, in `docs/spikes/a-processor-artifact-is-bytes-a-hash-and-a-loader/`.
- **`loadProcessorArtifact(bytes, {processorConfig})`** hashes, admits and then instantiates, in that order, by importing a `data:text/javascript;base64,` URL: no temporary file, no path, no cache-busting query. Everything checkable happens BEFORE evaluation, which is the irreversible act here (the module joins the process registry for the life of the process and its top-level code runs) -- the ordering `installStreamSeed` already makes structural.

**Refusals are DATA, in that same manner, and never a throw a caller cannot branch on**: `not-self-contained` (naming the unresolved specifiers), `unreadable-module` (the bytes did not become a module, or its body threw) and `not-a-processor` (no `createProcessor`, a factory that made nothing, or the retired `{kind, processor}` tag, refused by the one rule that already owns it). Each carries the artifact's IDENTITY, because bytes have a name whether or not they turn out to be a processor. The module is handed back beside the processor, since `contractsData` rides on it and resolving a source is the caller's step.

**Nothing consumes this yet, deliberately.** ADR-0086's migration is sequenced (expand, then four migrate batches, then a contract), so `getVersionHash()`, the declared `version` and the code fingerprint are untouched and no caller is migrated: this release only ADDS.

**There is no browser path and that is a decision.** A tab is handed a processor OBJECT by its own bundler, and where a tab does hold bytes, `data:` and `blob:` module imports are refused by every realistic Content-Security-Policy (measured across three engines in `work/notes/findings/a-tab-instantiates-retained-bytes-only-through-a-same-origin-url.md`). A browser arrival is a service worker serving a same-origin URL, which is its own decision and not this unit's.

The round trip is asserted against a REAL bundle, built once by the documented command (`esbuild --bundle --format=esm --minify`) and committed at `packages/utils/test/fixtures/processor-artifact/`, because a fixture built another way would not exercise what deployments produce.
