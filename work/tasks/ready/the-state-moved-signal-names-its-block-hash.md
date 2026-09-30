---
title: 'The state-moved signal names the hash of the block it applied'
slug: the-state-moved-signal-names-its-block-hash
blockedBy: [a-query-is-pinned-to-a-block-hash]
covers: []
---

## Answered (2026-09-29, by the maintainer)

Add it, judged on its own merit and not deferred for its refactoring cost. The block's hash is already in hand when the fold applies the block (it is what the store records), so the cost is about 66 bytes per `applied` notification, no work on the producer beyond carrying it, and nothing for a reader that ignores it. What it buys: a follower pins its re-reads to EXACTLY the block it was told about (`block: {hash}`, from `a-query-is-pinned-to-a-block-hash`), so if that block is replaced before the re-read, the re-read is refused and the follower reads everything again, instead of reading the replacement and briefly composing parts from two branches until the rotated coherence token arrives. A remote consumer can also match a notification to an answer exactly (`extensions` names the same hash) and key a cache on it, which a number, not unique across a reorg, cannot do.

## What to build

The `applied` variant of `StateMoved` (`@etherfold/core`, `stateMoved.ts`, ADR-0083) carries the applied block's hash beside its number: `{kind: 'applied', block, hash, coherence, entities, generation}`. `retracted` and `repointed` are unchanged. The hash is the one the store records for that block, in the same normalised form. It equals the hash `extensions` names for an operation answered while that block is the tip (an operation's pin is the tip; a root field's own `block` does not change it); follow whatever `extensions` shape `a-query-is-pinned-to-a-block-hash` lands.

The hash reaches `StateMoved` through the fold report, which does not carry it today: `AppliedBlock` (`@etherfold/core`, `types.ts`) is `{kind, block, entities}`. It is emitted in `@etherfold/processor-entities` (`apply.ts`, right after `store.applyBlock(blockPointer(block), ...)`, which already has `block.hash`), relayed by `@etherfold/processor-sqlite`, and published by both containers' fold-report handling in core (`container.ts`, `receivingContainer.ts`). The hash is normalised in processor-entities (`normalizeBlockHash`, `@etherfold/state-store`), since core cannot import it (ADR-0016).

It reaches every reader on all three transports (the tab's port, the cross-tab channel, and server-sent events at `/{indexer}/state-moved`), the same value on each, because one conformance suite (`@etherfold/state-moved-conformance`) runs the same cases over all three.

## Acceptance criteria

- [ ] `AppliedBlock` carries the hash from the fold to both containers, and every `applied` notification carries it, equal to the hash the store recorded for that block and to the hash `extensions` names for an operation answered while that block is the tip.
- [ ] The state-moved conformance suite asserts the hash on all three transports.
- [ ] `examples/browser-reference` and the guide's "How your app learns the state moved" show the field, and the guide's re-query recipe pins to it.
- [ ] ADR-0083 gets a dated amendment for the new field and why.
- [ ] Changesets for every published package changed (0.x: minor, an additive field on a published type).

## Blocked by

- `a-query-is-pinned-to-a-block-hash`: pinning a re-read to the signalled hash needs the query to accept one, and the hash must be the same normalised value `extensions` reports.

## Prompt

> Goal: the state-moved signal's `applied` notification names the hash of the block it applied, on every transport, so a reader pins its re-reads to exactly that block. Look at `StateMoved` and its publisher in `@etherfold/core` (`stateMoved.ts`), the fold report that feeds it (`AppliedBlock` in core's `types.ts`, emitted in processor-entities' `apply.ts`, relayed by processor-sqlite, published from `container.ts` and `receivingContainer.ts`), the three transports (the browser host's port, `openStateMovedAcrossTabs` in `@etherfold/browser`, the server's `/{indexer}/state-moved` route), `@etherfold/state-moved-conformance`, and ADR-0083. The query side (hash pinning, `extensions.hash`) is `a-query-is-pinned-to-a-block-hash`, which this is blocked by.
>
> FIRST, check this task against current reality (written 2026-09-29 against `@etherfold/core@0.10.0`). If the premise has drifted, route to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious choice in a `## Decisions` block at the end of your final report. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands, and never grep `node_modules`, `dist`, `.git` or minified bundles.
