---
title: 'Pin the seam a published stream arrives through, and how it enters a keeper'
slug: pin-the-seam-a-published-stream-arrives-through
spec: a-generation-can-be-seeded-from-a-published-artifact
blockedBy: []
covers: [1]
promptGuidance.testFirst: false
---

## What to build

A DECISION, not a capability: which interface a captured stream arrives through when it is fetched from a URL rather than read off local disk, and what installing it into a stream keeper actually consists of. Everything downstream in this exploration targets whatever this task pins, so it goes first.

Today there is a remote path for STATE and none for a STREAM. The state one is `bootstrapFromSnapshot` in `@etherfold/processor-entities`: it takes a list of locations (a bare URL, or `{url, head}` so a client can compare mirrors before downloading a payload), picks the mirror that got furthest, prefers local state when local is already ahead, fails over rather than dying, refuses a snapshot computed by a different processor version or taken inside the reorg window, and returns its refusals as DATA (`NotBootstrappedReason`) rather than throwing. The stream side has only `loadStreamFixture` in the private conformance workload package, which is `node:fs` plus `node:zlib` over a local path; the format halves (`parseStreamFixture` / `serializeStreamFixture` / `STREAM_FIXTURE_FORMAT`) already live in `@etherfold/core`, which names no runtime.

Three candidate shapes, and the deliverable is a reasoned choice between them, not a survey: (a) a stream loader that MIRRORS the snapshot mechanism's location/head/failover/refusal-as-data shape, (b) a loader of its own with a different shape because a stream's selection question is different from a snapshot's, (c) the stream rides the snapshot mechanism itself.

**The half that is easy to under-decide is the INSTALL, so decide it explicitly.** A fixture is not a keeper and cannot be pointed at as one (ADR-0059): its events are DECODED, while the keeper seam takes only the raw stored event (ADR-0060). So seeding has to WRITE something into the keeper. Pin what: how a fixture's events are reduced to stored events, which stream address they land under (a stream is addressed hierarchically, `['stream', <indexer>, <streamDigest>, <ordinal>]`), how the batch is cut into segments, and what is written BESIDE the segments so the seeded client does not re-scan from the start block (the cursor record holds the block numbers; the server-side stored stream carries a coverage claim, ADR-0055, and a seeded client needs the same fact in whatever form its keeper holds it). Also pin WHERE the loader lives: `@etherfold/core` names no runtime and `fetch` is global in every runtime this repo targets, so a node consumer and a browser one should not need two loaders.

A throwaway spike is in scope and probably necessary, on the narrowest real case only: install the committed `stratagems-alpha1` capture into a keeper and have a generation fold it with no node in the loop, far enough to know the pinned seam is real rather than plausible. The ANSWER is the deliverable; the code stays prototype-quality under `docs/spikes/<slug>/` and nothing under `packages/` changes behaviour.

## Acceptance criteria

- [ ] An ADR in `docs/adr/` names the chosen remote-loading seam for a captured stream, names the alternatives it beat, and says where the loader lives and why that package (not "somewhere in core") can host it. Its number is the next free one at the time of writing, re-checked after any rebase, since `check:adr` is in the acceptance gate and a duplicate number fails it.
- [ ] The decision states, concretely, what INSTALLING a seed writes: how decoded fixture events become stored events, the stream address they land under, how they are cut into segments, and what is written beside them so a seeded client does not re-scan from the start block.
- [ ] The decision says whether it reuses the snapshot path's location/head/mirror-failover shape and its refusal-as-data vocabulary, or introduces its own, with the reason either way.
- [ ] The decision is written against the code AS IT STANDS (see the drift note in the prompt), not against the spec's prose: nothing in it relies on `keepStateOnIndexedDB` or on a fixture satisfying the keeper seam.
- [ ] A spike, if one was run, lives under `docs/spikes/<slug>/` with a README saying what it answered and how to re-run it; it demonstrates the pinned seam on the committed stratagems capture end to end (install, then a fold with no node).
- [ ] No package under `packages/` changes behaviour, and the spike is not wired into any shipped path.
- [ ] The repo acceptance gate is green. `CONTEXT.md` is NOT edited by this task (the `seeding` entry is updated once, by `emit-the-sliced-build-plan-for-seeding`).

## Blocked by

- None. This task can start immediately.

## Prompt

