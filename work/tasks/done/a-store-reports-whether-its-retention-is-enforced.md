---
title: 'A store reports whether its retention is actually enforced'
slug: a-store-reports-whether-its-retention-is-enforced
spec: a-configured-window-is-actually-pruned
blockedBy: [the-browser-indexing-loop-schedules-its-prune, the-cli-schedules-the-prune-its-retention-implies]
covers: [9, 11, 13]
---

## What to build

Close the gap the two scheduling tasks leave: a host that rolled its own loop, has a retention floor, and never prunes. It gets the refusals of a bounded store and the footprint of an unbounded one, and nothing detects it.

The spec launched expecting a REFUSAL at construction. The answer is a REPORT instead, and the reasons are in the prompt below. This is the mechanism ADR-0019 already established, in its own words: a store reports what it PROVIDES, never what it was asked for. Retention has two halves and what a store reports today covers only one.

**Spec stories 2 and 3 are deliberately NOT delivered and are not claimed.** They ask for a construction-time REFUSAL that names a remedy; this ships a report instead. That is a change of answer with reasons, not an oversight, and the ADR below is what records it.

**Do NOT put this on the `capabilities` getter.** That getter is SYNCHRONOUS and is documented as readable before `migrate` and before the database is even opened, which is the point of it. A value durable across a restart lives in storage and cannot be produced by a sync getter before the storage is open, so asserting both would force either an async `capabilities` (breaking every consumer, including the `assertRetained` call sites in both backends) or an in-memory flag that resets on reload and reports never for a store pruned yesterday. Add a separate ASYNC read instead: additive, breaks nothing, does not lie.

## Acceptance criteria

- [ ] An asynchronous read reports this store's enforcement state, distinguishing "no floor, nothing to enforce", "has a floor and has never been pruned", and "has a floor and was pruned to block N".
- [ ] The value is durable across a reload or restart: a store pruned before the process died does not come back reporting never.
- [ ] The synchronous `capabilities` getter is UNCHANGED, so every existing consumer keeps compiling and keeps its pre-open readability.
- [ ] The conformance suite asks every backend the same question, so a new backend inherits the obligation rather than rediscovering the hazard.
- [ ] No default and no configuration shape changes in this task.
- [ ] An ADR records why a report replaced the refusal the spec launched with, so the change of answer survives outside a task body that moves to `done/`. It states plainly that spec stories 2 and 3 were answered differently rather than delivered.
- [ ] The `workerd` constraint the decision rests on (a Worker may not move I/O across requests, so a store cannot own a timer) is recorded as a `work/notes/findings/` note, since it is verified EXTERNAL ground truth that is currently written down nowhere in this repository.
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

`the-browser-indexing-loop-schedules-its-prune` and `the-cli-schedules-the-prune-its-retention-implies`. What "enforced" MEANS is defined by what they do, and a report written first would describe something that had not happened.

## Prompt

Read `work/specs/tasked/a-configured-window-is-actually-pruned.md`, then `packages/state-store/src/capabilities.ts` (note the getter is synchronous, and note why `asOf` is a separate field from `retention`: they FAIL differently, which is the precedent for adding an axis rather than overloading one) and `packages/state-store/src/retention.ts`.

**Why a report and not the refusal the spec asked for.** Three candidates were weighed and two die on hard grounds. A store owning its own SCHEDULER is impossible on a platform this project ships to: `workerd` forbids moving I/O across requests, so a background timer inside a store cannot exist on Cloudflare Workers. An ATTESTATION knob is a promise rather than a proof, and it is NOT parallel to the precedent it would claim: a window requires `finalityDepth` beside it because that value is DATA used to compute the floor, not because it expresses an intention. What survives is what the seam already does.

**The other half of the answer is in the two blocking tasks**: a store with a floor prunes, in every host this project ships. So the broken configuration is unreachable with a shipped host and VISIBLE with a bespoke one.

Domain vocabulary: retention's two halves are `assertRetained`, which bounds what a read may ask about the moment a floor exists, and `prune`, which physically drops what falls below it.

Done means a bespoke host with a floor and no prune is discoverable as broken, and no existing consumer of `capabilities` changed.

## Decisions

- **The new concept is named `retention enforcement`, and the verb is `readRetentionEnforcement`.** Checked against the glossary: `retention` keeps its exact meaning (a distance in BLOCK NUMBERS), `prune` keeps its exact meaning (the call that drops), and "enforce" was already this repo's word for exactly this pair — `capabilities.ts` already said "enforcing it has two halves". It does not overlap `capabilities` (a synchronous CLAIM) or `PruneReport` (what ONE pass did). The verb is `read*` to match `readCursor`, since it is a read and not a getter. Alternative considered and rejected: a field on `capabilities`, which the task's own analysis rules out and ADR-0076 records. Touches: the seam interface, so every `StateStore` implementation including the two test-side decorators.

- **The three kinds are `no-floor` / `never-pruned` / `pruned`, with `no-floor` first-class rather than a degenerate "never pruned".** `unbounded` is the default and probably most deployments; reporting them as "never pruned" would drown the one report that matters. Alternative: a two-arm boolean-ish shape with a nullable floor, rejected because it makes the healthy default indistinguishable from the defect. Touches: anyone who later surfaces this on a status endpoint.

- **A pass is recorded even when it deleted nothing.** The evidence is that a pass RAN at a floor, not that rows went, because a host pruning on a schedule deletes nothing on most cycles. Alternative: record only on `versionsDeleted > 0`, rejected because it makes the healthy case the alarm and makes a quiet chain indistinguishable from a broken host. Cost, accepted and documented: one small cursor-port write per prune call that has a floor (in the same IndexedDB transaction; one extra guarded batch on SQL). Touches: the browser and CLI prune schedules, which now write once per pruning cycle.

- **An unreadable record reads as `never-pruned` rather than throwing** — deliberately the opposite of the snapshot origin beside it, which throws. That marker is a SAFETY floor whose absence has a store claim history it never received; this one is a DIAGNOSTIC, so under-claiming asks a human to look at a healthy store while a throw would take down a store whose data is in no way suspect. This introduces no new error path anywhere. Touches: nothing outside `enforcement.ts`; recorded because "no refusal" was a choice, not an oversight.

- **Nothing SURFACES the report: no `/status` field, no `syncing` field, no host wiring.** The task's criteria ask for a read and a conformance obligation, and `the-browser-indexing-loop-schedules-its-prune` deferred publishing an enforcement state to this task's concept precisely so it would not be forked — publishing it now would mean choosing an audience, a shape and a cadence for two different host surfaces, which is a surface decision with its own scope. `EntityStateView` / `VersionedStateView` (the processor-side read handles) likewise do not expose it. Touches: any future task that wants operators to SEE this; the seam read is what it would build on.

- **`packages/state-store-conformance/README.md` gained a bullet for the pruning chapter as well as the enforcement one.** That chapter existed and was undocumented before this task (a pre-existing gap); documenting it in the same bullet as the new one was cheaper and more coherent than describing half a subject. Touches: docs only.

- **`@etherfold/browser` is listed in the changeset as `patch`.** Its only change is a test decorator implementing the new seam verb, so nothing it ships changed — but the acceptance gate's `changeset status --since=main` fails a changed package with no entry, and that is the exact bounce `the-cli-schedules-the-prune-its-retention-implies` hit. The changeset prose says plainly why it is there. Alternative: leave it out and take the red gate at land time.
