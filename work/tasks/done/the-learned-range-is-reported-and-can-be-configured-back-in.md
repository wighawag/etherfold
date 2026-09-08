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

## Decisions

- **The status surface is `/status`, through a SECOND injected reporter (`getFetcherLimits`) and a new top-level `fetcher` field.** The spec's story 7 says "readable in the status surface", and that surface belongs to the receiving half, so only the COMBINED `run` can report it; a split `etherfold fetch` process has no HTTP surface and gets the startup line and logs only. Alternatives considered: growing the value inside the existing `cursor` envelope (rejected — it re-means a field that is about the cursor, and ADR-0047 reserved growth inside it for the generation dimension), and giving the fetcher its own status surface (a much bigger, separate question). Touches: `@etherfold/server` `ServerOptions`, `@etherfold/platform-nodejs` `StartOptions`, and the CLI's `run` (only `run` injects one; `index`/`serve` deliberately do not).
- **That field is TYPED rather than carried verbatim, unlike the cursor beside it.** ADR-0047 makes the cursor opaque because its meaning lives behind the storage seam and is a processor's (ADR-0027); a learned range is `@etherfold/core`'s (a dependency `@etherfold/server` already has) and is three numbers, so the server names the keys and there is no serialisability probe to run. What is kept from ADR-0047 is the degrade rule: a reporter that throws or has nothing to say yields `{reported: false, reason}` rather than an omission, because "no fetcher here" and "the reporter is broken" are different news. Alternative considered: an opaque `value` blob for symmetry, rejected as hiding a shape both ends already publish. Recorded in ADR-0074.
- **ONE environment variable carrying the whole reported object (`LEARNED_RANGE`), not three.** The round trip is "read the reported object, paste it back", and three variables would make an operator take a report apart and let two thirds of one arrive. Alternative considered: `LEARNED_CEILING` / `LEARNED_SAFE_SPAN` / `LEARNED_NEXT_SIZE`. Touches: the fetcher host's published variable set (documented in `platforms/nodejs-fetcher/README.md`), which `run`, `build` and `fetch` all read; no CLI flag was added, per that command's rule that everything a fetcher deployment tunes stays in the environment.
- **A new startup REFUSAL, but deliberately asymmetric: unreadable is refused, unrecognised is ignored.** Malformed JSON, a non-object, or a member that is not a positive whole number of blocks raise `FetcherConfigError` naming the field (the same class as a malformed `INDEXING_SOURCE`), because that is a misconfiguration an operator can fix and silently doing nothing would leave them watching a rediscovery they thought they had avoided. An unknown KEY is ignored, so a report that grows a field later cannot turn a supervisor that pastes it into an outage — this is a performance hint, and refusing to start over one is disproportionate. Inside core the same values are only ever ignored, never refused, which is defence in depth for a hint arriving through a human.
- **A configured `safeSpan` at or above the configured `ceiling` is dropped rather than clamped or believed.** A span cannot be both known-safe and at-or-above a width that was refused, and the ceiling is the half a refusal backs. I deliberately did NOT make the discovered path coherent the same way (clamping `safeNumBlock` inside `lowerBlockCeilingTo`): that changes the halving arithmetic every deployment depends on, which is outside this task's fence, so it is the observation note above instead. Consequence, documented on the getter: a REPORTED range may carry that incoherent pair honestly, and the configuration side is where it is dropped.
