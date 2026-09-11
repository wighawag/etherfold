---
status: superseded in part by ADR-0080
---

# A store REPORTS whether its retention is enforced, rather than refusing a window it cannot enforce

`work/specs/tasked/a-configured-window-is-actually-pruned.md` launched asking for a construction-time REFUSAL: configure a bounded retention without the scheduling to enforce it, and the store refuses where it was configured, naming the remedy (its user stories **2** and **3**). That is not what was built, and the change is deliberate rather than an omission. **Stories 2 and 3 were answered differently rather than delivered**, and this ADR is the record of the answer, because the task body that decided it moves to `work/tasks/done/` and the spec's own amendment is a pointer rather than an argument.

What ships instead is two things. Every host this project ships prunes UNCONDITIONALLY wherever its store has a floor (`the-browser-indexing-loop-schedules-its-prune`, `the-cli-schedules-the-prune-its-retention-implies`), so the broken configuration is unreachable with a shipped host. And a store REPORTS whether its retention is actually being enforced against its storage (`StateStore.readRetentionEnforcement`, `packages/state-store/src/enforcement.ts`), so the same configuration is DISCOVERABLE with a bespoke one.

## Why the refusal cannot be built as written

A refusal at construction has to be a refusal OF something, and there are only three candidates for what a store could demand beside a bounded retention. Two die on hard ground.

**A store owning its own SCHEDULER is impossible on a platform this project already ships to.** The refusal's implied remedy is "and here is the scheduling", which is only a remedy if a store can hold a timer. On Cloudflare Workers it cannot: each invocation is handled independently with its own execution context, and I/O objects created in one request's handler may not be touched from another's (`Cannot perform I/O on behalf of a different request`); work not passed to `ctx.waitUntil()` may be cancelled when the response completes, and `waitUntil` itself extends execution by at most 30 seconds. Periodic work there is a Cron Trigger invoking the Worker, which is the HOST scheduling a call — exactly what ADR-0022 already says. The ground truth is recorded in `work/notes/findings/a-worker-cannot-hold-a-timer-across-requests.md`, since it was written down nowhere in this repository and the decision rests on it.

**An ATTESTATION knob is a promise rather than a proof.** The second candidate is a required option beside the window (`{blocks: N, pruning: 'scheduled'}`) refusing construction without it. It asserts nothing: a host writes the word and still never calls `prune`, and the store is in precisely the state the refusal existed to prevent, now with a configuration file that says otherwise. It is also NOT parallel to the precedent it would claim. `{blocks: N}` requires `finalityDepth` beside it because that number is DATA the floor is computed FROM (`retentionFloor`), not because stating it expresses an intention; ADR-0054 refuses the same shape one layer down, on the ground that a guard which is available and unused passes every test written for it.

**What survives is what the seam already does: report.** ADR-0019 fixed the rule that a store reports what it PROVIDES and never what it was asked for, and ADR-0022 named the exact residue this leaves — a deployment that never prunes gets a store "bounded in what it ANSWERS and unbounded in what it HOLDS". That residue was named and left unobservable. This makes it observable, in the vocabulary the seam already has.

## Why a separate ASYNCHRONOUS read and not a field on `capabilities`

The capability report is a SYNCHRONOUS getter, documented as readable before `migrate` and before the database is even open, which is the whole point of it: a caller learns what a store can do at startup rather than from a wrong answer later. This answer is DURABLE — a store pruned before the process died must not come back reporting never — so it lives in storage, and a value in storage cannot be produced by a synchronous getter before the storage is open.

Asserting both would force one of two bad things: an async `capabilities`, which breaks every consumer including the `assertRetained` call sites in both versioned backends, or an in-memory flag that resets on reload, which is a report that lies about the exact case it exists to catch. So this is an additive read, and the synchronous getter is untouched.

Adding an AXIS rather than overloading one is the precedent already on that report: `asOf` is a separate field from `retention` because the two FAIL differently. So does this — a store with no floor cannot fail this way at all, which is why `no-floor` is a first-class arm of the answer rather than a degenerate "never pruned".

## Where the answer is kept

At the CURSOR PORT, under `RETENTION_ENFORCEMENT_KEY`, exactly as the snapshot origin is (ADR-0028). That port is a keyed slot for an opaque string the store never interprets, is never versioned, never reverted and never pruned (ADR-0027), which is precisely the durability this needs — and it means one more KEY rather than a new port, a new table on four backends, or a migration.

The record is the FLOOR the last pass ran at, `PruneReport.floor`, which is `retentionFloor`, which is `retainedRange(...).from`: the same one boundary a read is refused at and a row is deleted at, so the number reported and the number deleted against cannot drift. It is written whether or not the pass deleted anything, because a host pruning on a schedule deletes nothing on most cycles and treating "deleted something" as the evidence would make the healthy case the alarm.

## Consequences

- **The report distinguishes three states, and the first is not a failure**: `no-floor` (`unbounded`, or `revert-only` with no declared finality depth — nothing to enforce), `never-pruned` (a floor, and no pass has ever run), `pruned` (a floor, and a pass ran at block N). `floor` and `prunedTo` are reported apart, because the distance between them is the diagnostic: a store pruned once a year ago reports `pruned`, and only the gap says so.
- **Whether a store has a floor is a fact about the SETTING and not about how far it has got.** A configured store that has applied no block yet reports `never-pruned` with no floor number, rather than `no-floor`: it is the store a bespoke host is most likely to be misconfiguring, and hiding it would defeat the read.
- **`revert-only` WITH a declared depth has a floor** and is reported like any other floored store. That is the case a host checking for a WINDOW gets wrong, and it is the ordinary configuration of `@etherfold/state-store-patch`.
- **A record this build cannot read is treated as `never-pruned` rather than refused**, deliberately unlike the snapshot origin, which throws. That marker is a SAFETY floor whose absence has a store claim history it never received; this one is a DIAGNOSTIC, and under-claiming enforcement asks a human to look at a store that is fine, while a throw would take down a store whose data is in no way suspect.
- **The conformance suite asks every backend**, cross-checking the report against the floor `prune` itself returned, so a new backend inherits the obligation rather than rediscovering the hazard. The suite cannot hold a fixed expectation, because only the store knows whether it has a floor at all.
- **No default and no configuration shape changed.** `unbounded` is exactly where it was, and this adds nothing a deployment must write.
- **This is a report and not a gate.** Nothing refuses, nothing warns and no host surfaces it yet; wiring it into a status surface is a decision with its own audience and is deliberately left to whoever has one.
