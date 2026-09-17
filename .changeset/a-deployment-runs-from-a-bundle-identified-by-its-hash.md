---
'@etherfold/utils': minor
'@etherfold/processor-entities': minor
'etherfold': minor
---

**A deployment can now RUN from a BUNDLE, and the generation it registers is identified by that bundle's hash** (ADR-0086).

`--processor` still names a PATH and that does not change. What changes is what the path may point AT: where it names a SELF-CONTAINED bundle, the CLI reads it, hashes it (`sha256:<hex>` over the octets), instantiates it from those bytes and registers a generation whose `processor` identity IS that hash. An author who edits a handler and forgets to bump anything gets a different generation, because there is nothing left to forget. Two machines building the same source get the same one, because the identity is the bytes and not the path they sit at.

Nothing bundles anything: reading a file and hashing it is not bundling, and the CLI acquires no bundler.

**Both shapes work, which is the point of this step.** A path naming an UNBUNDLED module -- one that still expects somebody else to resolve an import -- resolves through the module system exactly as it always did and keeps the author-declared identity from `getVersionHash()`. The declared `version`, `getVersionHash()` and the code fingerprint are all untouched; four migrate batches and a contract task follow and each depends on that.

**A bundle is a module that expects nobody else to resolve anything**, which is `unresolvedImportsOf`'s existing judgement and not a second one. The consequence worth knowing: a hand-written entry point that imports NOTHING is a bundle by that definition and is identified by its bytes rather than by its `version`.

New in `@etherfold/utils`: `openProcessorArrival(path, options)`, which lands one operator-supplied path on whichever of the two arrivals it describes and answers with `{processor, processorModule, identity?}` -- `identity` present exactly when the path named a bundle. An injected `importModule` governs the module arm alone; the bundle arm imports a `data:` URL of the bytes it just read, where the module cache is keyed on those bytes and is therefore exactly right.

New in `@etherfold/processor-entities`: `EntityEventProcessorOptions.identity`, the identity a host HANDS a fold when the arrival derived one. Absent is the ordinary case and means the declared hash, unchanged. It is not the caller-declared version hash ADR-0043 rejected: it is derived from something the class cannot see and REPLACES the computation rather than sitting beside it, so there are still never two live answers.

Nothing parses a processor identity anywhere in the tree, which is what lets two derivations coexist through the migration and after it.
