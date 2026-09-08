---
title: 'The genesis check refuses to start on three different failures and cannot tell them apart, and `earliest` may not even be genesis'
slug: the-genesis-check-cannot-tell-three-failures-apart
observed: 2026-09-08
source: 'noticed while scoping one-chain-identity-check-per-cycle-not-two, and confirmed by reading `promiseToLoad` in packages/core/src/indexer.ts at 8baeceaa (plus the `genesisHash?` declaration in types.ts and the undocumented `skipGenesisCheck` beside it). The CODE SHAPE below is verified. The claims about what real nodes return for `earliest` are NOT: no node was probed, and that is the half worth probing before acting.'
---

`promiseToLoad` verifies chain identity twice: `eth_chainId`, then, when the source declares a `genesisHash` and `skipGenesisCheck` is not set, `eth_getBlockByNumber('earliest', false)` compared against it. A mismatch throws and `load()` rejects, so the indexer refuses to start.

The check is right to exist (two chains can share a `chainId`; they cannot share a genesis hash). Two things about HOW it fails look wrong.

## 1. Three unrelated conditions produce a refusal, and two of them are not "wrong chain"

- **The node is genuinely on another chain.** The check's purpose. Refusing is correct.
- **The node will not serve the block.** `!genesisBlock` throws `Cannot fetch genesis Hash. Expected genesisHash === 0x...`, which names the EXPECTATION rather than the failure, so the message reads like a mismatch when it is an availability problem.
- **The request itself fails.** A transient RPC error, a timeout, a rate limit: `provider.request` rejects and nothing catches it, so it propagates out of `promiseToLoad` exactly as a real mismatch does.

The third is the one that matters most, because it is the common one. A flaky endpoint at startup is indistinguishable, to a caller and to a log reader, from being pointed at the wrong chain. The same is true one line earlier for `eth_chainId`, so this is a property of the whole identity preamble rather than of the genesis branch alone.

What a caller can do about each differs completely (retry, degrade, or stop and fix your configuration), and today all three arrive as one rejection.

## 2. `earliest` is not a synonym for genesis, and on some chains it is not even close

The check reads the tag `earliest`, and the execution-apis definition is the LOWEST BLOCK THE CLIENT HAS, which is only genesis when the client actually has genesis. Two ways that fails, and the second is not an edge case:

- **A pruned or partially-synced node** may not serve block 0. In practice geth and erigon retain headers to genesis so this is usually fine, which is exactly what makes it a latent rather than an obvious problem.
- **A chain with a REGENESIS** has nodes whose earliest block is the regenesis point by design. Several L2s have done this.

Where `earliest` is not genesis, the hash cannot match, so the indexer refuses to start against a perfectly good node, on a correct chain, with a message that says it is connected to a different chain. That is a false positive whose text actively misleads.

This is UNVERIFIED against a real node and is the half worth probing first: it is cheap to check what `earliest` returns on a couple of pruned endpoints and one regenesis L2, and the answer decides whether this is a documentation fix or a real bug.

## Why it has stayed invisible

`genesisHash` is OPTIONAL on the source, so the check only runs for a source that declares one, and nothing in `examples/` does. `skipGenesisCheck` is the escape hatch and it is the ONE undocumented field in that region of `ProvidedIndexerConfig`: its neighbours all carry docstrings, and its own absence of one is presumably why `one-chain-identity-check-per-cycle-not-two` initially failed to notice the whole gate family existed.

## What this is NOT

Not an argument to remove the check. A genesis hash is the stronger identity assertion of the two, and where it can be evaluated it should be. The suggestion is that its FAILURE MODES be separated: distinguish cannot-ask from asked-and-mismatched, do not read a transport failure as a chain identity verdict, and decide deliberately what to do when a node's earliest block is not genesis (compare against block `0x0` explicitly rather than the `earliest` tag is the obvious candidate, and it costs nothing to try).
