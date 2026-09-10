---
title: 'revert-only is the documented way to ask for reorg safety and no history'
slug: revert-only-is-the-documented-way-to-ask-for-no-history
spec: a-configured-window-is-actually-pruned
blockedBy: []
covers: [10]
---

## What to build

A browser app developer who wants reorg safety and no history should reach for `revert-only` rather than approximate it with a small window. Nothing tells them that where they meet the choice, and the measured reason it matters is sharp: retention is in BLOCK NUMBERS and event-bearing blocks on the real stream are median 429 apart, so a 64-block window holds zero or one of them. Someone reaching for a small window to mean "no history" gets a store that refuses almost every historical read while looking configured.

Make the choice legible at the point of configuration: `revert-only` says reorg safety and no history, and it reports `asOf: false` so a caller learns at startup rather than from a wrong answer.

This is a documentation and discoverability task. It changes no behaviour.

## Acceptance criteria

- [ ] The browser retention configuration documents `revert-only` as the way to say reorg safety with no history, and says what it reports (`asOf: false`).
- [ ] It states the measured reason a small window is not a substitute: retention is in block numbers and event-bearing blocks are median 429 apart on the real stream, so a short window holds almost no history.
- [ ] It states what `revert-only` still guarantees: reorg revert works, because its floor is the finality depth.
- [ ] No behaviour, default or type changes.
- [ ] `pnpm check:refs` and `pnpm check:adr` stay green.

## Blocked by

None, can start immediately.

## Prompt

Read `packages/state-store/src/retention.ts` (the `RetentionSetting` union, and `retentionFloor`'s `revert-only` arm, which yields a floor at the finality depth when one is stated) and `packages/state-store/src/capabilities.ts` (why `asOf` is separate from `retention`: they fail differently, and a `revert-only` store reports `asOf: false` so a caller knows at startup). Then `packages/browser/src/storage/state-store/BrowserStateStore.ts`, whose config type is where an app actually chooses.

Domain vocabulary: **retention** is measured in BLOCK NUMBERS and never in updates or duration (ADR-0019), and its floor is the finality depth because reorg revert already needs that much. ADR-0023 is why the light patch store is `revert-only`.

The measurement to cite is in `work/notes/findings/sqlite-in-the-browser.md`: median 429 blocks between event-bearing blocks, max 1,226,194.

This is prose, not code. If you find yourself changing a type or a default, you are in the wrong task.

Done means someone choosing retention in a browser app can see, where they choose, that `revert-only` is the honest way to say no history.
