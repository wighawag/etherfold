---
title: 'The fold publishes what it just changed'
slug: the-fold-publishes-what-it-just-changed
spec: a-reader-learns-when-the-state-moved
blockedBy: []
covers: [1, 3, 5, 13]
---

## What to build

The signal that says the state moved, produced by the side that moved it.

A fold that applies a block knows four things nothing downstream can recover cheaply: which block it just applied, whether anything a reader holds may now be wrong for a reason other than that block, which entities the block touched, and which generation answered. Publish those four and nothing else:

```ts
type StateMoved = {
	block: number;
	/** Opaque. COMPARE it, never parse it. Changes when cached data may be stale. */
	coherence: string;
	/** Entity NAMES this block touched. Bounded by the declaration, not by block size. */
	entities: readonly string[];
	/** WHICH generation answered, so a refetch is not served by another lineage. */
	generation: string;
};
```

The rule a reader follows is two lines, and the payload exists to make those two lines possible: token unchanged, invalidate narrowly using `entities`; token changed, invalidate everything. `generation` is not part of that rule and must not be folded into the token: the token says WHETHER what a reader holds may be stale and is never parsed, so it can name nothing, while `generation` is a fact a reader renders and compares.

**The entity set comes from a layer below core, and core RELAYS it.** This is the seam question this task has to get right, so it is stated rather than left to be discovered: `@etherfold/core` owns the block, the generations and the token, and it CANNOT see entity names — `EventProcessor.process` returns an opaque `ProcessResultType` and the word *mutation* does not appear anywhere in the package. The `Mutation` objects carrying an entity name are collected one package down, in `@etherfold/processor-entities`, on the path that runs a block's handlers and calls `applyBlock`. So the touched-entity set is produced THERE and reaches core through a narrow additive channel, and core assembles the signal from it plus what only core holds. Do NOT widen `EventProcessor.process` to carry it: that reaches core, processor-entities, processor-sqlite, the CLI and the browser to move information that already exists at the lower layer. ADR-0083 records the reasoning and the ADR-0078 precedent it follows.

A processor that is not entity-declared reports an empty set. That is the honest answer, and narrow invalidation degrades to whatever the token says, which is correct if coarse.

**Define the app-facing handler shape here**, in this task, so the three transports that follow each ADAPT to one shape instead of inventing three attach conventions that a later task has to reconcile. It is a plain callback: every client library's invalidation API is one (`invalidateQueries`, `refetchQueries`, `reexecuteOperation`), so nothing more elaborate is needed and anything more elaborate will not fit them.

Entity NAMES and never ids, in this version. The names are bounded by the declaration, so the payload is O(schema) rather than O(mutations), which is what stops the worst block on the real measured stream (457 mutations against a median of 7) from producing a 457-element message. Ids can be added later as an optional field without breaking a reader; they could not be removed. There is also a trap in shipping ids early, which is that they invite a reader to apply the delta by hand instead of re-reading, and applying a delta by hand is exactly what goes wrong under reorg.

The producer holds NO per-client state. Nothing is buffered, nothing is retried, nothing is remembered about who is listening. That is what stops a SharedWorker's memory growing with the number of open tabs, and it is the property every transport task downstream depends on, so it belongs here rather than in each of them.

**Only the CANONICAL fold publishes.** A non-canonical generation re-folds a whole stored stream to catch up, so a per-block publication there would fire thousands of notifications naming past blocks while nothing a reader can see has moved. The container already has the filter this needs, applied to its existing per-generation callbacks; use it rather than inventing a second rule. So "one notification per applied block" means per block applied by the fold that answers reads.

This task delivers the signal on the CHAIN-FACING container, plus one in-process subscriber proving it. The receiving container (which every server and CLI deployment folds through) is the next task, and it must reuse this assembly rather than mirror it, so build this so that extending it is factoring rather than copying. The port, the cross-tab channel and the server endpoint are transports that adapt it.

## Acceptance criteria

