---
title: 'The server README example hands `getCursorReport` a bare value, not a `StatusReport`'
slug: server-readme-cursor-reporter-example-returns-a-bare-value
observed: 2026-09-26
---

2026-09-26, noticed while building `status-says-when-the-canonical-generation-is-frozen`. `packages/server/README.md`'s setup example has `getCursorReport: async (c) => ({lastToBlock: await myStore.howFar()})`, but `CursorReporter` (`packages/server/src/types.ts`) returns a `StatusReport` whose slots are NAMED (`{value?, generations?, canonical?}`), so the example should read `({value: {lastToBlock: ...}})`. As written it reports no `value` and a stray key. Predates this task (already on `main`).
