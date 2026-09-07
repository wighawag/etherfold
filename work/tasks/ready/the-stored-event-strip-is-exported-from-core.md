---
title: 'The stored-event strip is exported from @etherfold/core, so nothing outside it copies the rule'
slug: the-stored-event-strip-is-exported-from-core
spec: a-browser-app-starts-from-a-published-artifact
blockedBy: []
covers: [3]
needsAnswers: true
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

## Open questions

- The build PIN, which is the entire trust story of stories 7 and 8, is split across two tasks with no contract between them and no round-trip assertion, so both tasks can pass their own tests while every real pinned install refuses. The producer task says only that it PRINTS the content hash; the admission task says only that a seed whose bytes do not match a caller-supplied hash is refused. Neither names the hash ALGORITHM, nor the BYTE DOMAIN (the published compressed document versus the decompressed JSON text), and no task owns how a single compact GZIPPED document becomes a parsed envelope on the wire. That last one decides the first: a host declaring Content-Encoding gzip makes fetch decompress transparently, so a hash taken over the compressed file cannot be recomputed from what the client receives. Fixed in the edits: the producer declares algorithm plus byte domain and asserts its printed hash is reproducible; the loader owns and records the decompression arrangement and exercises it the way a real host would; the admission task pins the reference artifact with the literal value the PRODUCER printed rather than one it recomputed with the same helper it is verifying. (producer AC 'The producer PRINTS the artifact stream digest and its content hash'; admission AC 'A seed whose bytes do not match a caller-supplied expected content hash is refused'; loader task never mentions decompression; ADR-0065 pins that trust comes from the build hash but does not fix the byte domain.)
