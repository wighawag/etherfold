---
title: 'The learned range is reported, and can be configured back in after a restart'
slug: the-learned-range-is-reported-and-can-be-configured-back-in
spec: the-fetcher-reads-the-hints-providers-already-send
blockedBy: []
covers: [7, 8]
---

## What to build

The fetcher learns what a provider will accept, by being refused and adapting: a discovered upper bound, the largest span that has succeeded, and the size it will ask for next. All three are in-memory fields on the range fetcher, invisible from outside and gone on restart, so every process start re-pays the discovery from the small starting range upwards.

Two halves, and they are the same feature seen from both ends:

1. **Report it.** Surface what the fetcher currently believes about the provider in the status surface, beside the counters already reported there. Today an operator can only infer it from timings.
2. **Accept it back as configuration.** The starting range is already configurable; make it possible to start from the values a previous run reported, so a restart resumes where discovery left off.

**Persist nothing.** This is the decision the task makes explicit, so it is not quietly reversed: the fetching half of ADR-0003 deliberately holds no state worth losing, and inventing a store inside it to remember a performance hint would trade that property for a few round trips. Reported plus configurable gets the same result for a deployment that wants it, an operator or a supervisor reads the value and passes it back, and the component stays stateless. A run that configures nothing simply rediscovers, exactly as today.

## Acceptance criteria

- [ ] The status surface reports what the fetcher believes about the provider's limits, and the reported shape is documented
- [ ] The reported values can be supplied as configuration on a later run and are honoured as the starting point
- [ ] A configured starting point is still subject to adaptation: a provider that refuses it lowers it, so a stale configured value costs a retry and never wedges
- [ ] Nothing is written to any store by this task
- [ ] A run that configures nothing behaves exactly as today
- [ ] A CHANGESET accompanies the change. The repo's acceptance gate runs `changeset status --since=main`, so a touched package with no changeset is a RED GATE rather than a style nit. Describe the change in prose, as the repo's existing changesets do, not in one line

## Blocked by

- None, can start immediately. Independent of the refusal-parsing chain; touches the status surface and the fetcher's configuration rather than its error handling.

## Prompt

> Make the fetcher's learned limits visible and reusable without making it stateful. Read ADR-0003 and ADR-0004 for why the fetching half holds no state worth losing, and the log fetcher's own class docstring, which spells out the test for whether a piece of state is safe to hold there (losing it must cost one extra request and nothing else).
>
> Domain vocabulary: the range fetcher adapts by tracking a discovered ceiling, a largest-known-safe span, and the next size to request. The receiver owns the cursor; the fetcher owns only hints. The status surface already reports counters and a cursor envelope the server never parses, so there is a precedent for reporting an opaque-ish blob a human reads.
>
> The tension to hold, and the reason the answer is report-and-configure rather than persist: losing the learned range costs MORE than one request (it re-pays discovery from the small starting range), so it fails the docstring's own test for state the fetcher may hold, yet it is still only performance. Reporting it moves the memory OUT of the stateless component to whoever is already durable, which resolves the tension rather than trading it away.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): confirm the status surface and the fetcher config still have the shape described.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do no git, do not edit the task body, and do not open an observation note for decisions.
