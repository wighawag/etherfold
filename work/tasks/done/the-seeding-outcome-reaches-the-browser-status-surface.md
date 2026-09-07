---
title: 'The seeding outcome reaches the browser status surface an app already subscribes to'
slug: the-seeding-outcome-reaches-the-browser-status-surface
spec: a-browser-app-starts-from-a-published-artifact
blockedBy: [a-seed-that-is-not-for-this-build-is-refused-before-any-write]
covers: [10]
---

## The two wiring questions, ANSWERED

Both were asked by the tasking loop and are now decided by the human. Build to these; do not re-open them.

### 1. BOTH paths exist, and the hook-driven one is the documented default

The core loader is callable directly, so an application may drive the install itself; AND `createIndexerState` takes an optional `seed` (the locations the build names, and an optional pinned content hash) and runs the install itself at the right moment. The hook path is what the docs show.

**The hook option is ERGONOMICS, and an earlier draft of this task oversold it.** It claimed the install must run inside the hook because only the hook knows when the keeper's address has been configured, so an app installing "too early" would silently write to the wrong stream. That is no longer true: ADR-0067 makes the install take the RESOLVED stream config as an argument and set it itself, so it is correct whether it runs before or after a generation exists, and the silent failure mode is gone rather than guarded. Build the option because it saves an app from sequencing the call and because it gives this surface something to publish, not because it is a safety mechanism.

What DOES remain true about ordering, and is worth one test: the install refuses a subtree that is not empty (ADR-0067), so an app that starts indexing before installing gets a refusal rather than a corrupted stream. That is loud and needs no hook to prevent.

So: the hook's `seed` option is a convenience, not a new owner of the trust decision and not a safety mechanism. Document the direct path too, including that it needs the resolved stream config passed to it.

### 2. A dedicated `seed` field, plus a phase value; NO byte progress in v1

- **A new field on the syncing store**, a small discriminated state: `installing`, `seeded` (naming the block the stream reached), `refused` (with the reason and, where the reason carries one, the direction), and the absent case. Additive, so no existing subscriber changes.
- **`error` is NOT reused.** ADR-0064 makes a refusal a NORMAL condition -- the app still starts and still indexes forward -- so an app treating `error` as a fault would render a crash for an ordinary outcome, and `error`'s `acknowledgeError()` semantics do not fit.
- **Add a seeding value to the status phase enum** (beside `Loading`, `FetchingEventStream` and the rest), because that enum is where applications already switch to choose what to render, so the boot phase becomes visible without every app learning a new field.
- **No byte-level progress during the install**, and the reason is measured rather than assumed: in the recommended single-document shape the whole install takes about **1 second on a Pixel 8a** and ~300 ms on desktop (`work/notes/findings/what-a-published-stream-seed-costs-to-install.md`), which a spinner covers. The variable part is the DOWNLOAD, not the install, so if a progress signal is ever wanted it belongs on the fetch as an optional loader callback, and adding one later is additive and needs no change to this surface.

### What was never open

What happens to the app on a refusal is settled by ADR-0064 ('What a refusal actually costs the user'): a refused seed does not stop an application, state still bootstraps from the published state snapshot and indexes forward from the tip, and what is lost is the stream underneath (the generation is a leaf). A refusal is reported alongside an otherwise-normal boot and never gates it.

## What to build

The last slice, and it has nothing to show until there is an outcome to show: the seeding outcome the loader returns reaches the surface a browser app already subscribes to, so an app can render "installing", "seeded at block N" or a refusal reason instead of an unexplained empty screen.

The reason this exists at all is stated in ADR-0064: an app that cannot say why it has no seed will show an empty screen instead of an explanation, which is the outcome this whole spec exists to avoid. The refusal's DIRECTION is the half an application renders, and the rule the surface must not break is that the loader reports the direction and never infers "you are out of date": an app may choose to render "a newer version of this app may be available"; the library may not claim it, because a deliberately narrower client is indistinguishable from a stale one.

Two constraints from the spec are firm whatever the answers above are. It lands on the EXISTING status surface, not a new reactive shape. And it reports; it does not decide: which of "installing", "seeded" or "refused" should dim, hide or replace what is on screen is the application's call, exactly as the non-canonical generation report already is.

## Acceptance criteria

