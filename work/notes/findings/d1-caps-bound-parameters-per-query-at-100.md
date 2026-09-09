---
title: 'D1 caps bound parameters per query at 100, so the store''s default prune batch is 5x over'
slug: d1-caps-bound-parameters-per-query-at-100
source: 'Cloudflare D1 platform limits, https://developers.cloudflare.com/d1/platform/limits/, retrieved 2026-09-01 and re-fetched 2026-09-02 with every number below UNCHANGED (page still states "Last updated Apr 21, 2026"). Cross-checked against packages/state-store-sqlite/src/statements.ts and src/batching.ts at 29e17c6.'
---

Cloudflare D1's documented per-query limits, as of the retrieval above. These are the numbers the
`state-store-sqlite` `BatchBounds` must be configured against on a Worker host, and two of the three
defaults are WRONG for D1.

| D1 limit | value |
| --- | --- |
| **Maximum bound parameters per query** | **100** |
| Maximum SQL statement length | 100,000 bytes |
| Queries per Worker invocation | 1,000 (Workers Paid) / **50 (Free)** |
| Maximum SQL query duration | 30 seconds, and this applies to the ENTIRE batch call |
| Maximum columns per table | 100 |
| Maximum string / BLOB / row size | 2,000,000 bytes |
| Maximum database size | 10 GB (Paid) / 500 MB (Free) |

## The violation, which is concrete rather than theoretical

`DEFAULT_BATCH_BOUNDS.maxRowsPerStatement` is **500**. Its own docstring says it "must stay under the
engine's variable limit (999 on a stock SQLite build)" — true of stock SQLite, and **5x over D1**.

The bound is reached on the PRUNE path and nowhere else. `dropVersionsStatement`
(`statements.ts:269-274`) emits one `?` per row id:

```sql
DELETE FROM "<entity>" WHERE rowid IN (?, ?, ?, ...)
```

and `prune` (`store.ts:323`) fills it with `min(maxRowsPerStatement, budget - deleted)` ids. So a
prune with a budget above 100 issues a query with more than 100 bound parameters, which D1 rejects.
Retention enforcement is therefore broken on D1 under the shipped default, while passing everywhere
else — the shape that runs locally and fails only in production.

**`maxStatementsPerBatch` is 100, which is fine on Workers Paid (1,000) and 2x over on Free (50).**

**The `maxBytesPerBatch` default of ~90 KB is not a D1 violation** but is worth not confusing: D1's
100 KB cap is per STATEMENT, while this bound is per BATCH, so the batch bound being under it is
incidental rather than the thing that satisfies it.

## What this does NOT invalidate

Only ONE other statement's parameter count scales with a list, and it is safe: the row INSERT
(`statements.ts:212`) takes one parameter per COLUMN, and D1 independently caps columns per table at
100. An entity wide enough to breach the parameter limit on insert has already breached the column
limit, so it fails at `migrate()` rather than silently at write time.

## The claim this corrected, and what was done about it

`batching.ts` used to say `DEFAULT_BATCH_BOUNDS` was "deliberately conservative: small enough to fit
inside the tightest hosted limits we are aware of, so that the default never surprises anyone in
production." That was FALSE for D1 on `maxRowsPerStatement`, and D1 is the backend the Worker host
exists to serve.

**ACTED ON 2026-09-01, by maintainer decision: the shipped default now targets the D1 FREE tier, so
an unconfigured deployment works everywhere.** `maxRowsPerStatement` 500 -> **100**,
`maxStatementsPerBatch` 100 -> **50**, `maxBytesPerBatch` unchanged. `maxRowsPerStatement` was a
CORRECTNESS bug rather than a tuning choice, so it is a fix; the other is a deliberate throughput
trade, and both stay configurable via `{bounds}` for a local database or a paid tier.

**The numbers moved into the package; the VENDOR NAME did not, and could not.**
`packages/state-store-sqlite/test/no-platform-leakage.test.ts` asserts that no source file in that
package matches `/\bD1\b/` or `/cloudflare/i` -- "a review criterion that is easy to state and easy
to erode, so it is asserted instead". A first attempt at this change documented the defaults by
naming the vendor and that test caught it immediately, which is the rule working exactly as intended:
the store targets `remote-sql`, so a hosted backend is one backend among several and never the
target. The docstring there therefore describes the CONSTRAINT ("the tightest hosted backend caps
bound parameters per query at 100") and points here for the vendor, the plan split and the dated
source. **This note is the only home for those specifics, which is why it must not be deleted while
those defaults stand.**

What remains undelivered is the other half: a HOST adapter stating its own backend's limits and
passing `{bounds}`, which is `work/tasks/done/d1-limits-reach-the-stores-batch-bounds.md`. A host
is the one place allowed to name its backend, so a Paid-tier deployment raises
`maxStatementsPerBatch` there rather than everyone paying the Free tier's price forever.

**DONE 2026-09-02, by that task: `platforms/cf-worker/src/d1.ts`.** The table above is transcribed
there as `D1_LIMITS`, keyed by PLAN, and `d1BatchBounds(plan)` turns it into the store's
`BatchBounds`; which plan a deployment is on is the `D1_PLAN` var in `wrangler.toml`, so moving
between Free and Paid is a configuration change. Two couplings that only hold while this note and
that file agree, and which the adapter's tests assert rather than trust: `d1BatchBounds('free')`
equals `DEFAULT_BATCH_BOUNDS` exactly (the shipped default is DERIVED from the Free column, so a
moved limit means a moved default), and no statement a prune emits carries more bound parameters
than the cap. The per-INVOCATION budget is a third number the adapter takes from here,
`d1PruneBudget(plan)`, because no batch bound can keep an invocation inside a query cap.

## Why it is a finding rather than an observation

It is verified EXTERNAL ground truth about a third-party platform, and it is LOAD-BEARING: it decides
a default and it is the whole reason the Worker adapter must express its limits as configuration
rather than inherit them. It is also the kind of number that MOVES — it is per-plan and Cloudflare
revises it — so the dated `source:` above is the part that keeps it correctable. Re-fetch before
relying on it.
