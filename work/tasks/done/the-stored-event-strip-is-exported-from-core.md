---
title: 'The stored-event strip is exported from @etherfold/core, so nothing outside it copies the rule'
slug: the-stored-event-strip-is-exported-from-core
spec: a-browser-app-starts-from-a-published-artifact
blockedBy: []
covers: [3]
---

## What to build

`storedEventOf` and `storedStreamOf` reach the public surface of `@etherfold/core`, so that code OUTSIDE the package reduces a decoded event to a stored one through the ONE implementation of that rule instead of a copy.

The rule is ADR-0060's: the keeper seam takes only what the node said, and the decoded half (`args` / `eventName` / `decodeError`) is a cache re-derived on read. Today both functions live under `internal/`, which is why the exploration's spike had to duplicate the three-key destructure, and that duplication is the exact thing ADR-0060 exists to prevent. ADR-0063 names exporting them as a BUILD item, not a design question.

Be precise about what justifies the export, because it decides how far it goes: the loader that installs a seed lives INSIDE core and can reach the internal module directly. The export earns its keep because something OUTSIDE core has to apply the same strip: the seed PRODUCER of the next task, and any consumer writing its own installer. So export the two the ADR names, give them a published JSDoc that says why the export exists (this repo's entry point documents the WHY of every non-obvious export, in place), and do not widen the surface beyond what a caller outside core actually needs. If the producer turns out to need the cursor strip as well, adding it is an in-scope decision to record rather than a second task.

Re-exporting from `internal/` at the package entry is the established pattern here (several engine helpers are published that way), so this is an addition to the public surface, not a file move, unless a move makes the boundary honest and costs nothing.

## Acceptance criteria

- [ ] `storedEventOf` and `storedStreamOf` are importable from `@etherfold/core`'s package entry by a consumer package.
- [ ] A test OUTSIDE `@etherfold/core` (or the repo's published-type / typecheck coverage machinery, whichever is the existing home for that claim) proves they are reachable and correctly typed from a consumer, so a future refactor that un-publishes them fails a gate rather than breaking a downstream build.
- [ ] The published JSDoc states why the export exists (an installer or producer outside core must apply the SAME strip, ADR-0060, and the spike's duplicated destructure is the evidence) rather than restating what the function does.
- [ ] Every type in the exported signatures is itself published, so the declarations do not reference an unpublished type.
- [ ] Existing behaviour is unchanged: nothing inside core switches to a different implementation of the strip, and no test that pins "the stream stores only what the node said" changes meaning.
- [ ] A changeset records the additive `@etherfold/core` change.
- [ ] The repo acceptance gate is green (`pnpm format:check`, `pnpm check:adr`, `pnpm changeset status --since=main`, `pnpm build`, `pnpm typecheck`, `pnpm test`).

## Blocked by

- None, can start immediately.

## Prompt

> Publish the stored-event strip from `@etherfold/core` so that code outside the package stops copying it.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): are `storedEventOf` and `storedStreamOf` still internal, and does ADR-0060 still govern? If the surface already moved, route to needs-attention rather than duplicating an export.
>
> Vocabulary (`CONTEXT.md`): the **stream / keepStream (ExistingStream)** seam speaks `StoredLogEvent` and nothing else, because the DECODED half is what some ABI made of those bytes and is re-derived by `reparse` against the source running now (ADR-0034, ADR-0060). The strip is how a decoded `LogEvent` becomes a `StoredLogEvent`, and it deliberately builds a NEW object rather than deleting keys off the event the processor is about to fold.
>
> Where to look: the strip lives in core's internal stream module; the package entry (`packages/core/src/index.ts`) is where published exports carry their WHY as a JSDoc block above them, and it already re-exports several helpers straight out of `internal/` for exactly this reason (a caller outside the package would otherwise re-derive a rule that must have one implementation). Follow that pattern, including its tone.
>
> Why now: ADR-0063 ("A published stream seed arrives through its OWN loader, and installs through the KEEPER SEAM") names this as a build item, because the spike at `docs/spikes/pin-the-seam-a-published-stream-arrives-through/` had to COPY the three-key destructure to install outside the engine. The next task builds a seed PRODUCER outside core that must apply the identical strip. The loader itself will live inside core, so do not justify the export by it.
>
> Seams to test at: a consumer package's own suite, or whichever existing mechanism this repo uses to assert that a published symbol is actually reachable and that its types are published too (there is a published-type dependency check and a typecheck-coverage test in core's suite: read them before inventing a new one).
>
> Done means: the two functions are importable from the package entry with a WHY-carrying JSDoc, a gate would catch their un-publication, a changeset exists, and nothing inside core changed behaviour.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT (in particular: whether you also exported the cursor strip, and whether you moved the module or re-exported it). The runner transcribes it into the done record; do not write the done record, the commit message or the PR body yourself, and do not open a `decisions-*` note.

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

- **The cursor strip `storedLastSyncOf` is NOT exported.** The seam's cursor half is built by an installer rather than stripped from a live one: the spike (and ADR-0063's three block rules) constructs the `StoredLastSync` literally, with an empty window and the capture's own block numbers, so an outside caller has no cursor to strip. Publishing it would offer a tool for a job nobody outside core has, and would invite an installer to strip the engine's live window, which is the exact hazard `storedLastSyncOf`'s own JSDoc warns about. Alternative considered: export all three now (the task allows it as an in-scope decision). Touches: the next task's seed PRODUCER, which is the caller that could reverse this by needing it; widening later is one line plus a changeset, so this is cheap to reverse.
- **Re-exported from `internal/`, module not moved.** `packages/core/src/index.ts` already publishes several helpers straight out of `internal/` with a WHY block (`resolveStreamConfig`, `streamConfigHashOf`, `sameWireContext`, `cursorSyncedThrough`), and a move would have touched `indexer.ts`'s import and split the strip away from `storedLastSyncOf`, which stays internal and shares its rationale. Alternative considered: move `strip.ts` to `src/stream/` and `export *`, which would then have published the cursor strip too, i.e. the opposite of the decision above. Touches: nothing outside core.
- **A named export (`export {storedEventOf, storedStreamOf}`) rather than `export * from './internal/stream/strip.js'`.** The star form is what most of this entry uses, but here it would publish the third function silently and make the surface follow whatever the internal module grows next. Touches: future additions to `strip.ts`, which now have to be published deliberately.
- **The reachability gate lives in a CONSUMER's suite (`@etherfold/browser`), not in core's published-type / typecheck-coverage machinery.** Those two workspace-level tests answer different questions (do published `.d.ts` files import only declared dependencies; is every package typechecked), and neither can see whether a named symbol is reachable through the entry. The existing home for that claim is the consumer imports themselves (`packages/cli/test/streamConfigAgreement.test.ts` imports `resolveStreamConfig` from `@etherfold/core`); browser is the consumer that owns a keeper and is the deployment the seeding spec targets, and the spike used its keeper. Alternative considered: a core-suite test parsing `dist/index.d.ts` for the two names, which would gate the same fact without proving a consumer can actually resolve and type it.
- **The changeset lists `@etherfold/browser: patch` for a test-only change.** `pnpm changeset status --since=main` treats any file under a package directory as a change to it, so a new test in browser needs an entry or the gate goes red at land time. Precedent for a test-only entry: `.changeset/the-gate-does-not-assume-an-idle-machine.md` patches every package for a vitest-timeout change. Touches: the release notes for `@etherfold/browser`, which will carry a patch with no runtime difference; the changeset says so explicitly.