> Pin the interface by which a PUBLISHED captured stream reaches a client and enters a stream keeper, so that the rest of the seeding exploration targets an interface that exists instead of one it assumes. Source spec: `work/specs/tasked/a-generation-can-be-seeded-from-a-published-artifact.md` (an EXPLORATION spec: its done is CONFIDENCE plus a de-risked plan, never a shipped seeding capability). Your deliverable is a DECISION captured in an ADR, plus at most a throwaway spike that proves the decision is real.
>
> FIRST, check this task against current reality; it is a launch snapshot. Two known drifts, both already verified, and you should re-verify rather than trust this paragraph. (1) The source spec's prose says a captured stream might get "the `keepStateOnIndexedDB(name, remote)` treatment the snapshot path already has". That function is DELETED (ADR-0037). Its behaviour lives on as `bootstrapFromSnapshot` in `@etherfold/processor-entities`; read that module and its `SnapshotLocation` / `BootstrapOptions` / `NotBootstrappedReason` types, which are the live precedent. (2) The spec's prose says `replayStream` returns an `ExistingStream`. It does not: `the-stream-stores-only-what-the-node-said` has LANDED, and ADR-0059 makes `replayStream` return a read-only `StreamFixtureReader` that is deliberately NOT the keeper seam, while ADR-0060 declares the keeper seam over the raw `StoredLogEvent` with the decoded half structurally refused. Those two ADRs are the constraint this task must design WITHIN: a fixture cannot be handed to an indexer as its `keepStream`, so seeding necessarily WRITES into a keeper. If you find a third drift that would make the decision rest on a false premise, do not paper over it: route the task to needs-attention with the discrepancy.
>
> Vocabulary you need (see `CONTEXT.md`): a **generation** is a stream plus a fold over it; a **stream** is identified by its **stream digest** (a wide synchronous digest over the deduplicated `streamHash` values sorted by themselves, plus the stream config hash) and is addressed hierarchically as `['stream', <indexer-name>, <streamDigest>, <ordinal>]`; a **segment** is one batch's events, append-only, keyed by ordinal, with the block numbers living once in the cursor record beside the segments; a **coverage claim** (ADR-0055) is how far a stream REACHES, which the rows cannot supply because a quiet range moves the cursor without adding a row. `captureStream`, `StreamFixture`, `STREAM_FIXTURE_FORMAT`, `parseStreamFixture` and `serializeStreamFixture` are in `@etherfold/core`; the file convention (`loadStreamFixture` / `saveStreamFixture`, node-only, gzip chosen by the extension) is in the private conformance workload package, alongside the committed stratagems captures.
>
> Decide three things and say which alternatives you rejected: WHAT the loading interface is (mirror the snapshot path's location list plus optional head, mirror-selection and refusal-as-data, or a shape of its own, or ride the snapshot mechanism outright); WHERE it lives, given that `@etherfold/core` names no runtime while the fixture FILE convention needs `node:fs` and a browser needs none of it; and what INSTALLING actually writes, which is the half that is easy to leave vague and the half everything else depends on. A seed that lands as segments with no cursor record makes a client re-scan from the start block, which forfeits the entire point on a public node that will not serve old logs.
>
> Do NOT decide the wire shape (chunked or not), the verification rule, or the digest-mismatch rule; each is its own task in this spec and pinning them here pre-empts measurements that have not been taken. DO note, in the ADR, which of your choices those tasks could still move.
>
> The next task in this spec MEASURES this install, so leave it something to measure: if you run the spike, keep it runnable and say in its README which part is the install path, and if you do NOT run one, say so in the ADR explicitly so the measuring task knows it has to build a throwaway install itself rather than hunting for one.
>
> A spike is a prototype scoped to ONE question on the narrowest real case, and the ANSWER is the deliverable, never the code. The narrowest real case is the committed `stratagems-alpha1` capture (31,332 logs, 20.5 MB raw JSON, 0.6 MB gzipped). Evidence goes to `docs/spikes/<slug>/` with a README that says how to re-run it; precedent worth copying is `docs/spikes/generation-storage-headroom-in-the-browser/`. Change no production code, and do not let the spike quietly become the implementation, because the source spec puts building the capability explicitly out of scope.
>
> Done means: an ADR that a later author can build from without re-deriving any of this, a spike folder if you ran one, and the acceptance gate green. Do not edit `CONTEXT.md` (a later task in this spec owns that one edit), and do no git operations.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The runner transcribes it into the done record; do not write the done record, the commit message or the PR body yourself, and do not open a `decisions-*` note.
