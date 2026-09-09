---
title: '`packages/core/src/internal/utils/extra.ts` is imported by nothing and holds the only `eth_call` in the engine'
slug: an-orphaned-extra-ts-holds-the-only-eth-call-in-the-core
observed: 2026-09-08
source: 'noticed while building task:the-engine-declares-its-method-set-and-a-test-holds-it-to-it, grepping the core for every provider call site before declaring the method set. Nothing in `packages/`, `platforms/` or `examples/` imports `extra.js` or `utils/extra`.'
---

`multi165`, `splitCallAndJoin` and `tokenURI` live there, they call `provider.request({method: "eth_call", ...})` against a hard-coded Multi165 address, and no module imports the file, so it is built and typechecked but unreachable. It is presumably the residue of the `extra` / prefetch sketch the fold-over-logs spec puts out of scope. It costs nothing at runtime and it does not reach a guarded provider, but it is the one place a reader grepping the core for provider calls finds a method the engine does not declare.

## Resolved 2026-09-08

Deleted. `packages/core/src/internal/utils/extra.ts` is gone, and with it the only `eth_call` in the package. Confirmed unreachable first: nothing in `packages/`, `platforms/` or `examples/` imported the module or named `multi165`, `splitCallAndJoin` or `tokenURI`. This also removes the one place a reader grepping the core for provider calls would have found a method the engine does not declare, which matters more now that `ENGINE_PROVIDER_METHODS` makes that set a checked claim rather than a prose one.
