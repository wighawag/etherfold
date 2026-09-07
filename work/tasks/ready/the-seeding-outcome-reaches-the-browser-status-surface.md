---
title: 'The seeding outcome reaches the browser status surface an app already subscribes to'
slug: the-seeding-outcome-reaches-the-browser-status-surface
spec: a-browser-app-starts-from-a-published-artifact
needsAnswers: true
blockedBy: [a-seed-that-is-not-for-this-build-is-refused-before-any-write]
covers: [10]
---

<!-- open-questions -->

## Open questions

The STORY is committed and its surface is settled: the outcome lands on the EXISTING browser status surface (the one that already carries `error` and `nonCanonicalGenerations`), and this is explicitly not licence to implement the reactive-envelope redesign in `work/notes/ideas/the-reactive-update-is-an-envelope-not-a-handle.md`. What is not settled is the WIRING, and each of these changes what the task builds, so they are asked rather than guessed.

1. **Who drives the install?** Does the browser hook (`createIndexerState`) take the seed locations, the optional pinned content hash and the caller's same-origin statement as options and run the install itself before the generation loads, publishing progress and outcome as it goes? Or does the application call the core loader itself and hand the resulting outcome to the hook to publish? The first is what makes "installing" renderable at all and what guarantees the install happens while the subtree is still EMPTY (the loader refuses a non-empty one); the second keeps the hook thinner and leaves the trust statement in the app's own code. Nothing in ADR-0063, ADR-0064 or ADR-0065 decides it: ADR-0064 names the surface as a build-plan item and the spec settles only WHICH surface.
2. **What does the surface carry?** A refusal is a normal condition and not an `error` (an app still starts and still indexes forward from a state snapshot), so does the status gain its own field with a small discriminated state (installing, seeded at block N, refused with a reason and, where present, a direction), or is one of the existing fields reused? If it is a new field, is progress DURING the install reported (bytes, batches, blocks) or only the terminal states?

Only these two are open. A third question, what happens to the app on a refusal, is NOT open and is recorded here so nobody re-asks it: ADR-0064 settles it under 'What a refusal actually costs the user' -- a refused seed does not stop an application, state still bootstraps from the published state snapshot and indexes forward from the tip, and what is lost is the stream underneath (the generation is a leaf). So a refusal is reported alongside an otherwise-normal boot and never gates it. Build to that.

<!-- /open-questions -->

## What to build

The last slice, and it has nothing to show until there is an outcome to show: the seeding outcome the loader returns reaches the surface a browser app already subscribes to, so an app can render "installing", "seeded at block N" or a refusal reason instead of an unexplained empty screen.

The reason this exists at all is stated in ADR-0064: an app that cannot say why it has no seed will show an empty screen instead of an explanation, which is the outcome this whole spec exists to avoid. The refusal's DIRECTION is the half an application renders, and the rule the surface must not break is that the loader reports the direction and never infers "you are out of date": an app may choose to render "a newer version of this app may be available"; the library may not claim it, because a deliberately narrower client is indistinguishable from a stale one.

Two constraints from the spec are firm whatever the answers above are. It lands on the EXISTING status surface, not a new reactive shape. And it reports; it does not decide: which of "installing", "seeded" or "refused" should dim, hide or replace what is on screen is the application's call, exactly as the non-canonical generation report already is.

## Acceptance criteria

- [ ] The seeding outcome is observable through the browser package's existing subscribable status surface, with no new reactive mechanism introduced.
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
> FIRST, answer the two open questions at the top of this file (or have them answered): they decide who drives the install and what the surface carries, and building before they are settled means guessing at an API that ships. What happens to the app on a refusal is NOT open: ADR-0064 says it carries on from the state snapshot and the refusal is reported alongside it. Then check this task against current reality (it is a launch snapshot and may have DRIFTED): read the loader, its outcome type and its refusal vocabulary as they actually landed in `@etherfold/core`, not as this file describes them.
>
> Vocabulary (`CONTEXT.md`): the browser package wraps the engine in observable stores (state, syncing, status); its syncing store already carries an `error` and the non-canonical **generation** progress list, which is the precedent for how this library REPORTS rather than decides ("only the developer knows whether their reconfigure made the old answers WRONG or merely INCOMPLETE"). **Seeding** is creating a generation from a published artifact; a refusal is DATA with a reason and, for an identity mismatch, a DIRECTION.
>
> The decisions that constrain you: ADR-0064's "This must reach the application's own surface, not only the boot path's return value" and its rule that the loader reports the direction and never claims the client is behind; ADR-0065's trust contract, since whatever option carries the pin or the same-origin statement must keep the pin in the BUILD; and the spec's own note that story 10 lands on the existing status surface deliberately and is NOT licence to implement the reactive-envelope idea in `work/notes/ideas/the-reactive-update-is-an-envelope-not-a-handle.md`, which is a separate, undecided change.
>
> Where to look, by concept: the browser package's indexer-state module (the syncing store, its fields and how a reconfigure clears them), its existing tests for how a status claim is asserted against the real IndexedDB substrate under `fake-indexeddb`, and the core loader's outcome type. Also read `work/notes/observations/browser-reactive-updates-depend-on-a-store-that-never-dedupes.md` before adding a field that fires often.
>
> Done means: an app subscribing to what it already subscribes to can render installing, seeded at a block, or refused with a reason it can explain; the library claims nothing it cannot know; no new reactive mechanism; a changeset; a green gate.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT: the wiring you were given or chose, the field shape, and what happens to an app whose seed was refused. The runner transcribes the block into the done record; do not write the done record, the commit message or the PR body yourself, and do not open a `decisions-*` note.

## Open questions

- The build PIN, which is the entire trust story of stories 7 and 8, is split across two tasks with no contract between them and no round-trip assertion, so both tasks can pass their own tests while every real pinned install refuses. The producer task says only that it PRINTS the content hash; the admission task says only that a seed whose bytes do not match a caller-supplied hash is refused. Neither names the hash ALGORITHM, nor the BYTE DOMAIN (the published compressed document versus the decompressed JSON text), and no task owns how a single compact GZIPPED document becomes a parsed envelope on the wire. That last one decides the first: a host declaring Content-Encoding gzip makes fetch decompress transparently, so a hash taken over the compressed file cannot be recomputed from what the client receives. Fixed in the edits: the producer declares algorithm plus byte domain and asserts its printed hash is reproducible; the loader owns and records the decompression arrangement and exercises it the way a real host would; the admission task pins the reference artifact with the literal value the PRODUCER printed rather than one it recomputed with the same helper it is verifying. (producer AC 'The producer PRINTS the artifact stream digest and its content hash'; admission AC 'A seed whose bytes do not match a caller-supplied expected content hash is refused'; loader task never mentions decompression; ADR-0065 pins that trust comes from the build hash but does not fix the byte domain.)
