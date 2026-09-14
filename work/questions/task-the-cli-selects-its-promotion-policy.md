<!-- dorfl-sidecar: item=task:the-cli-selects-its-promotion-policy type=task slug=the-cli-selects-its-promotion-policy allAnswered=false -->

## Q1

**'task:the-cli-selects-its-promotion-policy' was bounced — how should we proceed?**

> FALSE PREMISE, on the task's central claim: the promotion policy is not merely "unreachable" from the CLI, it is INERT on the CLI's shape. Exposing it as written would ship an accepted-and-ignored flag, which is the one thing `packages/cli/src/config.ts` and ADR-0048 forbid by name.
>
> WHAT THE TASK ASSERTS (What to build, para. 2): "every CLI deployment silently takes `on-catch-up` and an operator who wants either of the others cannot ask." The first clause is true of the CONFIG VALUE. The behavioural implication -- that asking for another value would change when the pointer moves -- is false today.
>
> WHY, in the code:
>
> 1. The promotion policy speaks ONLY for a fold ADDED to a container that is already open. `ReceivingIndexer.applyPolicyTo` returns at once while `opened` is false (`packages/core/src/receivingContainer.ts:1157`), and `open()` adds the configured generation BEFORE setting `opened = true` (`:596-609`). The gate is deliberate and its reasoning is recorded at `:500-511`: "Applying the policy at open would let `immediate` promote whatever the host happened to be built with, and `on-catch-up` undo a revert recorded in a previous session. A fold added AFTERWARDS is a successor, and that is the only thing the policy has an opinion about."
>
> 2. The CLI only ever produces OPENING folds. Nothing under `packages/cli/src` calls `container.add`; the only occurrence of the phrase is prose in `run.ts:96`. A reconfigure reaches a `run` by RESTARTING it, which `work/notes/observations/a-reconfigure-cannot-reach-a-running-run.md` establishes ("no file watching anywhere in the CLI", "no HTTP surface for it", "SIGINT and SIGTERM only") and which commit 7f0990a2 ("docs(cli): a reconfigure does not reach a running process, so stop saying it does") already corrected the docs for. So on the CLI, a successor is never armed as a candidate, `settlePromotion` returns at `:1192` with an empty candidate set, and the pointer never moves on its own under ANY of the three values.
>
> 3. MEASURED, not inferred. A throwaway core test (over `test/utils/receivingWorld.ts`, since deleted; working tree left clean) opened a second container over the same registry substrate with a changed processor -- the restart shape -- and drove it:
>    - `on-catch-up`: `{follows: false, writesStream: false, followers: 0, rebuildMore() -> [], canonical: 'v1'}`
>    - `immediate`:   `{canonical after open: 'v1', canonical after rebuild: 'v1'}`
>    Both policies, identical outcome: the incumbent stays canonical for ever.
>
> 4. A second, independent surprise falls out of the same measurement and is worth recording where it will be seen: on a restart the successor is NOT a follower. `follows` is computed from the folds THIS CONTAINER holds (`receivingContainer.ts:969`), not from the generations the REGISTRY holds, so a restarted process holding one fold gets a WIRE RECEIVER and re-fetches the history from the node from its own empty cursor, instead of re-folding the stored stream as ADR-0044 describes. That is the same mechanism that makes `rebuildMore()` a no-op above, and it means the CLI restart path does not currently get the cheap catch-up the design promises. I did not investigate further; it is outside this task either way.
>
> WHICH ACCEPTANCE CRITERIA THIS BREAKS:
> - #1 ("A CLI deployment can run with each of the three policies ... and the selected policy is what the container actually applies") is unsatisfiable in the sense an operator can observe: all three values yield identical behaviour.
> - The Prompt's named test seam ("a deployment stood up under each policy asserting on when the pointer actually moves") cannot be written honestly. It could only be made to pass by having the TEST call `container.add(...)` itself -- an affordance no operator has -- which would assert the core container's contract (already covered by `packages/core/test/promotion.test.ts` and `rebuild.test.ts`) while claiming to assert a CLI capability.
> - The remaining criteria (#2 default unchanged, #3 flag-beats-env + refusal, #4 the `immediate`+drop refusal, #5 visible in `/status`, #6 one name, #8 changeset) are all buildable. They are just not worth a user-visible flag whose only honest help text would be "this has no effect on this command yet".
>
> WHY THIS IS LOAD-BEARING RATHER THAN A SMALL GAP. `packages/cli/src/config.ts`'s header states the rule as non-negotiable -- "Nothing is accepted and ignored. An accepted-and-ignored flag is a deployment believing something untrue" -- and ADR-0048 devotes a section to it (a flag a command does not own is REFUSED rather than dropped). This task would add, to that exact module, the first flag that is accepted and does nothing. It also contradicts a recorded core decision (the `opened` gate above), so "make it work" is an ADR-level change and not a CLI plumbing detail.
>
> NOTE ALSO: two other work items assert the same false behaviour in prose and will mislead the next reader -- `work/notes/observations/a-reconfigure-cannot-reach-a-running-run.md` ("Auto-promotion is real, and it is the DEFAULT ... then the pointer moves on its own", said of the restart path) and `work/tasks/backlog/an-endpoint-triggers-a-reconfigure-in-a-running-process.md` ("The pointer moves on its own when the successor catches up, because `on-catch-up` is the default everywhere"). Both are true of a container that is handed a successor via `add`, and false of every CLI deployment. Worth correcting wherever this is re-scoped.
>
> SUGGESTED RE-SCOPE, either of:
>
> (A) SEQUENCE IT. Make this task blockedBy `an-endpoint-triggers-a-reconfigure-in-a-running-process`, which is what introduces a successor into a RUNNING container and therefore what makes the policy observable. Then criterion #1 and the Prompt's test seam become honest as written, and this task shrinks to exactly what it describes: one input, one resolver entry, one plumb, one refusal. (That endpoint task is itself blocked by `a-successor-that-was-never-canonical-is-superseded`, which went stuck in cce161c2, so the chain needs unblocking at the bottom first.)
>
> (B) RE-AIM IT AT THE RESTART PATH, as a DESIGN task rather than a configuration one. The question it would have to answer, and which this task hides: should the fold a CLI container OPENS with be governed by the promotion policy when the registry shows it is a successor? That reverses the recorded reasoning at `receivingContainer.ts:500-511` and so needs an ADR amendment, not a flag; it also has to settle the `follows` question in (4), since "promote when it has caught up" is meaningless while the restart successor catches up by re-fetching the chain rather than by a rebuild. This is strictly larger than the task's own "Out of scope" fence, which explicitly reserves ADR amendments.
>
> A third option I considered and rejected: build the input now and document that it only takes effect once something adds a successor. That is the accepted-and-ignored flag under a different name, and ADR-0048's own asymmetry argues against it -- adding an input later is free, removing a published one is breaking.
>
> MINOR, not the blocker: the launch prompt says the item is at `work/tasks/ready/the-cli-selects-its-promotion-policy.md` and its spec at `work/specs/ready/a-reconfigure-is-not-an-outage.md`. They are actually at `work/tasks/backlog/` and `work/specs/tasked/` respectively (there is no `ready/` spec folder). I read them from their real locations.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
