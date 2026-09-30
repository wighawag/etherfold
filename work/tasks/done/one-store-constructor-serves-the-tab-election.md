---
title: 'One store constructor serves the tab election'
slug: one-store-constructor-serves-the-tab-election
blockedBy: []
covers: []
---

## Answered (2026-09-29, by the maintainer)

1. **A helper, not a host change** (option (c) of three). An exported function takes ONE store constructor (plus the publication handling) and RETURNS `{createState, openState}`, spread into the spec. It keeps ADR-0097 D2's two factories and its type rule (the reader factory returns a read-only store), needs no ADR amendment and no new runtime dependency, and leaves hot update unchanged. Rejected: the host deriving both roles, either by building the entity view and running the install itself (a runtime dependency of `@etherfold/browser` on `@etherfold/processor-entities`, and a reversal of ADR-0096's "the install is the app's"), or by taking an `openStore` that returns a backend and a view (a spec change and amendments to ADR-0097 and ADR-0077), because the drift the task fixes is removed just as well by one helper.

## What to build

Opting into the tab election (ADR-0097) should be one line, `tabElection: {name}`, not a second factory that repeats the first. Today a worker entry that elects writes `openState` beside `createState`, and in every recipe it is the same database constructor, with `openForReading` where `createState` has `openForWriting`, plus `new EntityStateView(store)`. When the processor arrives as a bundle, the declarations come from `bundle.processor.entities` in both.

The repetition is not only boilerplate; it is a correctness hazard. The election is correct only when the reader opens the SAME database the leader writes, and two hand-written factories can drift (a `databaseName` changed in one), so a reader would answer from an empty store while looking healthy.

So the app names the store's constructor ONCE, and a helper derives both factories from it: `createState` claims it (`openForWriting`, after `openAndBootstrap` with the `published` snapshot when there is one) and `openState` opens it read-only (`openForReading`) with its `EntityStateView`. ADR-0097's type rule holds by construction, since the two factories and their return types are unchanged, and ADR-0077's split of the claim from the construction is what the helper composes. It lives where those pieces already are, `@etherfold/processor-entities`, so `@etherfold/browser` gains no dependency. The helper must NOT import from `@etherfold/browser` either (that package devDepends on this one, so it would be a cycle): the parameter types `createState` and `openState` receive (`ClaimPatience`, `InstantiatedProcessorBundle`, `PublicationSnapshot`, `ReaderState`) are declared structurally in the helper, and `GenerationContext` comes from `@etherfold/core`, which processor-entities already depends on. It takes the store constructor and the bootstrap options the app gives today (`finalityDepth`, `fetch`), forwards the host's `published.processor`, `published.locations` and `published.replaceLocal` to `openAndBootstrap`, and hands the claim signal to `openForWriting` only (the signal bounds the claim, not the download). Optionally its `openState` opens the store snapshot-aware (`openSnapshotAware`) before `openForReading`, so a reader of a snapshot-seeded store keeps the floor that refuses as-of reads below the snapshot, which today's hand-written reader recipe loses; record whether it does in the Decisions block. The recipe becomes one call spread into the spec, beside `tabElection: {name}`.

Seen in the stratagems port (`port-stratagems-to-the-etherfold-packages`), whose worker entry carries both factories and a shared `databaseName` helper to keep them agreeing.

## Acceptance criteria

