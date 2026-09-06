---
title: '`LogParseConfig.filters` cannot express the `null` topic wildcard, so every filter on a non-first indexed argument needs a cast'
slug: topic-filters-cannot-express-the-null-wildcard
source: 'found by turning the acceptance gate on for examples/ (ADR-0030). Two independent examples -- examples/event-processor-nfts/browser/main.ts and examples/web-demo/src/pages/MyNFTS.svelte -- had both written the same `null` and both had been shipping only because nothing typechecked them. Runtime behaviour read from packages/core/src/internal/decoding/LogEventFetcher.ts and internal/engine/ethereum.ts on etherfold c19fb6b.'
---

> **ACTED ON by ADR-0062**, which replaced the filter surface with a rule list carrying `ArgumentFilter = (`0x${string}` | `0x${string}`[] | null)[]`. The external ground truth below is why, and it stays; the casts it describes are gone.

`LogParseConfig['filters']` used to type one filter set as

```ts
[eventName: string]: (`0x${string}` | `0x${string}`[])[][];
```

There was no `null` in it. But `null` is what `eth_getLogs` defines as "match any value in this topic position", and it is the ONLY way to filter on the second or later indexed argument: a filter on `Transfer(from, to, id)`'s `to` has to say "any `from`, this `to`", which is `[null, toTopic]`.

The runtime already supported it. `LogEventFetcher` copied the filter list into `ExtraFilters` and `getLogsWithVariousFilters` passed it through to the `topics` array of the JSON-RPC call unaltered, so a `null` arrived at the node exactly as the method specifies. **The type was narrower than both the runtime and the wire protocol.**

## Why this was invisible

Both places in this repository that filter on a second indexed argument wrote the `null`, and both are browser application code that no gate typechecked (the subject of `example-browser-code-is-typechecked-by-nothing`). `vite build` strips types, so the code ran correctly and the type error existed only in an editor nobody had open. Turning the gate on surfaced both at once, which is also what makes this a finding rather than one example's problem: two authors independently needed the wildcard, so it is the ordinary case and not an edge.

## What was done about it

The deferral recorded here (a consumer was building against `@etherfold/core@0.7.0`, so a documented cast was judged a smaller surprise than a type widened underneath them) was OVERRIDDEN, and the wildcard arrived as part of a larger reshaping rather than as the one-line widening this note anticipated. ADR-0062 replaced the name-keyed map with a list of `FilterRule`s, whose `match` entries are `ArgumentFilter`s admitting `null` in any slot; `ExtraFilters` in `internal/engine/ethereum.ts` was widened alongside it, as this note asked. No cast remains: `examples/event-processor-nfts/browser/main.ts` writes the wildcard directly, and its disappearance is the evidence the type is now right.
