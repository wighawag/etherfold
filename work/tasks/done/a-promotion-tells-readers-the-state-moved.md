---
title: 'A promotion tells readers the state moved, even at a quiet tip'
slug: a-promotion-tells-readers-the-state-moved
blockedBy: []
covers: []
---

## What to build

Resolve `work/notes/observations/a-promotion-at-a-quiet-tip-posts-no-state-moved.md`. When the canonical pointer moves to another generation (a promotion: a hot-updated processor or a redeploy catching up), `StateMovedPublisher.rotate` (`packages/core/src/stateMoved.ts`) rotates the coherence token and PUBLISHES nothing, by design: "a pointer move has no block to name ... the next notification carries the new token" (`Indexer.movePointerTo`). On a chain with no new block there is no next notification, so a reader that re-reads on the state-moved signal (every host's `onStateMoved`, the main thread's reactive stores, a tab reading a worker host, the cross-tab signal) keeps rendering the old generation's data while reads already answer the new one. Measured in `a-worker-host-takes-a-hot-updated-processor`, where the browser reference works around it by polling the generation list while a switch is pending.

Make a promotion NOTIFY: when the pointer moves, a state-moved notification carrying the rotated token is published at once, through every transport that carries the signal today, so a reader invalidates and re-reads without waiting for a block. Shape it within ADR-0083 (the signal carries a coherence token; a rotated token means "invalidate everything"): decide what the notification carries in place of a block (for example no changed set, only the rotated token and the new generation), and make sure a promotion followed by a block does not deliver a confusing pair (for example a second rotation) to a reader. Amend ADR-0083 in place if its text says a promotion publishes nothing. Then remove the reference's polling workaround (`examples/browser-reference/browser/main.ts`) and the guide's matching advice, if any, and retire the observation.

## Acceptance criteria

- [ ] At a quiet tip (no new block), a promotion delivers a state-moved notification with the rotated token to a subscribed reader, on the main-thread host, a dedicated-worker host (over the port) and a SharedWorker host, and across tabs where the cross-tab signal carries it.
- [ ] A reader that re-reads on that notification renders the new generation's data without any polling.
- [ ] A promotion followed by a new block delivers the promotion once and the block once, each with the right token.
- [ ] The browser reference no longer polls for a switch, and its `verify/reference.spec.ts` still asserts the switch is rendered.
- [ ] ADR-0083 matches the behaviour; the observation is retired; changesets for every published package changed (0.x: patch or minor).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: a promotion publishes a state-moved notification (see What to build). Look at `packages/core/src/stateMoved.ts` (`StateMovedPublisher`, `rotate`), `Indexer.movePointerTo`, `packages/browser/src/stateMovedAcrossTabs.ts`, the host port's `onStateMoved`, ADR-0083, and the reference's workaround in `examples/browser-reference/browser/main.ts`.
>
> FIRST, check this task against current reality: if a promotion already notifies, route to needs-attention saying so.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **A third case in the union, `kind: 'repointed'`, with only `{coherence, generation}`.** Why: no block was applied, so any block number would be made up. An entity set is pointless because the token is always rotated, which already tells a reader to invalidate everything. A reader's two-line rule still covers it: the token check fires, and the narrow line only reads `applied`. Alternatives considered: re-using `applied` with a fake block and empty entities (dishonest, and it would confuse a reader that tracks blocks); re-using `retracted` (wrong meaning). This reverses the old "no second event kind" wording in ADR-0083 and CONTEXT.md, both amended. It touches every consumer that switches exhaustively on `kind`: the cross-tab filter and `browser/cut.ts` were updated here.
- **Named `repointed`, not `promoted`.** Every move of the canonical pointer triggers it, including a move back (revert), and the glossary's term is "canonical pointer". It is a new name in the glossary.
- **Rotate first, announce last.** The rotation stays where it was, after the registry write and before the pointer-moved callback and the state notification. The announcement goes out after the read path has followed the pointer, and before the drop of the old generation. Why: a reader that re-reads the instant it is told must get the generation the notification names. Doing it in one step would either publish before reads switch over (a reader could re-read the old data) or rotate too late, contradicting ADR-0083's ordering. `rotateForPointerMove` returns the announcer so a move can never be published under an unrotated token; that is a new public method on `StateMovedPublisher`.
- **The receiving container announces even when this process holds no fold for the new generation** (for example a revert after a redeploy). Its reads resolve the durable pointer, so the new generation answers either way. The alternative was to stay silent there, which would leave readers stale exactly like the bug this task fixes.
- **Changeset levels:** core and conformance minor (new union case, changed conformance cases), browser patch (filter widened), server patch (test-only change, which `changeset status` still wants listed).
