---
title: 'A generation this tab holds no fold for is COLLECTED when a registration needs room'
slug: a-generation-this-tab-holds-no-fold-for-is-collected-when-room-is-needed
blockedBy: []
covers: []
---

## What to build

ADR-0090, point 3 only. Read it first; it carries the argument and this task does not repeat it.

**The rule.** On the CHAIN-FACING container, a generation that this container holds NO fold for, that no slot names, and that is not canonical, becomes collectable when an arriving registration needs room. It is collected at that moment and at no other: nothing fires on a timer, nothing sweeps at `open`. On the RECEIVING container nothing changes at all, and the operator's `reclaim` verb stays exactly where ADR-0084 put it.

**The shape of the case.** A tab promotes, the page reloads, and the new bundle carries one processor. The superseded generation is now a row nothing can run: its code is absent from the build, so it can never answer a read and can never fetch. Today it survives for ever and the next save is REFUSED with `GenerationCapReachedError`. After this task it is collected and the save lands.

**There are TWO blockers and they must BOTH be cleared. Clearing either one alone changes nothing, and this is the trap this task exists to walk you past.**

1. **The record is never a displacement candidate.** `displacedBySuccessor` (shared, in the core registry module) filters it out through the injected "do I hold a fold for this" predicate before any drop rule is consulted. This is the primary blocker and it is the one that is easy to miss, because the code that LOOKS responsible is the strand rule below.
2. **The strand rule would then decline it anyway.** `wouldStrandAFollower` derives the fetcher from the REGISTERED set, where the dead row is the oldest and so still reads as the stream's fetcher, even though the live fold derived its own `follows` from the HELD set (ADR-0088) and correctly considers itself the fetcher. Two sites, two answers, one of them about a generation no fold exists for. Narrow this site to the held set, which is ADR-0088's own rule ("the oldest one PRESENT, not the oldest one REGISTERED") applied to the second call site its follow-on task never touched.

**Where the runtime distinction lives is yours to decide, and one constraint is absolute:** the RECEIVING container's behaviour must not change. The predicate is already injected per container, which is a reasonable place to look, but the shape is your call: widening the shared clause in a way that also collects on the receiving runtime would remove an operator's `reclaim` from under them. Record what you chose in `## Decisions`.

**Check the premises before you build.** Both blockers above were read off the source on 2026-09-22 and are stated as fact; confirm they are still true. In particular confirm that narrowing the strand rule to the held set leaves the IN-SESSION case unchanged (where the superseded generation IS held and IS the fetcher, so the decline must still fire). If it does not, say so rather than proceeding.

## Acceptance criteria

- [ ] A tab that promotes, RELOADS, and then registers a new generation collects the superseded one: its registry row and its state namespace are gone, and the registration that previously failed with `GenerationCapReachedError` now succeeds. Asserted through the browser package's own container tests, which already stand a container up over a durable registry and a fake chain and reload it.
- [ ] The STREAM is KEPT. ADR-0087's removal of the automatic reap is untouched, and no drop here reaps one.
- [ ] Collection happens ONLY on a registration that needs room. No timer, no sweep at `open`, no new background deleter. A tab that promotes, reloads and then sits idle collects nothing.
- [ ] The IN-SESSION case is UNCHANGED: a same-stream promotion still retains the superseded generation, because it is held and it is the stream's fetcher. This task must not partially implement ADR-0090's points 1 and 2, and a test should pin that it has not.
- [ ] The RECEIVING container is unchanged and proven so: its displacement behaviour and its `reclaim` verb behave exactly as they do today. This is the criterion that catches a fix applied to the shared rule with no runtime distinction.
- [ ] The strand rule's fetcher question is answered from the set the container HOLDS, and a generation no fold exists for no longer reads as a stream's fetcher for the purpose of declining a drop.
- [ ] ADR-0088 records that its PRESENT-not-REGISTERED rule governs BOTH sites that ask who fetches a stream, not only the `follows` derivation its own follow-on task changed. Use the dated amendment form this repo already uses; its decision and its measurement stand and are not rewritten.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

**ADR-0090's `status: accepted, not yet implemented` line STAYS after this task.** You are implementing point 3 of four, and the sibling task `a-browser-promotion-drops-what-it-superseded-and-takes-the-stream` owns removing that line when it lands points 1 and 2. This is stated explicitly because ADR-FORMAT.md records that a status line survives a chain precisely when every task can see it is not the last one. You are not the last one; do not remove it, and do not invent a value.

## Blocked by

None -- can start immediately.

## Prompt

The goal is that a browser tab stops carrying a generation it can never run, so the developer's save loop stops hitting a wall that a page reload cannot clear.

