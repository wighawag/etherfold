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

**The deciding argument is a SILENT failure mode, and it is worth understanding before you build either path.** The window for an install is after the generation is built and before it loads, and the boot path already provides one: `init()` builds the container, and the `IndexerGeneration` constructor's `reinit` calls `keepStream.setStreamConfig(resolvedConfig)` -- which is the moment the keeper learns which stream address it is writing to. `init()` does NOT load; `indexer.load()` happens later, inside `setupIndexing()`, driven by the first `indexMore()` or `startAutoIndexing()`. So the correct window is between those two, and it is comfortable.

Missing it fails in two very different ways:

- **TOO LATE** (after indexing has started): the subtree is not empty, the loader refuses, the app renders a refusal. Loud, and nothing is corrupted.
- **TOO EARLY** (before `init()`): the keeper still holds its DEFAULT stream config, so `streamDigestOf` resolves a different digest and the seed installs at an address nothing will ever read. **Silent**, and it is exactly the "installs under a key nothing reads" waste ADR-0064 exists to forbid, arriving through ordering instead of identity.

The hook option exists to make that second case unreachable for the common path: only the hook knows when the address has been configured. The direct path stays supported because it is symmetric with how the state SNAPSHOT is already bootstrapped today (the app calls `bootstrapFromSnapshot` itself and hands the store to the hook through `createState`; `createIndexerState` knows nothing about it), and because an app may prefer to keep the trust statement in its own code beside its build pin.

So: the hook's `seed` option is a convenience that encodes the ordering rule, not a new owner of the trust decision. Document the ordering constraint for the direct path.

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
- [ ] `createIndexerState` accepts an optional `seed` and runs the install AFTER the generation is built (so the keeper's stream config is set) and BEFORE it loads, publishing `installing` and then the terminal outcome.
- [ ] Driving the install DIRECTLY from an application still works and is documented, including the ordering constraint: installing before `init()` lands the seed at the wrong stream address SILENTLY, because the keeper still holds its default stream config.
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
