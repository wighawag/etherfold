---
'etherfold': minor
'@etherfold/utils': minor
---

**A `--processor` path that names an UNBUNDLED entry point is refused at CONFIGURATION RESOLUTION, with the command that produces a bundle in the message** (ADR-0086, ADR-0048).

A processor IS a self-contained bundle and the sha256 of its bytes is its identity, so a configuration naming an entry point names nothing a deployment can fold. That was already refused, but structurally and late: the refusal was made where the arrival was resolved, after the module had been imported, so an author whose build step had not run met an error about module resolution rather than one about their configuration. It is now made with the other input refusals, before a module is imported, a database is opened, a port is bound or a generation is registered, and it names the three things an author needs:

```
-p, --processor "./dist/processor.js" names an ENTRY POINT rather than a bundle: it still imports "./abi.js",
which nothing resolves for it. A processor is ONE self-contained file, named by the sha256 of its bytes
(ADR-0086). Build one, and point `etherfold build` at it:

  esbuild ./dist/processor.js --bundle --format=esm --minify --outfile=dist/processor.bundle.js
```

A path this process cannot read at all -- a package name, a directory, or much the commonest, the OUTPUT of a build that has not run -- is refused in the same shape, and there the command's `--outfile` is the path that was named, because writing that file is exactly what is missing. All three folding commands (`run`, `build`, `index`) refuse identically, and so does the re-read behind `POST /{indexer}/admin/reconfigure`, which reports it as `failed` with the live fold untouched.

**It is not a second heuristic for "is this a bundle".** `unresolvedImportsOf` is this repository's only definition of self-contained -- what the artifact loader refuses on and what the arrival chooses its route with -- and it decides here too, so a bundle that merely MENTIONS a package name in a string is not refused and a `--platform=node` bundle that keeps `node:crypto` still runs.

**`@etherfold/utils` gains `readProcessorPath`**, which answers what is at a processor path (`bundle` / `entry-point` with the specifiers it still expects somebody else to resolve / `unreadable` with the reason) without importing anything. `openProcessorArrival` now reads the path through it, so a caller that REFUSES a path and the arrival that OPENS one cannot mean two different files or two different verdicts about one.