- [ ] The seeding outcome is observable through the browser package's existing subscribable status surface, with no new reactive mechanism introduced, as a DEDICATED field carrying `installing` / `seeded` / `refused` / absent, plus a seeding value in the status phase enum.
- [ ] `error` is not reused for a refusal, and no existing field changes meaning.
- [ ] `createIndexerState` accepts an optional `seed` and runs the install BEFORE the generation loads, publishing `installing` and then the terminal outcome.
- [ ] Driving the install DIRECTLY from an application still works and is documented, and is asserted to be correct BEFORE `init()` as well as after, since the install carries its own resolved stream config (ADR-0067). An app that installs after indexing has started gets the not-empty REFUSAL, which is loud; assert that too.
- [ ] No byte-level progress is reported during the install; the terminal states plus `installing` are the whole surface.
- [ ] A refusal reaches the surface WITH its reason and, where the reason carries one, its direction, so an app can render something true rather than "loading".
- [ ] Nothing in the library infers or renders "you are out of date": the direction is reported as data.
- [ ] A refused seed does not stop the app: state still comes up from a published snapshot and indexes forward, and the refusal is reported alongside it, never gating the boot (ADR-0064, 'What a refusal actually costs the user').
- [ ] A successful install is observable as such, naming the block the stream reached.
- [ ] The reactive-envelope redesign is NOT implemented, and no existing status field changes meaning for callers that never seed.
- [ ] Tests cover the new behaviour in the browser package's existing style, driving the real keeper substrate under `fake-indexeddb`, with per-case database names and no writes outside them.
- [ ] A changeset records the `@etherfold/browser` change.
- [ ] The repo acceptance gate is green.

## Blocked by

- `a-seed-that-is-not-for-this-build-is-refused-before-any-write`, because the surface reports the outcome type INCLUDING every refusal reason, and that type is only complete once the admission checks land.

## Prompt

> Surface the stream-seeding outcome on the browser status store an application already subscribes to.
>
> FIRST read "The two wiring questions, ANSWERED" at the top of this file: who drives the install and what the surface carries are DECIDED, including the silent failure mode that decided the first one, and they are not to be re-opened. What happens to the app on a refusal is likewise settled: ADR-0064 says it carries on from the state snapshot and the refusal is reported alongside it. Then check this task against current reality (it is a launch snapshot and may have DRIFTED): read the loader, its outcome type and its refusal vocabulary as they actually landed in `@etherfold/core`, not as this file describes them.
>
> Vocabulary (`CONTEXT.md`): the browser package wraps the engine in observable stores (state, syncing, status); its syncing store already carries an `error` and the non-canonical **generation** progress list, which is the precedent for how this library REPORTS rather than decides ("only the developer knows whether their reconfigure made the old answers WRONG or merely INCOMPLETE"). **Seeding** is creating a generation from a published artifact; a refusal is DATA with a reason and, for an identity mismatch, a DIRECTION.
>
> The decisions that constrain you: ADR-0064's "This must reach the application's own surface, not only the boot path's return value" and its rule that the loader reports the direction and never claims the client is behind; ADR-0066's trust contract, since whatever option carries the locations and the optional hash must keep BOTH in the BUILD; and the spec's own note that story 10 lands on the existing status surface deliberately and is NOT licence to implement the reactive-envelope idea in `work/notes/ideas/the-reactive-update-is-an-envelope-not-a-handle.md`, which is a separate, undecided change.
>
> Where to look, by concept: the browser package's indexer-state module (the syncing store, its fields and how a reconfigure clears them), its existing tests for how a status claim is asserted against the real IndexedDB substrate under `fake-indexeddb`, and the core loader's outcome type. Also read `work/notes/observations/browser-reactive-updates-depend-on-a-store-that-never-dedupes.md` before adding a field that fires often.
>
> Done means: an app subscribing to what it already subscribes to can render installing, seeded at a block, or refused with a reason it can explain; the library claims nothing it cannot know; no new reactive mechanism; a changeset; a green gate.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT: the wiring you were given or chose, the field shape, and what happens to an app whose seed was refused. The runner transcribes the block into the done record; do not write the done record, the commit message or the PR body yourself, and do not open a `decisions-*` note.

## Note on the build pin, superseded

