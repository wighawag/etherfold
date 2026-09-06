---
title: "A decode failure's real error is overwritten by a generic one before anyone can read it"
slug: a-decode-failures-real-error-is-overwritten-by-a-generic-one
---

2026-09-06. In `LogEventFetcher.decodeOnto` (`packages/core/src/internal/decoding/LogEventFetcher.ts`) the catch writes `decodeError = \`decoding error: ${err}\`` and sets `parsed = null`, and the very next block then overwrites it with the constant `'parsing did not return any results'` because `parsed` is falsy. So the `decoding error:` branch is unreachable in the OUTPUT, and every failure — a topic0 the ABI does not declare, data that does not match the member it names, a log with no topics at all — records the same uninformative string.

Spotted while landing the topic0 preselection (`work/tasks/done/decoding-preselects-the-event-by-topic0-instead-of-re-searching-the-abi.md`), and deliberately NOT fixed there: that task was a pure optimisation whose contract was byte-identical output, and `decodeError` is part of what is stored on a `LogEventWithParsingFailure`, so changing the string is a behaviour change with its own blast radius.