Read `docs/adr/0090-a-browser-promotion-finishes-the-job-the-superseded-generation-goes-and-the-stream-changes-hands.md` in full, and build ONLY its point 3. Then read ADR-0088 for the PRESENT-not-REGISTERED rule you are extending to its second call site, ADR-0084 for what the three slots mean and for why the `reclaim` verb belongs to the receiving container alone, and ADR-0087 for why losing a generation is cheap (the stream outlives every fold over it, so a re-fold is a local scan rather than a re-fetch a public node may refuse).

The observation `an-unslotted-generation-on-the-chain-facing-container-is-collected-by-nothing` carries the measurement this task is built on, including a dated appended section that states the two blockers in the order you will meet them. Read that appended section before you start: an earlier attempt at this reasoning proposed fixing only the strand rule, which would have changed nothing, because the record never reaches it.

The decision most likely to be got wrong is applying the widening to the SHARED displacement rule without a runtime distinction, which would silently delete generations the receiving container's operator expects to reclaim by hand. There is an acceptance criterion aimed squarely at it; treat it as the main risk rather than a formality.

The second is scope. This task collects a generation NO FOLD EXISTS FOR. It does not change `dropOnPromotion`, it does not drop anything at promotion time, it does not move the fetch duty, and it does not touch the caps. Those are ADR-0090's points 1 and 2 and they belong to the sibling task that is blocked on this one.

The seam to test at is the browser package's container tests, which already reload a container over a durable registry and a fake chain, plus the core package's registry and container tests for the shared rule and the strand rule.

Done means: a reloaded tab collects what it cannot run, on a save and only on a save; the in-session case is provably untouched; the receiving runtime is provably untouched; and ADR-0088's rule is recorded as governing both of its sites.

FIRST, check this task against current reality. It was written on 2026-09-22 against code that had landed hours earlier, and both blockers are stated as fact from a source read. Builders in this repo have contradicted their task text repeatedly and have been right to every time; one stopped a task outright because its central premise was false. Verify before you build, and say so if you disagree.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in particular where you put the runtime distinction and why it cannot affect the receiving container. Do not write the done record, the commit message or the PR body yourself.

## Decisions

**Where the runtime distinction lives: an explicit, caller-stated field on the shared rule (`DisplacementRuntime.unheldIsCollectable`), not a widened predicate and not a forked rule.** I rejected passing `heldHere: () => true` from the chain-facing container: it would have re-meant a predicate whose name and JSDoc say "do I hold a fold for this", making the shared rule's own documentation false at one call site. I rejected a second exported function for the chain-facing side because ADR-0071 gives the rule one home and the file itself says two copies of the safety clause is how a revert target gets deleted by the twin nobody was reading. I also rejected an *optional* flag defaulting to `false`: the default is precisely the thing that would be wrong, so both containers now state their answer and the compiler requires it. **Why it cannot affect the receiving container:** `ReceivingIndexer` is a separate class with its own `replaceTheSuccessor`, it passes `unheldIsCollectable: false`, and the only widening clause is `runtime.unheldIsCollectable || runtime.heldHere(record)`, reached only for records no slot names. Proven by `receivingContainer.test.ts` (registration leaves it alone, `reclaim` takes it) and by the pre-existing CLI reclaim test, which would go red if the flag leaked. Touches: `displacedBySuccessor`'s signature (published from `@etherfold/core`, hence the changeset), and both containers' call sites.

**The distinction is placed at the CHAIN-FACING CONTAINER, not at the browser package.** ADR-0090 states point 3 for the chain-facing runtime and exempts only the receiving one, and the argument generalises: no chain-facing container has a `reclaim` verb, so an unslotted row no fold exists for is collected by nothing there either. A browser-only flag would have meant a new user-visible config key for a fact about the runtime. Touches any chain-facing embedder (today: `@etherfold/browser` plus test harnesses in core/cli/server, all green).

**`wouldStrandAFollower` was narrowed rather than given a special case for unheld records.** The alternative (keep the registered set and add "unless nothing here holds a fold for it") would have left two sites answering "who fetches this stream" differently by construction. Narrowing makes it ADR-0088's own rule at its second site, which is why I recorded it as an amendment there rather than as a new rule. Touches: the same-stream in-session decline (deliberately unchanged, pinned by two tests) and the cross-stream drop (unchanged).

**A registration during `open` can also collect, and I did not special-case `open`.** Acceptance criterion 3 asks for no timer and no sweep at `open`; a container that *registers a generation no slot names* while an unrunnable row exists will collect it there, because that is a registration, not a sweep. The reload shape a tab actually has cannot hit it (the fold it arrives with is `canonical`, so the shared rule displaces nothing, asserted twice). Special-casing `open` would have made the lifecycle depend on how a fold arrived, which ADR-0084 explicitly moved away from.

**One consequence worth naming, not a new hazard:** a second tab over the same registry can now collect a row a first tab holds a fold for. That class already exists (a second container already drops the `successor` occupant the first one holds, asserted in the reload test), and `CONTEXT.md` records the single-indexer lease as its answer, so I did not widen scope to address it.
