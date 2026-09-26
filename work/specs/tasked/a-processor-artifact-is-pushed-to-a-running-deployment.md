---
title: 'A processor is DEPLOYED to a running node by UPLOAD, as with The Graph'
slug: a-processor-artifact-is-pushed-to-a-running-deployment
taskedAfter: [a-processor-is-a-bundle-and-its-hash-is-its-identity, a-generation-retains-the-code-that-folds-it]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **REVISED 2026-09-22, before tasking.** This spec began as the receiving route alone, deferred until "a deployment exists that the developer's build cannot write to", and its first motivating case was a Cloudflare Worker. The maintainer un-deferred it for UX rather than reachability, targeting The Graph's deploy experience, and the Worker case was ruled out by measurement (ADR-0091). It now covers the SENDER, the ROUTE, the CONTRACT MATCH and a NODE THAT WAITS for its first upload. The decisions are ADR-0085's amendment of 2026-09-22 and ADR-0093. The slug is kept because other documents cite it.

## Problem Statement

A processor reaches a running Node deployment today by being RE-READ from disk: the process re-resolves its configuration and re-loads its module. That makes both development and deployment awkward. In development, trying a change means putting a file where the process can see it and poking it; in deployment, it means shipping a new image and restarting. The Graph does neither: a developer uploads a build to a running node, and the node indexes the new version beside the live one before switching. etherfold already does that second half (a new processor registers as a `successor`, and `on-catch-up` moves the pointer once it has caught up), so what is missing is the first half: getting the bytes there.

A processor is a self-contained bundle whose hash is its identity (ADR-0086), and since code retention (ADR-0092) a Node deployment stores those bytes and can run a generation from them. The bytes exist, they are addressable, they survive a restart, and nothing carries them to a running node.

## Solution

A command on the author's side UPLOADS an already-built bundle to a running node over the admin credential, and an admin route on the node accepts it and registers the generation it names beside the incumbent, exactly as the re-read arrival already does. From there everything is existing machinery: the incumbent keeps answering, the successor catches up, and the promotion policy moves the pointer.

Four properties make it The Graph's shape rather than a file drop:

- **The sender only uploads.** It does not build; bundling is the author's (ADR-0085's amendment).
- **An upload carries its own contracts**, through the existing route by which a processor module supplies its contract data, so a node learns WHAT to index from the same artifact that says HOW. Where the node already knows its source, the two must MATCH, and a mismatch is refused by name.
- **A pushed processor survives a restart**, because its bytes are stored (ADR-0092).
- **A `run` node may start with nothing configured** and wait for its first upload (ADR-0093).

What makes the three arrivals (re-read, upload, HMR in a tab) ONE feature is that they answer the SAME three outcomes in the same shape (`registered`, `unchanged`, `failed`) and say which arrival produced it.

## User Stories

1. As a processor author, I want ONE command that uploads a built bundle to a running node and reports what happened, so that deploying is a command rather than a file placement and a restart.
2. As a CI system, I want that same command to be non-interactive and to exit non-zero on any refusal, so that a pipeline can deploy and fail loudly.
3. As an operator, I want a pushed artifact that is not self-contained to be REFUSED with the reason, so that a bare specifier fails at the push instead of at the first event it folds.
4. As an operator, I want the push BOUNDED in size and stating its content type, so that this endpoint cannot be used to exhaust the process.
5. As an operator, I want a pushed processor that fails to evaluate to leave the deployment exactly as it was, with nothing partial registered, exactly as a failed re-read already does.
6. As an operator, I want an upload whose contracts do not match the source my node already indexes to be REFUSED by name, so that a processor never folds contracts it was not written for.
7. As an operator, I want the three arrivals to report the SAME three outcomes in the same shape, so that a watcher branches on one contract rather than three.
8. As an operator, I want to know WHICH arrival registered a generation, so that "the endpoint says unchanged" and "HMR handed us the same module" are distinguishable in a log.
9. As an operator, I want the push to sit on the same credential and the same refusal shapes as the other admin routes, so that there is one authorisation story and not a second one invented for this verb.
10. As an operator, I want a processor I uploaded to still be running after the node restarts, so that the upload is a deployment and not a session.
11. As an operator, I want to start `etherfold run` with no processor and no source and have it WAIT for its first upload, saying so on `/status` and answering reads with "no generation yet", so that I can stand a node up once and deploy to it afterwards.
12. As an operator, I want an uploaded processor to be promoted by the node's existing promotion policy once it has caught up, so that deploying a new version never serves a half-built state.

## Detail moved

Tasked on 2026-09-26 into `every-arrival-names-itself-in-its-outcome`, `a-processor-bundle-is-uploaded-to-a-running-node`, `an-upload-command-sends-a-built-bundle`, `a-run-node-with-nothing-configured-waits-for-its-first-upload` and `an-uploaded-processor-survives-a-restart`. The implementation decisions moved to ADR-0085 (its section of decisions relocated from this spec) and the testing detail to those tasks.

## Out of Scope

- **Bundling.** The author builds the bundle; a later command may take that on under a name other than `build`.
- **Watching files.** Re-running the command is the dev loop; a watcher is the author's dev setup, not this spec's.
- **A split deployment changing what its fetcher fetches.** Its fetcher is another process (ADR-0003, ADR-0093).
- **Cloudflare Workers**, which cannot instantiate a processor from bytes at all (ADR-0091).
- **The browser arrival**, already built as HMR.
- **WASM** and sandboxing, which ADR-0085 records why it declines.
