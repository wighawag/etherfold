---
title: 'A processor BUNDLE is uploaded to a running node over the admin route, and registers beside the incumbent'
slug: a-processor-bundle-is-uploaded-to-a-running-node
spec: a-processor-artifact-is-pushed-to-a-running-deployment
blockedBy: [every-arrival-names-itself-in-its-outcome, status-says-when-the-canonical-generation-is-frozen]
covers: [3, 4, 5, 6, 9, 12]
---

## What to build

The RECEIVING half of the upload. A running `run` node accepts a processor bundle's BYTES on an admin route and registers the generation they name as a `successor` beside the incumbent, exactly as the re-read arrival does. From there everything is existing machinery: the incumbent keeps answering, the successor catches up, and the promotion policy moves the pointer.

**Everything that can refuse happens BEFORE anything is registered**, and each refusal leaves the deployment exactly as it was:

- **Credential.** The existing `ADMIN_TOKEN` guard on `/{indexer}/admin/*`, with its existing `401` shape. No second credential and no second authorisation story (ADR-0057).
- **Size and content type.** A stated upper bound on the body and a stated content type, both enforced, because an unbounded body on an authenticated route is still a way to exhaust a process.
- **Self-containment.** A bundle that still imports something is refused with the reason, using the repository's one definition of self-contained (the check the artifact loader and `readProcessorPath` already share). Do not write a second one.
- **Evaluation.** A bundle that throws while evaluating, or carries no processor, is refused. This is the case to drive hardest: "nothing partial is registered" is what distinguishes refusing before registering from unwinding after.
- **Contract match, ONLY against a source the operator configured.** An upload always carries its own contracts, through the route by which a processor module already supplies its contract data (`resolveSource`). The maintainer decided on 2026-09-26 that a source changes LEGITIMATELY, in development and in production alike: a new event ABI a new handler needs, or an upgraded contract with new events. So:
  - Where the node was STARTED WITH AN EXPLICIT SOURCE (`--deployments` or `INDEXING_SOURCE`), the upload's resolved source must MATCH it, and a mismatch is refused BY NAME (what the upload carries against what the node was configured with). "Match" means the same resolved source, which is the source half of the stream digest: same chain, same contracts, same events, same start block.
  - Where the node's source came from its processor module (no explicit source), an upload carrying DIFFERENT contracts is NOT refused. It registers a successor on its new stream exactly as a re-read after a filter change does today, with the same consequences for the incumbent and the fetcher (a filter change is a successor on a new stream; see `aChangedContextCreatesASuccessor`).
  - The disk path's precedence (a configured source overrides a module's contracts) is NOT changed by this task.
  - ADR-0093's Consequences say an upload is refused where "a node has a known source"; that text never described code, so correct it IN PLACE to "a source the operator configured at start" and say in the ADR that it was corrected and why (ADR-FORMAT's rule for text that never described code).

**Bytes naming a generation that is registered but not held** (the `predecessor`, as a rollback by upload, or a frozen canonical generation) behave exactly as a re-read of the same identity does, and that behaviour is asserted for the `predecessor` case.

**The identity is computed by the receiver from the received bytes and never taken from the sender** (ADR-0086). Registration goes through the SAME path every Node registration takes, which stores the bytes on the generation's row (`a-generation-keeps-the-bundle-that-folds-it`); there must be no second route to the store. The response is the shared three-outcome report with the upload's arrival value (`every-arrival-names-itself-in-its-outcome`): `registered` when a new generation was added, `unchanged` when the bytes name a generation the node already folds, `failed` with the reason otherwise.

**Scope.** The route is served where the re-read route is served today (`run`, the combined shape). A split deployment's `index` accepting matching uploads is ADR-0093's "later" and is not this task's. A node with nothing configured is `a-run-node-with-nothing-configured-waits-for-its-first-upload`'s; here the node always has a processor and a source.

## Acceptance criteria

