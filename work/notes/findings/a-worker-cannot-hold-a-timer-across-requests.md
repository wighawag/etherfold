---
title: 'A Cloudflare Worker cannot hold a timer across requests, so a store cannot own its own prune schedule'
slug: a-worker-cannot-hold-a-timer-across-requests
source: 'Cloudflare Workers docs, retrieved 2026-09-10: "Errors and exceptions" (https://developers.cloudflare.com/workers/observability/errors/, page states "Last updated Jun 16, 2026") and "Limits" (https://developers.cloudflare.com/workers/platform/limits/, page states "Last updated Sep 5, 2026").'
---

The platform ground truth ADR-0076 rests on. It was written down nowhere in this repository, and the
decision it supports (a REPORT rather than a construction-time refusal naming "schedule a prune" as
the remedy) is unreadable without it.

## What the platform documents

**Invocations are isolated, and I/O may not cross them.** From "Errors and exceptions", verbatim:

> Cannot perform I/O on behalf of a different request. I/O objects (such as streams, request/response
> bodies, and others) created in the context of one request handler cannot be accessed from a
> different request's handler.

and the explanation beside it:

> In Cloudflare Workers, each invocation is handled independently and has its own execution context.
> This design ensures optimal performance and security by isolating requests from one another. When
> you try to share I/O objects between different invocations, you break this isolation.

The documented remedy is to keep only DATA in global scope, never the I/O object, and to reach for
Durable Objects for state across requests.

**Work outside an invocation is cancelled, and the extension is bounded.** From "Limits", on
duration:

> When the client disconnects or the response is complete, tasks associated with that request may be
> canceled. Use `ctx.waitUntil()` to perform work after returning a response. `waitUntil()` can
> extend execution for up to 30 seconds after the response is sent or the client disconnects.

So the escape hatch is 30 seconds attached to a request that already happened, not a background loop.

**Periodic work is a Cron Trigger, which is an INVOCATION.** The same page lists Cron Trigger as a
trigger type with its own duration limit (15 min) and its own CPU allowance (30 s under an hourly
interval, 15 min at or above one), and caps Cron Triggers per account (5 free / 250 paid). A cron
fires the Worker; it does not let the Worker keep running.

## What follows for this repository

A `StateStore` constructed inside a Worker request cannot own a background timer that prunes later:
the timer would have to survive past the invocation that created it, and the database handle it would
prune through is exactly the kind of I/O object the first quotation forbids carrying across. So
"configure a window and the store schedules its own enforcement" is not a design this project may
choose, on a platform it already ships to (`platforms/cf-worker`, whose `d1.ts` docstring has always
told the HOST to schedule `store.prune({maxVersions: d1PruneBudget(plan)})`).

This is the same conclusion ADR-0022 reached from a measurement (a prune costs time proportional to
what it drops, so the cadence belongs to the host). The difference is that ADR-0022's version is a
JUDGEMENT that could in principle be revisited, and this one is a PLATFORM CONSTRAINT that cannot:
even a project willing to pay the cost could not build the timer on a Worker.

The corollary is the shape the CLI already took: the pruning loop takes its budget as a PARAMETER and
loops on `complete` (`pruneMore`, `@etherfold/state-store`), so a Worker's `scheduled` handler drives
the same loop with `d1PruneBudget(plan)` and no host reimplements one.

## What this does NOT say

- It says nothing about `setTimeout` inside ONE invocation, which is ordinary and fine.
- It is not an argument against Durable Objects, which the docs name as the way to hold state across
  requests. A DO alarm is a real scheduling primitive; it is a HOST facility a deployment wires up,
  not something a store constructed behind the seam can reach for on its own.
- It does not bear on the browser or on Node, where a host can hold a process. The point is that a
  rule the seam imposes must hold on every platform this project ships to, and this is the one that
  says no.