- [ ] Applying a block publishes one `StateMoved` naming that block, the generation that answered, and the entity names that block touched and no others.
- [ ] The touched-entity set is produced where the mutations are collected and relayed up; `EventProcessor.process` is NOT widened, and no signature reaching processor-sqlite, the CLI or the browser changes.
- [ ] Only the canonical fold publishes: a non-canonical generation re-folding a stored stream to catch up emits nothing, asserted rather than assumed.
- [ ] The relay survives the SQL processor path: the versioned-state processor wraps an inner entity processor built lazily, so forwarding the channel through that wrapper is IN SCOPE here. Without it a SQL deployment silently reports an empty entity set on every block.
- [ ] The relay survives a reconfigure: the container swaps a generation's processor in place, so a channel attached once at construction must not go quiet afterwards.
- [ ] A processor with no entity declarations publishes an empty entity set rather than failing or fabricating one.
- [ ] The app-facing handler shape is defined here as a plain callback and is what the transport tasks will adapt to.
- [ ] A block that touches nothing publishes nothing, or publishes an empty entity set, and whichever is chosen is the documented rule rather than an accident of where the call sits.
- [ ] The entity set is derived from the mutations actually applied, so an entity declared but untouched is absent.
- [ ] The coherence token is stable across ordinary appends: folding N blocks canonically with no reorg and no promotion publishes N notifications carrying one unchanged token.
- [ ] The token is opaque at the seam: its type says string, nothing downstream parses it, and a test asserts only comparison.
- [ ] Subscribing and unsubscribing are symmetric, and the producer's bookkeeping does not grow with the number of subscribers (assert by attaching many and observing what the producer holds).
- [ ] A subscriber that throws does not break the fold, matching how `onStateUpdated` already contains a throwing listener.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

None — can start immediately.

## Prompt

The goal is that the side which applied a block can tell the sides that are reading, in one shape that every later transport carries unchanged.

Read `work/specs/tasked/a-reader-learns-when-the-state-moved.md` and **ADR-0083**, which records the decided shape and the reasoning you must not quietly reverse: entities not ids in v1, best-effort delivery with no per-client state, and a coherence token that is compared and never parsed. Read `CONTEXT.md` for the vocabulary, and note one terminology rule it states explicitly: **consumer** is reserved for a reader of the FEED, so a browser app or a reader tab is a *caller*, an *app* or a *reader*, never a consumer. Getting that wrong in a type name is expensive to undo.

Where to look: `@etherfold/core`'s `indexer.ts` and `container.ts` already carry the publication vocabulary this joins — `onStateUpdated` (fired when a state is adopted or produced), `onLastSyncUpdated`, and `publishDiscard`, which exists precisely because `onStateUpdated` never covered a fold that was thrown away. Read how those are declared and contained (a throwing listener is caught and logged, not propagated) and follow that convention rather than inventing a second one. The entity names come from the mutations the fold applies; `@etherfold/state-store`'s mutation and declaration vocabulary is where the names live.

The decision most likely to be got wrong: this is a SIGNAL, not a delivery of data. It says what moved so a reader can re-read through the surface it already has. Do not attach rows, do not attach the mutations, do not attach the state handle. A reader that is handed the delta will apply it by hand and be wrong at the next reorg.

The second one: the token is published, not derived by a reader. Two later tasks rotate it (a retraction and a promotion), so what you build must make rotation a one-line change at the point where the reason occurs, not a recomputation a reader could attempt.

The seam to test at is the container/indexer publication boundary with an in-process subscriber, driving a real fold over the existing conformance workload rather than a hand-built fake, so that the entity names asserted are the ones a real processor produces.

Done means: a fold over a real workload publishes one notification per applied block, naming that block, its generation and the entities it touched, carrying a token that does not move while nothing invalidates, and the producer remembers nothing about who is listening.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The SHAPE of the channel that carries the entity set up from processor-entities is the most important one — it is a new cross-package seam and the next three tasks build on it. What an empty block publishes, and where exactly in the apply path the publication fires relative to `onStateUpdated`, are also such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**1. The shape of the cross-package channel: one optional method on `EventProcessor`, carrying `AppliedBlock` per block.** `setAppliedBlockReporter(reporter | undefined)` is a single owner-set slot on the processor, and `AppliedBlock` is `{block, entities}` — per BLOCK, not per batch, because one notification per applied block is the contract and only the layer below knows which blocks it applied. Alternatives considered: widening `process` (ruled out by the task and ADR-0083); a separate structurally-detected interface plus a type guard (more machinery, no extra safety, and it hides the channel from the seam it belongs to); a settable callback FIELD rather than a method (a wrapper would have needed a getter/setter pair anyway, and a method makes the forwarding obligation legible). Precedent for the optional-method form is `ExistingStream.setStreamConfig?`. It touches `@etherfold/core` (seam + relay), `@etherfold/processor-entities` (producer), `@etherfold/processor-sqlite` (forwarding), and every downstream task that consumes the signal: `the-receiving-container-publishes-what-it-applied` reuses `StateMovedPublisher` and this same channel, and the three transport tasks adapt `StateMoved`/`StateMovedHandler`. Its known cost, stated at the seam: being optional, a wrapper that forgets to forward it fails silently — which is why the SQL wrapper's forwarding has a test whose only job is that.

