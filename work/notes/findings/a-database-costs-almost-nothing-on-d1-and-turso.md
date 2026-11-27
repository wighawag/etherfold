---
title: 'A database costs almost nothing on D1 or Turso until a fleet, so one database per app is a layout choice and not a price'
slug: a-database-costs-almost-nothing-on-d1-and-turso
source: 'Cloudflare D1 "Pricing" (https://developers.cloudflare.com/d1/platform/pricing/) and "Limits" (https://developers.cloudflare.com/d1/platform/limits/), Cloudflare Workers "Limits" (https://developers.cloudflare.com/workers/platform/limits/), and Turso "Pricing" (https://turso.tech/pricing), all retrieved 2026-11-26. Vendor pricing pages: current on that date, liable to change without notice, so re-fetch before relying on a number.'
---

Retrieved to settle whether the trigger service (`one-trigger-service-serves-several-apps`) should give each app its own database or share one. The intuition that remote SQL databases carry a real per-database cost does not hold on either host this repo targets, with one exception (D1 on the Free plan).

## Per-database cost

| host | plan | databases | per-database charge |
| --- | --- | --- | --- |
| Cloudflare D1 | Workers Free | 10 per account | none (but capped at 10) |
| Cloudflare D1 | Workers Paid | 100,000 included, up to 1,000,000 | $0.10 / month each above 100,000, "even when it is empty" |
| Turso | Free | 100 | none |
| Turso | Developer ($4.99/month) and above | unlimited | none; "Idle databases cost only storage" |

Both bill usage (rows read, rows written, storage) summed over the account, not per database. D1 adds that an empty database "consumes approximately 12 KB of storage". So N small databases cost about what one database holding the same rows costs.

## What does differ between one database and N on D1

- **Bindings are static and per script**: about 5,000 D1 bindings fit one Worker script. A database per app means a redeploy to add an app's binding, which a shared database avoids.
- **Throughput is per database**: "Each individual D1 database is inherently single-threaded, and processes queries one at a time", each backed by one Durable Object. N databases are N independent queues; one shared database serialises every app's queries.
- **The Free plan's 10-database cap** is the one place where the count is a real constraint.

## Worker limits that bound one trigger-service invocation

From Workers "Limits", same retrieval: subrequests are **50 per request on Free, 10,000 on Paid**; D1 queries per invocation are **50 on Free, 1,000 on Paid** (they count against the subrequest limit); CPU time is **10 ms on Free**, 30 s by default and up to 5 min on Paid, for a request and for a Cron Trigger alike; a Cron Trigger or a Durable Object alarm may run for 15 minutes of wall time. D1 still caps bound parameters per query at 100 (see `d1-caps-bound-parameters-per-query-at-100`). In practice the Free plan cannot host a trigger service doing real work (every feed page, gate read, state read and delivery is a subrequest, and signature recovery alone is a meaningful slice of 10 ms), so a Cloudflare trigger service assumes Workers Paid.