- [ ] A worker entry that spreads the helper's result (built from one store constructor) plus `tabElection: {name}` elects: the first tab writes, a second tab reads the leader's rows and answers queries (read surface and GraphQL) from them, and takes over when the leader closes. Asserted in the real-browser suite, as the existing election case is.
- [ ] A reader built this way cannot write, by type: the helper's `openState` returns the read-only store `openForReading` gives, as a hand-written one does.
- [ ] With a `publication` configured, the leader still bootstraps from the snapshot, and a reader never downloads or installs one.
- [ ] A host that abandons a catch-up (`published.replaceLocal: true`) still replaces the local state through the helper, and the claim signal reaches `openForWriting` and nothing else.
- [ ] `@etherfold/processor-entities` gains no dependency on `@etherfold/browser` (the helper's parameter types are structural).
- [ ] The helper works with a processor that arrives as a bundle (declarations from `bundle.processor.entities`) and with one imported as a module, and the hot-update recipe is unchanged.
- [ ] `createState` / `openState` keep working unchanged (the existing election and hot-update tests pass untouched).
- [ ] A follow-up task is written (not built) for readers following a promoted successor: today a reader tab keeps reading the incumbent's database after the leader promotes a generation stored elsewhere.
- [ ] The browser guide's tab-election section and `examples/browser-reference` use the one-factory form.
- [ ] A changeset for `@etherfold/processor-entities` (minor: a new export).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: a tab election is opted into with `tabElection: {name}` and ONE store constructor, from which the writer and the reader are derived by a helper (answered above), keeping ADR-0097's rule that a reader cannot write by type. Look at `HostedIndexerSpec` / `BrowserGenerationSpec` (`createState`, `openState`, `ReaderState`) in `@etherfold/browser`, the tab election (`tabElection.ts`, ADR-0097, including its Considered options), `openForWriting` / `openForReading` (ADR-0077), `openAndBootstrap` with the `published` snapshot the host hands `createState` (ADR-0095, ADR-0096), `reconfigureFromHotUpdate` (`hotUpdate.ts`), and `@etherfold/browser`'s dependencies (`package.json`). The guide's "One tab indexes and the others read" and `examples/browser-reference/browser/indexer.worker.ts` are the recipes to shorten.
>
> FIRST, check this task against current reality (written 2026-09-29 against `@etherfold/browser@0.12.0` and `@etherfold/processor-entities@0.3.1`). If the premise has drifted, route to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious choice in a `## Decisions` block at the end of your final report. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands, and never grep `node_modules`, `dist`, `.git` or minified bundles. The real-browser suites run in CI's browser jobs; they must be green.

## Decisions

- **Name and shape: `stateFactoriesFrom({open, entities?, finalityDepth?, fetch?, onBootstrap?})`,** one options object returning `{createState, openState}`. `open(context, entities)` is the one store constructor; it is handed the declarations so the store is always declared from the fold that writes it.
- **Where the declarations come from.** With a published bundle, `bundle.processor.entities` wins over `entities`, because the bundle's bytes are the fold that writes the store. `entities` is for a processor imported as a module. With neither, both factories refuse by name, and so does a bundle whose processor has no `entities` array.
- **`openState` opens snapshot-aware (`openSnapshotAware`) before `openForReading`.** A reader of a snapshot-seeded store therefore keeps the floor, so an as-of read below the snapshot is refused (tested). `openSnapshotAware` calls `migrate()`, which the hand-written recipe already did through `createBrowserStateStore`. The snapshot-aware handle forwards the accessor and tip, so GraphQL on a reader still works.
- **The writer opens snapshot-aware even without a snapshot.** With no `published` it runs `openSnapshotAware` rather than `openAndBootstrap` with no locations, which is equivalent and fetches nothing. That recovers a floor an earlier install recorded, as the guide's publication recipe already did.
- **`onBootstrap(outcome, context)`** was added so an app can still render or log what the bootstrap did (the guide's recipe logged it). It is optional.
- **The parameter types are declared structurally in processor-entities** as `StateClaimPatience`, `ArrivedProcessorBundle`, `PublishedSnapshotForState` and `EntityReaderState`, narrowed to the fields the factories read. `replaceLocal` is optional there. Typecheck proves the browser's own types are assignable. processor-entities' dependencies are unchanged.
- **GraphQL on a reader needed the leader to apply a block after the reader joined.** A reader of a MODULE-arrival fold that joins a quiet chain cannot name its generation (`readerGenerationOf`, by design), and the query answers `internal-error`. That was pre-existing: the original hand-written factories failed the same way. So the browser-reference test mints one block above the tip (a new `__mint()` on the fake wallet, called on both pages because each page has its own fake chain), and I wrote up the underlying gap as `work/tasks/backlog/a-reader-of-a-module-fold-answers-a-query-on-a-quiet-chain.md`. The reference worker's comment now states that condition.
- **Where each acceptance criterion is proven.** The three-engine browser suite (`packages/browser/browser/oneTabIndexesAndTheOthersRead.spec.ts`, new case, worker fixture `?helper`) proves election, reader reads, and takeover on a clean tab close through the read surface. GraphQL on a reader is proven in `examples/browser-reference/verify/reference.spec.ts` (chromium, CI's `browser-reference (verify:browser)` step), because `@etherfold/browser` cannot depend on `@etherfold/graphql` without a cycle.
- **Existing tests were left byte-for-byte untouched.** The helper variants are new functions (`helperTabOf`, a new `describe`), not branches inside the existing `tabOf`/`hostOf`.
- **The follow-up** is `work/tasks/backlog/a-reader-tab-follows-a-promoted-successor.md`, written and not built.
