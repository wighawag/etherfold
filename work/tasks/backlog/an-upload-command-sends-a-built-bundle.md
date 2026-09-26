---
title: '`etherfold upload` sends an already-built bundle to a running node, and exits non-zero on any refusal'
slug: an-upload-command-sends-a-built-bundle
spec: a-processor-artifact-is-pushed-to-a-running-deployment
blockedBy: [a-processor-bundle-is-uploaded-to-a-running-node]
covers: [1, 2]
---

> **FORWARD-POINTER, 2026-09-26 (conductor, after Gate 3 on PR #198).** Two things the route task left for this one:
>
> 1. **The route as it landed** (ADR-0085, section "The upload route as built, 2026-09-26"): `POST /{indexer}/admin/upload`, raw bundle octets, `Content-Type: text/javascript`, bound 16 MiB (`MAX_UPLOAD_BYTES` / `UPLOAD_CONTENT_TYPE` exported by `@etherfold/server`). `200` for `registered` / `unchanged`; `409 upload-failed` for every `failed`; `413 upload-too-large`, `415 upload-wrong-content-type`, `401` from the admin guard, `501 upload-not-held`. Build against that.
> 2. **CONTEXT.md's `generation` entry** (not only the command-set entry) still says the pushed arrival "is decided and tasked" and, of the re-read route, that "a processor is code and cannot cross HTTP". With this task the arrival is complete: correct both in the same change (the re-read takes no body because it is a trigger; the code itself now arrives as BYTES by `upload`, ADR-0085), and name the route and the command there.

## What to build

The SENDER half of the upload: a new CLI command, **`upload`** (named by the maintainer, 2026-09-26), that takes a bundle path, the target node's URL, the named indexer and the admin credential, uploads the bytes to the route `a-processor-bundle-is-uploaded-to-a-running-node` built, and reports what happened.

- **It only uploads; it never builds.** Bundling is the author's (ADR-0085's amendment). The name `build` is taken by the one-shot fold-to-completion command, and `deploy` is deliberately left free for a later build-and-upload command.
- **It checks self-containment LOCALLY first**, with the check that already exists (the one `--processor` configuration resolution uses to refuse an unbundled entry point), so the commonest mistake fails on the author's machine with the same actionable message rather than at the node.
- **Its inputs, decided by the maintainer on 2026-09-26.** The target is **`--to <url>`**, with its own environment variable. It must NOT reuse or alias `-n, --node-url` / `ETH_NODE_URI`, which already means the CHAIN's JSON-RPC endpoint on every other command. The named indexer is **`--indexer`** (with `INDEXER_NAME` as on the other commands) and is REQUIRED here, never defaulted: `run` defaults it to `default`, but a defaulted indexer on the sender would upload to the wrong one silently. `upload` enters the configuration ownership table like the other commands, with every input it does not take refused as they refuse theirs.
- **It is non-interactive and CI-safe.** Inputs come from flags and the environment in the shape every other command takes them (ADR-0048: a missing required input is refused, never defaulted). The credential is `ADMIN_TOKEN`, as the node's guard names it. Exit `0` on `registered` and `unchanged`, non-zero on `failed` and on every refusal (including an unreachable node and a `401`), with the node's reason printed.
- **It prints the outcome** the node answered: which outcome, which generation, and which arrival.

**The verb set.** This is a SIXTH top-level command, and several durable documents say there are five:

- ADR-0057 rejected a sixth verb for the REVERT partly because "the command set is pinned at five verbs with no default command". Add a dated amendment (`## Amendment, 2026-MM-DD (ADR-0085): ...` plus a pointer under the title) saying the set grew by `upload` and why that does not reopen the revert question (the revert still has to reach a Worker, which only HTTP does).
- ADR-0048 says the inputs of "all five commands" live in one table. Add a dated amendment for the sixth.
- `CONTEXT.md`'s command-set entry says all five names exist and calls them deployment INTENTS. `upload` is a client action against a running node rather than a way to run one; say so there, so the glossary stays coherent.
- The server admin API's header JSDoc repeats "pinned at five verbs ... a sixth is unavailable". Correct it.

## Acceptance criteria

- [ ] `etherfold upload` against a running node registers the bundle, prints the outcome, and exits `0`, asserted end to end against a real `run` over the same fixtures the route task uses.
- [ ] `unchanged` exits `0` and says so.
- [ ] A non-self-contained bundle is refused LOCALLY before any request is made, with the existing refusal's message, and exits non-zero.
- [ ] Each node-side refusal (wrong credential, over the bound, throws on evaluation, contract mismatch) and an unreachable node exit non-zero with the reason printed.
- [ ] A missing bundle path, `--to`, `--indexer` or credential is refused by name, never defaulted; `--node-url` / `ETH_NODE_URI` is refused as an input `upload` does not take.
- [ ] The command appears in the CLI's help and README beside the other five.
- [ ] ADR-0057 and ADR-0048 carry dated amendments for the sixth command; `CONTEXT.md`'s command-set entry and the admin API's header JSDoc no longer say five.
- [ ] Neither ADR-0085's nor ADR-0093's status line is touched (owners: `an-uploaded-processor-survives-a-restart` and `a-run-node-with-nothing-configured-waits-for-its-first-upload`).
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

- `a-processor-bundle-is-uploaded-to-a-running-node` -- the command sends to that route.

## Prompt

The goal is that deploying a processor is one command, the same on a laptop and in CI.

Read ADR-0085 with its 2026-09-22 amendment and its section of decisions relocated from the upload spec, ADR-0048 (how every command takes and refuses its inputs), and ADR-0057 (the admin credential, and the verb-set reasoning you are amending). The upload route's done record says what it answers and with which status codes.

The seams: the CLI's command program (where the five commands are declared), its configuration resolution (the input shape, and the self-containment refusal to reuse), and the upload route. The CLI suites that stand up a running node and poke its admin surface are the test shape to mirror.

The decision most likely to be got wrong is exit codes: a CI pipeline must fail loudly on every refusal and must not fail on `unchanged`. The second is re-implementing the self-containment check.

Done means: `etherfold upload ./dist/processor.js --to <url> --indexer <name>` deploys, and anything short of a registration or an honest `unchanged` fails the pipeline.

FIRST, check this task against current reality: the route will have landed. If its request or response shape differs from what this assumes, build against what landed and record it; if the difference is a design disagreement, route to needs-attention.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in particular the flag and environment names and the exit codes. Do not write the done record, the commit message or the PR body yourself.
