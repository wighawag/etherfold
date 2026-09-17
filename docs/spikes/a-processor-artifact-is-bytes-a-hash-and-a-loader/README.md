# What a `data:` URL module can resolve

Evidence for one decision inside `a-processor-artifact-is-bytes-a-hash-and-a-loader`: WHICH import specifiers make a processor bundle unusable, and therefore which ones `unresolvedImportsOf` (`@etherfold/utils`, `src/processorArtifact.ts`) refuses.

The artifact arrival instantiates by importing a `data:text/javascript;base64,` URL (ADR-0085), so "self-contained" means "resolves nothing through a base URL". The question that had to be measured rather than assumed is the exception: a bundle built with `--platform=node` legitimately keeps its BUILTIN imports, and refusing an artifact that actually runs would be a refusal an author cannot act on.

Run it:

```sh
node docs/spikes/a-processor-artifact-is-bytes-a-hash-and-a-loader/measure-what-a-data-url-can-resolve.mjs
```

## Result, node v24.19.0 on linux, 2026-09-17

| the artifact imports | outcome | how it arrives |
| --- | --- | --- |
| nothing | imported | -- |
| `node:crypto` | **imported** | -- |
| `crypto` (unprefixed builtin) | **imported** | -- |
| `viem` (bare package) | refused | `TypeError` / `ERR_UNSUPPORTED_RESOLVE_REQUEST`, at LINK time, naming the specifier |
| `./sibling.js` (relative) | refused | the same `TypeError`, naming the specifier |
| `import("viem")` never called | **imported** | -- |
| a syntax error | refused | `SyntaxError`, at parse time |
| a module body that throws | refused | the body's own `Error`, at evaluation time |

Four things it decided.

**A BUILTIN resolves, prefixed or unprefixed**, so both are admitted (`module.isBuiltin` covers exactly this set). This is the one exception the self-containment check makes, and it is measured rather than granted.

**A RELATIVE specifier is as dead as a bare one**, which is why the check reports both rather than looking only for bare specifiers: there is no directory to resolve `./abi.js` against.

**A DYNAMIC import is NOT caught by the runtime**, which is the case that decides the check has to be STATIC. The module above imported cleanly and would have failed at the first event it folded, in whatever code path reaches that `import()` -- far from the cause, in a process that had already registered a generation. A check that merely tried to instantiate would have admitted it.

**The three failure modes arrive as three different things** (a link-time `TypeError`, a parse-time `SyntaxError`, an evaluation-time error from the module itself), and the loader's refusal reasons are shaped around that: everything statically decidable is refused as `not-self-contained` BEFORE evaluation, and the rest collapses into `unreadable-module`, whose `why` carries the distinguishing message.

## What this does not cover

A BROWSER. `data:` and `blob:` module imports are refused by every realistic Content-Security-Policy, measured across three engines in `work/notes/findings/a-tab-instantiates-retained-bytes-only-through-a-same-origin-url.md`; a browser instantiation path is a service worker serving a same-origin URL, and it is deliberately not built here.
