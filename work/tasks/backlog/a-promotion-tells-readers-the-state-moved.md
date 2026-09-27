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