The tasking loop raised one blocking issue against every task in this set: ADR-0065 pinned trust to a
build-named content HASH without saying a hash of what. That is settled, but not the way the first
amendment settled it. **ADR-0066 supersedes ADR-0065 on the trust anchor and the byte domain**, and a
builder should read it before either:

- **Trust is the HOST the build NAMES**, not a content hash. A build cannot pin the hash of a ROLLING
  artifact, and rolling is how this is deployed: the reference deployment held one web build against a
  snapshot republished every hour. `bootstrapFromSnapshot`, the path that already ships and works,
  verifies no hash at all.
- **A content hash is OPTIONAL**, for a release-tied immutable artifact, where it is the strongest
  thing available. When present it is SHA-256 over the DECOMPRESSED octets, taken after transfer
  decoding and before `JSON.parse`.
- **There is NO hosting constraint.** The earlier rule forbidding `Content-Encoding: gzip` is
  withdrawn: hashing the decompressed octets is transport-invariant, so it does not matter whether a
  host serves the file opaque or compresses it in transit.
- **Same-origin is not a condition anywhere**, and the refusal it once justified is gone. The app may
  be served from any IPFS gateway while the artifact lives on a known host, so the two origins never
  match by construction.

## Decisions

- **Field name `streamSeed`, not `seed`.** `CONTEXT.md` defines **seeding** as covering BOTH published-artifact shapes (a state **snapshot** and a **stream seed**), and a browser app gets the snapshot outcome from `openAndBootstrap` inside its own `createState`. A field called `seed` on the syncing store would silently mean one of the two. Alternative considered: `seed` (shorter, matches the option name). Touches: the option is still `createIndexerState({seed})` because there it sits under a `keepStream` that already scopes it to the stream; only the published field is qualified.
- **Type name `StreamSeedState`, and the `direction` field is DERIVED.** `StreamSeedState` follows the file's own `SyncingState`/`StatusState` naming; `StreamSeedProgress` was rejected because "progress" is exactly what this surface deliberately does not report, and `StreamSeedOutcome` because `installing` is not an outcome. `direction` duplicates the reason for the two directional reasons (`seed-covers-more`/`seed-covers-less`), typed as `Extract<NotInstalledReason, ...>` so it can never drift from the loader's vocabulary. Alternative: report the reason alone and let each app know which reasons are directional. Touches: nothing outside this package; ADR-0064's "the refusal names a direction" is satisfied either way.
- **A `seed` with no `keepStream` RAISES at `init` rather than being a refusal.** It is a wiring mistake in the caller's own source and no location makes it right; reported as data it would surface as `unreachable` from every mirror and point the developer at the host. This is a new ERROR on a user-visible path, hence recorded. Alternatives considered: silently ignoring the option (invisible), or adding a core refusal reason (would put a browser wiring fault into the loader's published vocabulary). Touches: `createIndexerState`'s `init` contract only.
- **The install runs in `init`, before `openIndexer`, and the phase returns to `Idle` afterwards.** Before the generation is built means the fold finds the stream already there; ordering is not what makes it CORRECT (ADR-0067), which the tests assert by driving the direct path both before and after `init()`. Leaving `InstallingStreamSeed` standing after a terminal outcome would be the one certainly-untrue value; `setupIndexing` moves it on to `Loading` at the next call. Touches: `StatusState` consumers (none in this repo switch exhaustively on it).
- **A refusal leaves the app fully running, and the field is NOT cleared on a reconfigure.** Per ADR-0064 the refusal is reported alongside an otherwise-normal boot: `init` carries on, state comes up from whatever the app's `createState` bootstrapped, and the tab indexes forward (asserted end to end against a published snapshot). `clearSyncingStateForReconfigure` is shared by `updateProcessor`, `updateIndexer` and promotion, and the common reconfigure (a processor change) keeps the very stream this field describes, so clearing there would drop a true report. The accepted residue, documented at the field: after an `updateIndexer` that moves the indexer to a DIFFERENT stream, the field goes on describing the stream the app booted on. Making it per-stream would need a per-generation seed surface, which is beyond this task. Touches: `updateIndexer` callers.
- **On a THROW out of the loader the field is left saying `installing`.** `init` rejects (the caller's own error path), and there is no terminal outcome to report, so inventing one, or clearing the field, would both claim something untrue. Alternative: map it onto `syncing.error`, rejected on the same ground that keeps a refusal out of `error`.
