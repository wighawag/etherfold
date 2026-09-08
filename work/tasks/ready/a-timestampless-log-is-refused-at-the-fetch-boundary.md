---
title: 'A log with no blockTimestamp is refused at the fetch boundary, naming the node'
slug: a-timestampless-log-is-refused-at-the-fetch-boundary
spec: etherfold-is-a-fold-over-logs
blockedBy: []
covers: [2, 12]
---

## What to build

The replacement guard, added BESIDE the fallback it will later replace (nothing is deleted here).

Today a log arriving with no `blockTimestamp` is either silently compensated for by fetching the block (`alwaysFetchTimestamps`), or refused much later at fold time by `blockPointer`, which names the BLOCK. Once the fallback is gone, the refusal has to name the thing an operator can act on, and that is the NODE.

Add a refusal at the fetch boundary: when a fetched range contains a log with no readable `blockTimestamp`, refuse with a message that names the standard (`ethereum/execution-apis#639`), the minimum implementations that serve it INCLUDING `@nomicfoundation/edr >= 0.20.0`, and the likely CAUSES, because per ADR-0073 they are all node-level and each has a different fix:

- the node predates the change
- it is a Hardhat version bundling an older EDR (the fix is a package-manager override to `@nomicfoundation/edr@>=0.20.0`, NOT waiting for a Hardhat release)
- it is forking a node that predates the change
- it is answering from an EDR RPC response cache written before the change (`rpc_cache` needs dropping)

While `alwaysFetchTimestamps` still exists, the refusal must NOT fire when that flag is set, since the fallback resolves the timestamp and there is nothing to refuse. The task that deletes the flag also deletes that condition.

`blockPointer`'s existing fold-time refusal STAYS and is not touched here. ADR-0073 explains why the two coexist: a stream can reach the fold without passing the fetcher at all (a seed install writes through the keeper seam, a fixture reader replays a captured stream), so a fetch-boundary check would never see those.

## Acceptance criteria

- [ ] A fetched range containing a log with no readable `blockTimestamp` is refused, with the refusal naming the standard, the minimum EDR version, and the four likely causes
- [ ] The refusal does NOT fire while `alwaysFetchTimestamps` is set
- [ ] A node that serves the field is entirely unaffected: no new call, no new failure, no behaviour change
- [ ] `blockPointer`'s fold-time refusal is unchanged and still fires for a stream that reached the fold without passing the fetcher
- [ ] A test covers a seed-installed or fixture-replayed stream still being caught by the fold-time refusal, so the two guards are shown to be non-redundant
- [ ] Tests mirror the repo's existing test style
- [ ] A CHANGESET accompanies the change. The repo's acceptance gate runs `changeset status --since=main`, so a touched package with no changeset is a RED GATE rather than a style nit. Describe the change in prose, as the repo's existing changesets do, not in one line

## Blocked by

- None, can start immediately. (Independent of the digest guard: different files, different concern.)

## Prompt

> Add the fetch-boundary half of a two-place refusal. Read `docs/adr/0073-the-engine-makes-one-data-call-and-eth-getlogs-is-it.md`, section "The refusal is PERMANENT machinery, and it lives in two places", before starting: the two-guard design is deliberate and a reviewer will check you did not collapse it.
>
> Domain vocabulary: `blockTimestamp` is optional ON THE WIRE (`ethereum/execution-apis#639`) and the engine reads it off the log; `alwaysFetchTimestamps` is the legacy fallback that fetches the block when it is absent, and it is deleted by a later task in this spec, not by you. A SEED (ADR-0063) and a FIXTURE READER (ADR-0059) both put events into a fold without a fetcher ever running, which is why the fold-time refusal cannot be dropped in favour of yours.
>
> Look in `@etherfold/core` at the log-fetch path and the log decoding that reads the timestamp off the log; the fold-time refusal is `blockPointer` in `@etherfold/processor-entities`. Note that the timestamp is read tolerantly (hex or decimal quantity, absent yields undefined rather than a guess) and that tolerance must be preserved: "unreadable" and "absent" are the same outcome here, and neither may be defaulted to a number.
>
> Why the refusal is permanent rather than transitional, and why the message must be this specific: two paths yield a timestampless log at ANY version (a forked node predating the change, a stale EDR RPC cache), so an operator hitting this needs to be told which of four situations they are in. A message that says only "missing blockTimestamp" sends them to the wrong fix.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): if the fetch path has moved or the fallback already went, route to needs-attention rather than building on the stale premise.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do no git, do not edit the task body, and do not open an observation note for decisions.
