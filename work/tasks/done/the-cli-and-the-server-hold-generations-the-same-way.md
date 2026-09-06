---
title: 'The CLI holds generations the way the server does, and `build` holds exactly ONE'
slug: the-cli-and-the-server-hold-generations-the-same-way
spec: the-server-and-cli-hold-generations-too
blockedBy: [the-rebuild-replays-the-local-stream-in-bounded-chunks, two-named-indexers-never-touch-each-others-data]
covers: [6]
---

## What to build

The CLI IS the server, and this task makes that true of generations too: what a developer tests
locally is what deploys. `run` follows, folds and answers HTTP in one process, so "the server holds
generations" and "the CLI holds generations" are ONE statement. What differs between the commands is
EXECUTION, not the model.

- **`run`** may ADD a generation and PROMOTE one, because it is a long-running host and a reconfigure
  can reach it.
- **`build`** holds exactly **ONE** generation: a one-shot has no reconfigure, so it creates one and
  exits — it never adds a second and never promotes. That is the same model instantiated at N=1, NOT a
  second model, and the distinction is load-bearing: a `build`-produced database is a publishable
  ARTIFACT that is later fed into another process, and it must be INDISTINGUISHABLE from a
  `run`-produced one. A `build` holding a different SHAPE would make the artifact distinguishable on
  exactly the axis it must not be. Holding one costs a pointer read at startup.
- **`index`** is the receiving half and folds under the same container as `run`.
- **`serve`** holds no processor and folds nothing: it resolves the canonical pointer to know WHICH
  generation's state answers, and registers nothing.

The claim is asserted at the COMMANDS, through ONE fixture, in the style the command set already uses:
`packages/cli/test/equivalence.test.ts` drives `run` and `build` over the same processor, the same
declarations and one fixture chain including a reorg, and asserts identical state and an identical
cursor. Extend that discipline to the generation shape — same generation record, same canonical
pointer, same table namespace, same stored stream — rather than writing a second, parallel assertion.

## Acceptance criteria

- [ ] `build` creates exactly one generation, never adds a second and never promotes; a `build` run
      twice over the same inputs resolves the SAME generation rather than creating another.
- [ ] A `build`-produced database is indistinguishable from a `run`-produced one on the generation
      axis, asserted through one fixture: same registered generation, same canonical pointer, same
      state namespace, same stored stream, same reorg counters.
- [ ] `run` can add a successor and promote it in-process, and `index` folds through the same container
      as `run` does.
- [ ] `serve` answers over a database written elsewhere by resolving the canonical pointer, holding no
      processor and registering nothing; it still refuses `--indexer`.
- [ ] The indexer name still defaults on `run` and `build` (which route nothing) and is still required
      on `fetch` and `index`.
- [ ] No sixth command and no new default command: a bare `etherfold` still prints help.
- [ ] Tests cover the new behaviour, in the repo's existing style.

## Blocked by

- `the-rebuild-replays-the-local-stream-in-bounded-chunks` — `run`'s add-and-promote path is only real
  once a successor can catch up and the pointer can move.
- `two-named-indexers-never-touch-each-others-data` — both tasks rework the CLI's folding assembly
  (`packages/cli/src/folding.ts`) and the shape a name resolves to, and both carry a changeset for it.
  Serialising them is cheaper than resolving that conflict afterwards, and this task is the capstone
  that should see the per-name database already in place: `run` and `build` default the name, so
  "indistinguishable on the generation axis" must hold over the handle that name owns.

## Prompt

