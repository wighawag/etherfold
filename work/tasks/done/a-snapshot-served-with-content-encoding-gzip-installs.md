---
title: 'A state snapshot served with Content-Encoding: gzip installs'
slug: a-snapshot-served-with-content-encoding-gzip-installs
blockedBy: []
covers: []
---

## What to build

A published state snapshot body (`state-<sha256>.ndjson.gz`) installs whichever way its host serves it: OPAQUE (the `.gz` bytes, no `Content-Encoding`), or with `Content-Encoding: gzip`, in which case the runtime has already inflated it and what arrives is the ndjson text.

Today only the first works. `readSnapshot` (`@etherfold/state-store`, `snapshot-document.ts`) always pipes the body through `DecompressionStream('gzip')`, so an already-inflated body fails to inflate, `readSnapshot` throws `SnapshotFormatError`, and `bootstrapFromSnapshot` / `openAndBootstrap` answer `{status: 'not-bootstrapped', reason: 'unreadable-format'}`. The tab then indexes from the source's start block, silently, while `progress.publication` still reads `found` (it reports the LOOKUP, not the install).

The stream-seed path already decides this from the bytes: `streamSeedPayloadFrom` (`@etherfold/core`, `stream/seedInstall.ts`) sniffs the gzip magic (`1f 8b`), inflates only then, peels exactly one layer, and documents why the bytes decide and not a header. The snapshot path follows the same RULE, but not the same code: the seed helper takes the whole body as one buffer, and a snapshot is installed CHUNK BY CHUNK, never holding the whole document (ADR-0095, and the note at the top of `snapshot-document.ts`). So the snapshot reader PEEKS the stream's leading bytes, and pipes the stream (those bytes included) through `DecompressionStream('gzip')` when they are the gzip magic, or straight into the line reader when they are not: no buffering of the body, and no new dependency (`@etherfold/state-store` has none).

It is unambiguous for the seed's reason: a format-2 snapshot's first line is JSON and cannot begin with `1f 8b`. A format-1 document (plain JSON) must still be refused: after the sniff, its head is not format 2. Nothing about the publication's `contentHash` (`@etherfold/core`, `publication.ts`) changes: it is defined over the DECOMPRESSED document (ADR-0066), and the snapshot install path does not check it today.

Found by the stratagems port (`port-stratagems-to-the-etherfold-packages`): Vite's dev server serves `static/**/*.gz` with `Content-Encoding: gzip`, so an app that embeds its publication under `static/` starts from its snapshot in a production build and not under `vite dev`. Minimal repro: `openAndBootstrap(store, [url], {processor, fetch})` with a `fetch` answering `new Response(gunzipSync(body))` gives `not-bootstrapped / unreadable-format`; answering `new Response(body)` gives `bootstrapped`.

## Acceptance criteria

- [ ] A snapshot body delivered opaque and the same body delivered already inflated both install, landing on identical rows and the same resume position (a test with a `fetch` override for each, on the memory and IndexedDB stores at least).
- [ ] Both deliveries also install when the body arrives in 1-byte chunks (the sniff needs two bytes and must not assume the first chunk holds them).
- [ ] The body is never buffered whole: the install stays chunk by chunk (the existing streaming tests pass untouched).
- [ ] A body that is gzip-wrapped twice is refused as `unreadable-format` (exactly one layer is peeled, as for seeds).
- [ ] A format-1 plain-JSON document is still refused as `unreadable-format` (the existing case keeps passing).
- [ ] The doc comments that say a snapshot document is always the gzipped document, and that format 1 is refused because it does not inflate (`snapshot-document.ts`: the `SnapshotDocument` type and `readSnapshot`, and the format note near the top), say what is true after the change.
- [ ] Cancelling a reader after its head (what mirror selection does to the locations it did not pick) still cancels the underlying download, for an opaque and for an already-inflated body: a peek wrapper must forward `cancel`, and the existing test only counts bytes read, so this is asserted directly.
- [ ] A `{url, head}` location whose body is served already inflated installs too (the second location form, which reaches the same reader).
- [ ] The browser guide says, in both "Starting from a published snapshot" and the stream-seed section, that a host may serve a `.gz` artifact opaque or with `Content-Encoding: gzip` (neither section says so today).
- [ ] A changeset for `@etherfold/state-store` (patch).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: a published state snapshot installs whether its host serves the `.gz` body opaque or with `Content-Encoding: gzip`, deciding from the body's leading bytes as a stream seed already does, while keeping the chunk-by-chunk install. Look at `readSnapshot` in `@etherfold/state-store`'s `snapshot-document.ts` (always inflates, streams the body line by line) and `streamSeedPayloadFrom` in `@etherfold/core`'s `stream/seedInstall.ts` (the sniff rule and why bytes, not headers, decide; but it buffers the whole body, which the snapshot path must not). ADR-0095 is the publication and the streaming install; ADR-0066 defines content hashes over decompressed octets.
>
> FIRST, check this task against current reality: it was written on 2026-09-29 against `@etherfold/state-store@0.4.0` / `@etherfold/processor-entities@0.3.1`. If `readSnapshot` already sniffs, or the install no longer streams, do not build on the stale premise: route to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious choice in a `## Decisions` block at the end of your final report. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified bundles.

## Decisions

- **The peek wrapper is a fresh `ReadableStream` over the source's reader, not a `tee` or a buffered prefix.** It reads chunks until it holds two bytes (so a 1-byte-chunk source costs two reads), re-emits those chunks first, then pulls the rest on demand with `highWaterMark: 0`, and its `cancel` forwards to the source reader. A `tee` would keep an unread branch buffering the whole body.
- **Cancel through the inflate stage is asynchronous, so the tests wait for it.** Through `pipeThrough(DecompressionStream)` the cancel reaches the source on the pipe's next turn, after `reader.cancel()` resolves. That was already true of the opaque path before this change. The node test waits with a bounded `vi.waitFor` (1 s), the browser case polls for up to 2 s. A mutation check (the wrapper's `cancel` made a no-op) turns both node cancel cases red.
- **An empty or one-byte body is treated as not gzipped.** It then reaches the line reader, finds no format-2 head, and is refused as `SnapshotFormatError` (`unreadable-format`), as before.
- **A real-browser spec was added** (`packages/browser/browser/aSnapshotServedEitherWayInstalls.spec.ts`, with its own small cut `snapshotDelivery.cut.ts` rather than another case in the 2,400-line `cut.ts`). It runs the engine's own `DecompressionStream` and real IndexedDB on all three engines: both deliveries, both in 1-byte chunks, the double-gzip refusal, and cancel reaching the source each way. It does not drive a real `Content-Encoding: gzip` response header: it hands the reader the inflated bytes, which is what a runtime delivers after undoing the header, and the header itself is invisible to a script.
- **The acceptance "memory and IndexedDB stores at least" is covered on all four backends** (memory, sqlite, indexeddb under `fake-indexeddb`, patch) in `processor-entities/test/snapshot-bootstrap.test.ts`, through `openAndBootstrap` with a `fetch` override each way; plus real IndexedDB in the browser spec.
- **Only `@etherfold/state-store` has a changeset (patch).** The processor-entities and browser changes are tests only, and the guide is not a package.
