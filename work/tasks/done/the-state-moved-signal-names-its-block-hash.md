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

## Decisions

- **`hash` is a sibling of `block`, matching the `extensions` shape that landed.** `a-query-is-pinned-to-a-block-hash` landed `extensions` as `{generation, block, blockHash}`, so the applied notification is `{kind: 'applied', block, hash, coherence, entities, generation}` rather than `block: {number, hash}`. `block` stays a number for every existing reader, and the field is named `hash` because inside a notification that already says `block` a `blockHash` would repeat itself.
- **`AppliedBlock.hash` is REQUIRED, not optional.** An optional hash would let a fold report an applied block with no hash, and core would then publish a notification a reader cannot pin. A custom `EventProcessor` that implements the optional `setFoldReporter` must now report it. On 0.x that is a minor bump for `@etherfold/core`, stated in the changeset.
- **Normalised from the block pointer, not read back from the store.** processor-entities reports `normalizeBlockHash(pointer.hash)` right after `applyBlock` returns, the same function every backend applies on write, rather than asking the store for the hash it recorded. Reading back would cost a read per block for the same value. Tests prove the equality against the store on SQLite and IndexedDB (`blockAt(n).hash`), and against `extensions.blockHash` end to end.
- **Core relays the hash untouched and does not normalise it.** Core cannot import `@etherfold/state-store` (ADR-0016). Normalising twice would hide a producer that forgot to. The core tests assert the relay is exact on both containers.
- **The conformance suite gets a new REQUIRED adapter verb, `recordedHashAt(block)`, instead of changing what `applyNextBlock` returns.** The verb reads the hash from the STORE behind the canonical fold, never from a notification or from what the adapter served, so the suite checks the store's spelling and not the adapter's. Changing `applyNextBlock` to return `{block, hash}` would have touched every existing case. The new verb breaks external adapters, which is a minor bump on 0.x. Two cases use it: the exact key set now has six fields and the hash equals the recorded one, and a block that REPLACED another at the same height after a retraction is named by a different hash, equal to the new recorded one.
- **The server's conformance adapter serves UPPER-case hashes on purpose.** The store folds them to lower case, so the suite checks, over the network transport, that the notification carries the store's spelling and not the chain's. A mutation check confirmed it: dropping the normalisation in `apply.ts` fails exactly the two hash cases on the server transport.
- **A drift case was added to the suite's self-checks (`packages/browser/test/oneHandlerForEveryTransport.test.ts`).** A transport that upper-cases the hash on its way across must fail the new replacement case by name.
- **The `extensions` equality test lives in `@etherfold/graphql`'s tests** (`the-signal-names-the-hash-the-answer-names.test.ts`). That package already has the browser host, core and processor-entities as dev dependencies. The test runs a real fold over a fake chain serving upper-case hashes, behind a main-thread host with `graphqlQueryHandler()`, and reads through the tab's port with `workerExecutor`. It asserts that `applied.hash === extensions.blockHash` while that block is the tip. It also asserts the recipe the maintainer described: a re-read pinned to the signalled hash answers, and once a reorg replaces that block the same pin is refused with `block-not-recorded`.
- **The guide's re-query recipe and the browser reference pin the GraphQL re-read to the signalled hash.** The document takes an optional `$at: BlockAddress`, so omitting it reads at the tip. `render(at?)` is called with the hash from an `applied` notification, and with nothing for a retraction or a pointer move, which name no block. A pinned read refused with `block-not-recorded` re-renders at the tip, because the maintainer's intent is "the follower reads everything again". The reference also shows the last signalled block's number and hash (`#moved`). A new real-browser spec asserts it, and asserts that the page's own document pinned to that hash answers while an unrecorded hash is refused.
- **Two stale `extensions: {generation, block}` mentions in the browser guide were corrected to `{generation, block, blockHash}`.** This is drift left by #269 in the same guide sections this task edits, and the recipe here depends on `blockHash`.
- **Changesets:** `@etherfold/core` minor, `@etherfold/processor-entities` minor, `@etherfold/state-moved-conformance` minor, `@etherfold/server` patch (a doc comment and its README only). `@etherfold/browser`, `@etherfold/processor-sqlite` and `@etherfold/graphql` changed only tests and the browser test harness (`browser/`), so they have no changeset. Their transports carry the value through untouched and their types come from core.