> Make the five CLI commands hold generations exactly as the server does, and prove it by driving both
> through one fixture.
>
> Vocabulary (`CONTEXT.md`, "The COMMAND SET names deployment intents, not components"): **`run`**
> follows, folds and answers on one handle; **`build`** does the same but EXITS at the tip, producing a
> database or a publishable artifact; **`fetch`** is the chain-facing half; **`index`** is the folding
> half that receives pushes and owns the database; **`serve`** is the read tier that holds no processor.
> Two compositions hold in the CODE rather than in prose: `run` is `fetch` plus `index` plus `serve` in
> one process, and `build` is `run` without the serving.
>
> Where to look: `packages/cli/src/run.ts`, `indexCommand.ts`, `serve.ts`, `folding.ts` (the folding
> assembly every command that owns a database shares — one store, one processor, one handle, and the two
> ports that write what a fold concluded), `packages/cli/src/config.ts` (which command may default the
> indexer name), and `packages/cli/test/equivalence.test.ts` (the existing one-fixture assertion to
> extend).
>
> Constraining decisions: ADR-0052 (why `--indexer` may default on the combined shapes and may not on
> the wire; and that a `build` artifact carries its stream), ADR-0050 (a `build`-produced database
> carries the same facts as a `run`-produced one), ADR-0053 (the state namespace a `serve` must resolve
> the pointer to find), ADR-0048 (a command inputs a name and whether it may default), plus
> `work/specs/tasked/one-command-runs-the-whole-pipeline.md` for the command set itself.
>
> Seams to test at: the commands, over one fixture chain that includes a reorg. Done means a developer's
> local `run` and a deployed server differ in execution and in nothing else, and a `build` artifact is
> indistinguishable from a `run` database.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): if a
> dependency landed differently or an ADR superseded an assumption here, route the task to
> needs-attention with the discrepancy rather than building on the stale premise.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do
> not write the done record, the commit message or the PR body yourself.


## Decisions

- **`--no-auto-setup` against an unmigrated database is now a refusal to START, not a retry loop.** A fold registers its generation before it reads or writes anything, and the registry and pointer are rows, so there is nowhere to register it. Alternatives considered: (a) apply the schema anyway — rejected, it re-means the flag, which says somebody else owns those migrations; (b) open the container lazily on the first batch — rejected, it loses "a cap refuses at start-up where an operator reads it" and turns a configuration fault into a `500` on somebody's ingest. Touches: `run` and `index` (the two commands that take the flag), and the equivalence test that used an unmigrated database to exercise ADR-0052's no-hole rule — that test now drops `_emissions` under a running, migrated process instead, and a new test pins the refusal. `build` is unaffected (it always migrates).
- **`run` schedules the rebuild chunk in the gap its fetch loop already waits between cycles.** ADR-0022 says the host schedules and invents no cadence; `run` is the host, and the loop's own backoff is its clock. Alternatives: a separate timer/pump (invents a cadence and a second writer thread against one handle), or fire-and-forget inside `onReport` (concurrent writes on one libSQL handle). Consequence, documented at the site: a process still catching up flat out (`CATCH_UP_DELAY_MS=0`) advances followers only once it reaches the tip. Touches nothing outside `run`; `build` schedules none, which is where "holds exactly one generation" becomes structural.
- **`run` still registers no named indexer, so the pointer's HTTP affordance lands on `index` only.** Registering the container on `run` would open its ingest routes to a remote sender — the second writer that command exists without. So `run`'s add-and-promote is in-process (the container it exposes, plus the automatic on-catch-up move) while the operator's `admin/canonical-generation` route answers on `index`. Touches ADR-0057 (amended in its consequences) and `packages/cli/README.md`.
- **`serve` resolves the pointer and REPORTS it in its startup lines; it injects no `/status` reporter.** The read tier's only HTTP surface is `/status`, and its cursor field is absent by design ("a read tier owns no store and is given none", pinned by the equivalence test). A reporter here could only claim `generations` with a `follows` flag it cannot know, so the resolution is said out loud instead and exported as `canonicalGenerationIn` / `canonicalStateNamespaceIn` for the readers that actually open the state. Alternative considered: report generation entries on `/status` with `follows: false` — rejected as a claim the read tier cannot make. Touches: what a reader of an etherfold database must do (two steps), which is now documented and exported.
- **A database holding SEVERAL named indexers refuses `canonicalGenerationIn` without a name rather than guessing.** Each name has its own pointer; picking one would be choosing a tenant for the caller. On every shape this repo builds a database is one named indexer, so the refusal is unreachable today. Touches: nothing else — `serve` reports every name it finds and refuses nothing.
- **The CLI states `SERVER_GENERATION_CAPS` (4 generations, 2 streams) and adds no flag for it.** The command set is pinned at five verbs with a fixed input table; a new flag would be a new user-visible input for a number that constant already argues for. Touches the command table (deliberately unchanged); an operator who hits the bound deletes a generation, and the refusal names what to delete.
- **A database written by the pre-generation CLI is not resumed.** Its state sits in tables nothing points at, and its stored stream is claimed by no registered generation, so the registry's own sweep collects it on first open (documented behaviour of `listStreamDigests`). Nothing is published and no disk holds state this project must preserve, so that costs a re-index rather than a migration.