- [ ] **The round trip, end to end:** a running node folding one bundle receives a second over the route; the new generation is registered as `successor` beside the incumbent, the incumbent answers reads throughout, and under `on-catch-up` the pointer moves once the successor has caught up. The uploaded generation's stored bytes are the uploaded bytes.
- [ ] Uploading bytes the node already folds answers `unchanged` and registers nothing.
- [ ] Each refusal is its own case, answers with a stated status and reason, and leaves the registry, the slots and the held folds unchanged: missing or wrong credential, a body over the bound, a wrong content type, a bundle that is not self-contained, a bundle that throws on evaluation, and contracts that do not match a source the node was STARTED with.
- [ ] On a node started WITHOUT an explicit source, an upload carrying different contracts is registered as a successor on its new stream, not refused.
- [ ] Uploading the bytes of the `predecessor` behaves as a re-read of that identity does, asserted.
- [ ] ADR-0093's "known source" sentence is corrected in place as described above.
- [ ] The identity is the receiver's hash of the bytes; nothing the sender says about identity is read.
- [ ] Every outcome names the upload as its arrival.
- [ ] Uses the committed real bundle fixtures (`packages/cli/test/fixtures/processor-bundle/`) for anything that must evaluate; synthetic bytes elsewhere; no test gains a bundler step. Both existing bundles carry the SAME contracts, so add ONE more committed real bundle carrying DIFFERENT contracts (built once with the fixtures README's command and documented in that README), plus, if needed, small committed non-self-contained and throwing fixtures. Later tasks reuse them.
- [ ] Neither ADR-0085's nor ADR-0093's status line is touched (see `every-arrival-names-itself-in-its-outcome` for the owners). ADR-0085 IS where this route's own decisions (size bound, content type, where it lives) are recorded if they need an ADR.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

- `every-arrival-names-itself-in-its-outcome` -- the outcome this route answers names its arrival.
- `status-says-when-the-canonical-generation-is-frozen` -- both edit the server's admin API module, so they are serialised.

## Prompt

The goal is The Graph's deploy experience on a Node deployment: bytes go to a running node, and the node indexes them beside the live version before switching.

Read ADR-0085 with its 2026-09-22 amendment and its section of decisions relocated from the upload spec, then ADR-0086 (identity is the hash of the bytes), ADR-0092 (a Node generation's bundle is stored on its row, and how stored bytes become a fold), ADR-0093 (the match rule for uploads), and ADR-0057 (why this is an admin route on its own credential). ADR-0091 is why a Cloudflare Worker is not a target.

The seams: the server's admin API (where the pointer move and the re-read route live, and their refusal shapes), the CLI's reconfigurer (the re-read arrival, which is the closest prior art for "register a new generation beside the live one and report the outcome"), the artifact loader in `@etherfold/utils` (`loadProcessorArtifact`, which already answers refusal as data), the contract resolution from a processor module (`resolveSource`; `loadContracts` reads a deployments folder or file), the CLI configuration input that says whether a source was given explicitly, and the receiving container's `add`. The CLI suite `anEndpointReconfiguresARunningRun` and the server suite `aReconfigureReachesARunningDeployment` are the test shapes to mirror.

The decisions most likely to be got wrong: registering first and unwinding on failure, instead of refusing before registering; and refusing a changed source on a node that never configured one, which would block the ordinary "add an event" or "contract upgraded" deploy.

Done means: an operator can upload a bundle to a running node, watch it catch up beside the incumbent and be promoted, and every refusal leaves the node exactly as it was.

FIRST, check this task against current reality: its blocker will have landed, and the retention chain (ADR-0092) landed before this was written. If the registration path, the stored-bytes port or the report type differ from what this assumes, route to needs-attention with the discrepancy.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in particular the size bound, the content type and the status codes. Do not write the done record, the commit message or the PR body yourself.

## Decisions

- **Route path `POST /{indexer}/admin/upload`.** I named it after the arrival value (`upload`), beside `reconfigure`, under the existing `ADMIN_TOKEN` guard (ADR-0057). The alternative was `/admin/processor`. `an-upload-command-sends-a-built-bundle` will send to this path.
- **Content type `text/javascript`, required.** It is the registered type for an ES module (RFC 9239, which makes `application/javascript` obsolete). Only the media type is compared, case-insensitively; parameters such as `charset` are ignored, because the identity is over the raw octets. `application/octet-stream` was the alternative. A missing or different type answers `415 upload-wrong-content-type`. The sender task must send this header.
- **Size bound 16 MiB, inclusive, a constant (`MAX_UPLOAD_BYTES`).** That is generous for a minified processor that bundles viem, and bounded even after the loader base64-encodes the bytes. I did not make it a configuration input, because that would add a row to ADR-0048's table that nobody has asked for. Over the bound answers `413 upload-too-large` with `limit` in the body. Recorded in ADR-0085's new section.
- **Status codes.** `200` for `registered` and `unchanged`; `409 upload-failed` for every `failed` (not self-contained, throws on evaluation, no processor or no contracts, source mismatch, cap reached); `501 upload-not-held` when the host can't take uploads. `409` mirrors the re-read so a sender maps outcome to status the same way for both arrivals. `422` was considered for "the bytes are bad", but it would split one outcome across two statuses. The `413` and `415` bodies also carry `arrival: 'upload'` and `outcome: 'failed'`, because they are refusals of this upload. The sender task's exit codes depend on this mapping.
- **"Match" means equal stream digests under the node's one stream config.** That compares chain, contracts, events and start blocks, and nothing else. The configured source compared against is the one resolved at start; it is not re-read per upload, since an upload changes only the processor and its contracts.
- **The successor is registered on the upload's own source,** even where it matched a configured source: the two produce the same stream digest, and the upload's ABI is the one its handlers decode against. The disk path's precedence (a configured source overrides the module's) is unchanged.
- **One queue shared by the re-read and the upload** (`arrivalQueue`, exported). `reconfigurerFor` takes it as an optional second argument, so the public signature is unchanged for existing callers.
