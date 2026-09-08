---
'@etherfold/core': minor
---

The engine now DECLARES the provider methods it asks for, and holds itself to them.

`ENGINE_PROVIDER_METHODS` is the declared set and it is stated once, in the engine: `eth_getLogs` for the logs, `eth_blockNumber` for the tip, `eth_chainId` for the identity guard, and `eth_getBlockByNumber` at the chain's first block when a source declares a `genesisHash`. One data call, the rest identity and tip, which is ADR-0073's sentence made checkable rather than aspirational, and the EIP-1193-only constraint of ADR-0002 with it.

`declaredMethodsOnly(provider)` is the wrapper that enforces it. `IndexerGeneration` (including the reconfigure path), `LogFetcher` and `captureStream` now hold their provider behind it, so ONE seam sees every call each of them makes: it RECORDS the methods requested (`methodsRequested`, which is what a test asserts the subset against) and REFUSES anything else with an `UnexpectedProviderMethodError` naming the method and what it would cost. The wrapper is idempotent, so a reconfigure does not stack guards.

Why a refusal rather than a note. Deleting the enrichment path made the claim true; nothing in a deletion keeps it true. A reintroduced `eth_getBlockByHash` breaks nothing and returns the right answer. It just costs a round trip per block against a provider a browser user is rate-limited on, so it surfaces in a profile months later rather than in CI in seconds. Refusing at the seam is what makes it fail wherever it is added, over any node or test double that would have answered it.

The one method that can read a block is narrowed further, by the same argument: `eth_getBlockByNumber` is allowed at the chain's FIRST block (`earliest` or `0x0`) and refused at a height, because a block read at a height is the deleted per-block cost wearing a different method name.

What a caller has to know:

- **Nothing changes for a well-behaved deployment.** The engine asks for exactly what it asked for before; no call is added, removed or reordered, and no identity, digest or stored byte moves.
- **A provider given to the engine is not the object the engine holds.** It is wrapped. A caller keeping its own reference is unaffected; a caller reaching into the engine for `provider` gets the guarded one.
- **The declared set is exported**, so a deployment reasoning about what its node will be asked for, or a proxy deciding what to allow through, reads the set rather than a sentence in a README. The READMEs state the same set and a test holds them to it, so widening it is a documented act rather than a quiet one.
