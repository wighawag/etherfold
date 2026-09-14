<!-- dorfl-sidecar: item=task:a-successor-that-was-never-canonical-is-superseded type=task slug=a-successor-that-was-never-canonical-is-superseded allAnswered=false -->

## Q1

**'task:a-successor-that-was-never-canonical-is-superseded' was bounced — how should we proceed?**

> FALSE PREMISE, on the one decision the task itself calls "most likely to be got wrong": the predicate's data source.
>
> The Prompt states as fact: "There is already a registry field that records whether the pointer has ever named a generation; find it and use it rather than inferring from the current pointer", and requires "a durable answer rather than an in-memory one". **No such registry field exists.**
>
> Where it is contradicted:
> - `packages/core/src/generation/registry.ts:58` — `GenerationRecord` is `GenerationId & {createdAt}` and nothing more; `GenerationRegistryState` carries only the CURRENT `canonical` pointer.
> - `packages/server/src/generations.ts:131` — the durable SQL row is `{stream, processor, createdAt}`; there is no ever-canonical column.
> - `packages/core/src/generation/memory.ts` and `packages/browser/src/storage/generation/OnIndexedDB.ts` persist the record as-is, so neither substrate adds one.
> - `git log -S"everCanonical"` over `registry.ts` and `generations.ts` is empty: the field never existed.
> - The only ever-canonical fact is IN MEMORY and deliberately so: `packages/core/src/receivingContainer.ts:524-543` ("In memory, so it does not survive a restart -- and the direction that costs is the safe one ... nothing is dropped"), and `packages/core/src/container.ts:253`.
>
> Why this is load-bearing rather than a small gap. ADR-0057 (consequences, line 29) RECORDS the in-memory choice and bounds its cost explicitly: "`everCanonical` is in memory ... so a restart forgets which generations the pointer has named. The cost is bounded to drop-on-promotion, and it falls on the RETAINING side." ADR-0046 gives the same reasoning for the arming it sits beside: "the registry records what a generation IS, and being a candidate is what a container is DOING with one." This task inverts that: a forgotten ever-canonical fact would now fall on the DELETING side. Concretely, the ordinary dev loop across a process restart destroys exactly what story 4 promises: after a promotion, the predecessor is retained on the SAME stream as the new incumbent (a processor change reuses the stream); the host is redeployed holding only the new fold, so nothing in memory records that the predecessor was ever canonical; the next successor registered on that stream would retire the predecessor kept for the revert. That is the silent destruction the task's own safety argument forbids, and it is reachable on the exact scenario the task is for.
>
> So the task cannot be built as written, and the two ways out are a DESIGN decision the task hid rather than a factual gap I may resolve:
>
> (A) Make the never-been-canonical fact DURABLE. That means a new field on `GenerationRecord`, written by `moveCanonicalTo` (and by `create` where it takes the pointer), plus the SQL column and a migration in `@etherfold/server`, plus the IndexedDB and memory substrates, plus the conformance surface, plus an amendment to ADR-0046 and ADR-0057 whose recorded consequence it reverses. It also forces a second undeclared decision: EXISTING rows carry no flag, and defaulting them to "never canonical" makes the first retirement pass eligible to delete precisely the predecessor described above, so legacy rows must default to "assume ever-canonical". None of this appears in the Acceptance criteria, which read as a container-local change, and a persisted schema change across three substrates is hard to reverse.
>
> (B) Keep the fact in memory and NARROW the predicate to what a single process can honestly answer: retire only a fold THIS container added as a successor after `open`, that was not canonical at add, and that the pointer has not named since. A generation this process did not add is never retired. This is safe in the same direction ADR-0057 already accepts, and it still satisfies the dev-loop acceptance criteria (a churn loop registers its successors into one running container). But it directly contradicts the Prompt's "durable answer ... find it and use it", so a reviewer checking the build against the task would bounce it.
>
> Suggested re-scope: pick (A) or (B) explicitly in the task body, and if (A), split the durable field out as a PREREQUISITE task of its own (`GenerationRecord` gains a durable ever-canonical fact; three substrates; legacy rows default to ever-canonical; amends ADR-0046 + ADR-0057), with this task consuming it and listing it in `blockedBy`. Either way, delete the "There is already a registry field ... find it" sentence, which sends the builder looking for something that is not there.
>
> Two secondary notes for whoever re-scopes, neither of them the blocker:
> - The task's third question ("what 'the same role' means when successors are on DIFFERENT streams") is still genuinely open and should be ANSWERED in the task body rather than left to the builder, since it decides whether a source change plus a processor change retires one generation or two.
> - Staging discrepancy, probably harmless: the launch snapshot points at `work/tasks/ready/a-successor-that-was-never-canonical-is-superseded.md` and `work/specs/ready/a-reconfigure-is-not-an-outage.md`, but the item is actually at `work/tasks/backlog/a-successor-that-was-never-canonical-is-superseded.md` and its spec at `work/specs/tasked/a-reconfigure-is-not-an-outage.md`.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
