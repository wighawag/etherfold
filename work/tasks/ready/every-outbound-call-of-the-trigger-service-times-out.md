---
title: 'Every outbound call of the trigger service times out'
slug: every-outbound-call-of-the-trigger-service-times-out
spec: one-trigger-service-serves-several-apps
blockedBy: [the-trigger-schema-is-keyed-by-app]
covers: [23]
---

## What to build

Nothing in `@etherfold/triggers` bounds an outbound call today: the canonical feed read, the RPC gate, a rule's predicate (which makes its `stateReader` queries itself, through a reader the operator built in the config) and an action adapter's delivery can each hang for ever, holding the app's round. Bound every call THE CORE MAKES, which is the level the core controls (decided at tasking review, 2026-11-26):

- **The four bounded calls**: the gate (`gate()`), each feed read (`feed.read`), each predicate INVOCATION (`predicate(log, recipient, {signal})`), and each delivery (`adapter.deliver`). Each receives an `AbortSignal` that fires after the per-call timeout: 10 s by default, one option on the service applying to all four.
- **The core gives up at the timeout whether or not the callee honours the signal**: it races each call against its timeout, so an operator's gate, feed, predicate or adapter that ignores the signal still cannot hold the round past it (the abandoned promise is left to settle on its own, its result ignored).
- **The interfaces gain the signal**: the gate becomes `(context: {signal}) => Promise<number>`, `CanonicalFeed.read` and `ActionAdapter.deliver` take `{signal}`, and a predicate gets a third argument `{signal}`. `stateReader(...).query(document, at, variables, {signal})` accepts it. The new parameter is OPTIONAL for callers of `CanonicalFeed.read`, `ActionAdapter.deliver` and `StateReader.query` (existing operator implementations with fewer parameters keep type-checking), and the changeset names the new parameters. The platform README's predicate example (`platforms/nodejs-triggers/README.md`) passes the predicate's signal through, so a predicate making several reads is bounded as a whole and each read is cancelled with it. The built-ins (`canonicalFeed`, `rpcGate`, `stateReader`, `pushAction`, `rewardAction`) pass it to `fetch`.
- A timed-out feed or gate read fails the round like an unreachable feed: nothing is committed for that page, and the journal records `stalled` (with a code that says it timed out) and `recovered` as it does today.
- A timed-out predicate fails its page the same way (as a `StateReadError` would: the page is not committed and is read again next round), with a timeout code.
- A timed-out delivery is a RETRYABLE outcome, like a `5xx` (backoff, then the retry budget, then a dead letter).
- `etherfold-triggers` exposes the timeout in its config.

## Acceptance criteria

- [ ] A feed that accepts the connection and never answers fails the round after the timeout, journalled as a stall with a timeout code, and the service's next round reads again.
- [ ] A gate that never answers does the same.
- [ ] A predicate whose state read never answers fails its page (not committed, read again next round), journalled as a stall; the read's `fetch` saw the abort.
- [ ] An operator gate, feed, predicate and adapter that each IGNORE the signal and never resolve still release the round at the timeout (the delivery counted as a retry).
- [ ] A delivery whose target never answers is retried after the timeout and, past the retry budget, dead-lettered.
- [ ] The platform README's predicate example passes `{signal}` through to `state.query`.
- [ ] The default is 10 s and the option changes it; a test uses a short timeout rather than waiting 10 s.
- [ ] The core README and the platform README document the timeout and the four calls it bounds.
- [ ] A changeset for each package changed (0.x: minor if any public interface changed, else patch).
- [ ] Tests cover the new behaviour (mirror the core's existing style).

## Blocked by

- `the-trigger-schema-is-keyed-by-app` (it rewrites the same deliverer and service modules; serialized to avoid conflicts).

## Prompt

> Goal: bound every outbound call of the trigger service (feed, gate, state read, delivery) with a per-call timeout through `AbortSignal`, so a hung endpoint cannot hold an app's round for ever. Read ADR-0101 (why: one app's hung endpoint must hold only that app; the lease that a later task adds relies on this timeout to size its fence margin, which is why the core must give up at the timeout even when a callee ignores the signal), ADR-0009 (the delivery policy: which outcomes retry) and the core README's sections on the state a predicate reads and on stalls. Code: `packages/triggers/src` (the feed, the gate, the state reader, the actions, the deliverer, the service's `tick`). The spec `work/specs/tasked/one-trigger-service-serves-several-apps.md` frames it (story 23).
>
> FIRST, check this task against current reality (written 2026-11-26). If calls are already bounded, or the app-keyed schema task landed with a different shape than this task assumes, route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> Test at the seams the suite already uses: a fake feed or target that never answers (a `fetch` that returns a promise resolving only on abort), with a short timeout.
>
> RECORD every non-obvious choice in a `## Decisions` block at the end of your final report. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified bundles.
