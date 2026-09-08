---
title: 'The genesis check asks for block 0, not the earliest tag'
slug: the-genesis-check-asks-for-block-zero-not-the-earliest-tag
blockedBy: []
covers: []
---

## What to build

**A confirmed bug.** The genesis-hash identity check reads the block tag `earliest` and compares the hash it gets against the source's declared `genesisHash`. `earliest` does not mean genesis. It is defined as the LOWEST BLOCK THE CLIENT HAS, which is only block 0 when the client happens to have block 0.

Ask for block `0x0` explicitly instead.

Two ways the current code is wrong in practice, and the second is not an edge case:

- **A pruned or partially-synced node** may not serve block 0 under that tag.
- **A chain that has had a REGENESIS** has nodes whose earliest block IS the regenesis point, by design. Several L2s have done this.

In both cases the hash cannot match, so the indexer refuses to start against a healthy node on the correct chain, and the message it prints says it is connected to a DIFFERENT CHAIN. A false positive whose text actively misleads, on a check whose entire job is to be trustworthy about identity.

This is reachable in real deployments rather than theoretical: `genesisHash` is optional on the source but it is genuine user-supplied configuration, read from a contracts file by `@etherfold/utils`, and it is hashed into the stream identity. Any deployment that declares one runs this check on every load.

### Both call sites

There are two, and the second is easy to miss because it is commented out:

1. The LIVE check in the load path, guarded by the source declaring a `genesisHash` and by `skipGenesisCheck` not being set.
2. A commented-out PER-CYCLE genesis check beside the per-cycle chain-id calls, which carries the same `earliest` mistake and would reintroduce the bug the day anyone revives it.

Fix the first. For the second, either fix it in place or delete it; do not leave a commented-out block containing the bug that was just fixed above it.

### Leave a reason at the site

`earliest` reads as the obvious, expressive way to ask for genesis, and `0x0` reads like a magic number. Somebody will tidy it back. One comment saying why (the tag means lowest-available, not genesis, and they differ on pruned nodes and regenesis chains) is what stops that. This is borderline ADR material; a comment is judged sufficient because the fix is small and local, but say so in your report if you disagree after seeing the code.

### Adjacent defect, in scope because it is the same lines

Marked separately so it can be dropped if you disagree: **the check refuses to start on three unrelated conditions and cannot tell them apart.**

- The node is genuinely on another chain. The check's purpose; refusing is correct.
- The node will not serve the block. Currently throws a message naming the EXPECTATION rather than the failure, so an availability problem reads as a mismatch.
- **The request itself fails.** A transient RPC error, a timeout, a rate limit: nothing catches it, so it propagates out of the load path exactly as a real mismatch does.

The third is the common one, and it means a flaky endpoint at startup is indistinguishable from being pointed at the wrong chain. Since this task is already rewriting these lines, separating the three is cheap here and expensive later. What a caller does about each differs completely: retry, degrade, or stop and fix your configuration.

Note the same shape exists one line earlier for the `eth_chainId` check, which is also uncaught. Fixing that too is welcome but is NOT required by this task; if you leave it, say so.

## Acceptance criteria

- [ ] The live genesis check requests block `0x0` explicitly and no longer uses the `earliest` tag
- [ ] A comment at the site states why, specifically enough that a future reader does not revert it
- [ ] The commented-out per-cycle variant is fixed or deleted, never left carrying the old mistake
- [ ] A node whose lowest available block is not genesis no longer produces a wrong-chain refusal, covered by a test with a fake provider that answers `earliest` and `0x0` differently
- [ ] A genuine genesis mismatch still refuses, with a message naming both the expected and the received hash
- [ ] (Adjacent) A node that cannot serve the block, and a request that fails outright, are each distinguishable from a mismatch by a caller, and none of the three is reported using another's wording
- [ ] No `earliest` remains in the repo, comments included
- [ ] A CHANGESET accompanies the change. The repo's acceptance gate runs `changeset status --since=main`, so a touched package with no changeset is a RED GATE rather than a style nit. Describe the change in prose, as the repo's existing changesets do, not in one line

## Blocked by

- None, can start immediately. Independent of every other staged task; it touches the load-path identity preamble, which none of them edit.

## Prompt

> Fix a confirmed identity-check bug in `@etherfold/core`'s load path. The maintainer has confirmed the diagnosis, so this is a fix rather than an investigation: the check must ask for block `0x0`, not the `earliest` tag.
>
> Domain vocabulary: the indexer verifies chain identity at load in two steps, `eth_chainId` and then, when the source declares a `genesisHash`, a genesis-hash comparison. A genesis hash is the STRONGER assertion of the two, because two chains can share a chainId but not a genesis hash, which is exactly why the check must actually be comparing genesis. `skipGenesisCheck` is the existing escape hatch and it is undocumented; a docstring on it while you are here would be welcome.
>
> The bug in one line: the JSON-RPC block tag `earliest` means the lowest block the client HAS, which is genesis only when the client has genesis. Pruned nodes and regenesis chains break that assumption, and the failure presents as a confident wrong-chain refusal against a perfectly good node.
>
> Verify the fix does not merely move the problem: a node that will not serve block `0x0` either should produce a message about not being able to CHECK, not one about being on the wrong chain. That distinction is the adjacent defect this task also asks you to address, and the two fixes belong together because they are the same handful of lines.
>
> FORWARD-POINTER, on the OPTIONAL `eth_chainId` half only. `work/specs/proposed/one-chain-identity-check-per-cycle-not-two.md` DELETES the before-fetch `eth_chainId` call and keeps the after-fetch one as the permanent guard, and it also asks (its story 4) that the surviving refusal name what it expected and what it got. So if you take up this task's optional offer to extend the three-way error separation to the neighbouring chain-id check, put that work on the AFTER-fetch call, not the before-fetch one, which is slated for deletion. Do NOT delete the before-fetch call here: that is the other spec's decision to make, not yours. This does not affect the genesis check itself, which that spec explicitly leaves untouched.
>
> FORWARD-POINTER, on the "no `earliest` remains in the repo" criterion. A THIRD site now holds that string, added deliberately after this task was written: `packages/core/src/providerSurface.ts`'s `isGenesisProbe` accepts BOTH `earliest` and `0x0` as the genesis probe's parameter, precisely so your one-line fix does not trip the engine's declared-provider-surface guard (`the-engine-declares-its-method-set-and-a-test-holds-it-to-it`, merged). Once you have changed the call site to `0x0`, NARROW that predicate to `0x0` alone and drop the `earliest` arm, which is what its own comment tells you to do. Do not instead widen your fix or leave the arm standing: the whole point of the predicate is that the engine only ever names the bottom of the chain, and after your change `earliest` is not a spelling the engine uses.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): confirm both call sites still exist as described, and re-grep for `earliest` in case a third has appeared.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in particular whether you extended the fix to the neighbouring `eth_chainId` check and whether you judged the comment sufficient or wrote an ADR. Do no git, do not edit the task body, and do not open an observation note for decisions.