**2. A processor that implements no channel publishes NOTHING; a processor with no entity DECLARATIONS publishes an EMPTY set.** ADR-0083's "an empty set is the honest answer there" is implemented as the second of those: an entity fold declaring no entities reports `entities: []` per applied block. The first case (a custom `EventProcessor` outside the entity path) gets silence, because core cannot know which blocks such a fold applied and inventing them from the delivered stream would be exactly the fabrication the ADR rejects — and it would put a second publication site in core, which is how two producers drift. Alternative considered: a core-side fallback publishing one empty-set notification per delivered block for non-reporting processors. Rejected for those two reasons; the entity path is the only authoring path (ADR-0037), so the reachable case is covered. It touches any third party writing a bespoke `EventProcessor`.

**3. A block that touched nothing PUBLISHES, with an empty entity set.** The rule is "one notification per APPLIED block", not "per block that changed something": the block was recorded and the cursor moved with it, and a reader's two-line rule stays one rule. A batch that applied NO block (a scanned range with no logs) publishes nothing — there is no block to name. Documented on `StateMoved.entities`, on `AppliedBlock`, and as rule 5 of `applyEventStream`.

**4. The publication fires AS THE BLOCK LANDS — inside `process()`, per block — therefore BEFORE the batch's `onStateUpdated`.** The block is durable when it is reported (block + cursor are one atomic unit behind the storage seam, ADR-0027), so a reader that re-reads the instant it is told sees that block's effects. The alternative — holding reports until the batch's state notification — would BUFFER, which is the one thing the producer must not do, and would collapse a batch's blocks into a single moment for no reader's benefit. Consequence to know: a `process` that throws mid-batch has already published the blocks that landed, which is true rather than optimistic.

**5. The relay is attached BEFORE `updateProcessor` delegates, so the rebuild inside the verb publishes.** A swap is followed by a `load` that replays the cached stream through the new fold; a relay attached afterwards would go quiet for exactly those blocks. Attaching to a processor whose swap is then declined is harmless (it folds nothing) and it is detached on that branch. Consequence: a reconfigure that rebuilds over a cached stream publishes one notification per replayed block. That is the canonical fold genuinely re-applying them, and with no rotation on a discard yet, narrow invalidation per block is the correct advice for a reader. Touches `the-promotion-policy`-adjacent work and the retraction/promotion rotation tasks, which may want to rotate on a discard too.

**6. `Indexer.onStateMoved(handler): () => void` — an `on*` name that SUBSCRIBES rather than an assignable callback slot.** The container's other `on*` members are single assignable fields, so this is the same prefix with a different shape; I chose it anyway because the acceptance criteria require many subscribers and symmetric detach, and because `@etherfold/browser`'s `IndexerPort.onHostDeath(listener): () => void` already establishes exactly this form in the repo. The alternative (`subscribeToStateMoved`) was rejected as a second convention for one idea. Touches all three transport tasks, which will adapt this name.

**7. The token is a per-producer random value, not a counter, and rotation is `StateMovedPublisher.rotate(reason)`.** A counter repeats across a restart, which is the one case where an unchanged token would be a lie (a rebuilt fold telling a reconnecting reader nothing is stale). Same construction as `@etherfold/state-store`'s writer token, deliberately duplicated rather than shared because core cannot depend on the storage seam (ADR-0016). `reason` is logged and never published — the token names nothing. `rotate` is protected on the container, so the retraction and promotion tasks each add one line at the point their reason occurs; there is deliberately no public getter for the current token yet, since no shipped caller needs one and a transport can carry the token it last relayed.

**8. `entities` is deduplicated and SORTED.** It is a set rendered as an array; sorting makes two runs of one block produce one payload and lets a transport or a test compare them as values. Touches every consumer that compares payloads.
