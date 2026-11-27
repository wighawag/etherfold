---
title: The trigger service's registrations proven with delegated-identity's Ed25519 keys and the new publication
slug: triggers-ed25519-delegated-identity
blockedBy: []
covers: []
needsAnswers: false
---

## What to build

Move `@etherfold/triggers`' `delegatedIdentityVerifier` (and its Node.js platform) to `delegated-identity` 0.2.0 (its spec `ed25519-keys-in-the-publication`): the wallet's publication now names an Ed25519 signing key and an X25519 encryption key instead of the secp256k1 origin key, and requests are signed with the Ed25519 key, the signature header naming its key.

Prerequisite: `delegated-identity` 0.2.0 released (check with `npm view delegated-identity@0.2.0 version`; if it prints nothing, stop and route the task to needs-attention).

- A registration's body carries the key set (both tagged public keys) beside `address`, `domain` and `ownershipSignature`, exactly as push-notification-server's `/register` will (its task `ed25519-delegated-identity`), so one client shape serves both.
- The verifier uses the new stateless `verifyRequest` with the claimed `address`; the app origin is passed explicitly. It stays one verifier per app (a process serving several apps builds one per app, as since `one-etherfold-triggers-process-serves-several-apps`).
- The once-only rule (a signed request accepted once until it expires) names a request by the envelope bytes the key signed (hashed with SHA-256), not by the signature and no longer by a keccak of the EIP-191 message.
- A changeset for `@etherfold/triggers` (and the Node.js triggers platform if it changes), as the repo's `verify` checks them.
- Tests, test utilities (`test/utils/identity.ts`) and the README updated. No compatibility with the old proof: there is no production app (the human, 2026-11-27).

## Acceptance criteria

- [ ] A registration proven with the new key set and publication is accepted; another key set, address, app, route or body, a replay within the window, and an old-format signature are refused
- [ ] The same client body registers at push-notification-server and at the trigger service
- [ ] No code path recovers a secp256k1 request signature any more
- [ ] Tests cover the new behaviour (mirror the repo's existing test style)

## Blocked by

- None in this repo; `delegated-identity` 0.2.0 (above).

## Prompt

Adopt `delegated-identity`'s new wire (why: missiv's `docs/adr/0004-messaging-keys-one-ciphertext-server-checked-signatures.md`). The verifier is `packages/triggers/src/identity.ts`, used by `registration.ts` and the Node.js triggers platform. Apps that register triggers, such as jolly-roger's `with/push-notifications`, change after this release (etherplay-connect's `plans/ed25519-keys-in-the-publication.md`, "Order of work").

FIRST, check this task against current reality (it is a launch snapshot and may have drifted): does it still match the code and the specs and plans it names? If a prerequisite landed differently than assumed, route the task to needs-attention with the discrepancy instead of building on a stale premise.

RECORD non-obvious in-scope decisions you make while building (an ADR if it meets the ADR gate in `work/protocol/ADR-FORMAT.md`, otherwise a JSDoc at the choice site or a `## Decisions` block for the done record).

Command cost: bound exploratory shell commands (`timeout 30`, cap output with `head`), never run an unbounded regex over minified, bundled or generated files, and never `grep -r` through `node_modules`, `dist` or `.git`.

Done means: the acceptance criteria hold and `dorfl.json`'s `verify` passes (the repo's `verify` in `dorfl.json`).

---

### Claiming this task

```sh
dorfl claim <slug> --arbiter <remote>
git fetch <remote> && git switch -c work/<slug> <remote>/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/<slug>.md work/tasks/done/<slug>.md
```

## Applied answers 2026-11-27

### q1: 'task:triggers-ed25519-delegated-identity' was bounced — how should we proceed?

Re-scope (approved by the human, 2026-11-27): the prerequisite now exists. `@push-notification/server`, `@push-notification/cli` and `@push-notification/client` 0.3.0 are on npm and read delegated-identity 0.2.0's proof; their `/register` and `/unregister` body carries the key set as `keySet: {signing: {publicKey}, encryption: {publicKey}}` (untagged 0x hex, a delegated-identity `PublicKeySet`) beside `address`, `domain` and `ownershipSignature`. Use the same field name and shape in the trigger service's registration body. Raise `@push-notification/cli` (and `@push-notification/server` where used) to ^0.3.0 beside `delegated-identity` ^0.2.0, so the suites register the same identity at the in-process push server and at the trigger service. Keep the "same client body" criterion. `@etherplay/connect` 0.19.0 is not released yet; it will hand the account's key set out as `keySet`.

## Decisions

- **Once-only key is the SHA-256 of the envelope only, without the public key.** I chose this because the body names the key set and the envelope covers the body's hash, so the envelope already binds the key. The task asks for exactly "the envelope bytes ... hashed with SHA-256". The alternative was to prefix the public key as the old keccak key did; it adds nothing. This affects only the replay store's keys, and there is no stored state to migrate.
- **SHA-256 comes from `delegated-identity/ed25519`, not `node:crypto`.** That keeps `@etherfold/triggers` platform-neutral, since this function falls back to `@noble` where WebCrypto is missing. The alternative was `crypto.subtle.digest` directly. This affects only `identity.ts`.
- **The app origin passed to `verifyRequest` is the configured domain's normalised origin** (lower-case, no trailing slash), not the body's `domain` passed as it is the way push-notification-server does. This keeps the existing one-app check. The two only differ for a client that spells its domain non-canonically, so the canonical bare-host or origin form gives one body that works at both servers. The alternative was to mirror push-notification-server exactly, which would drop the normalisation of the operator's configured `domain` that the existing tests require.
- **Changeset levels:** `@etherfold/triggers` is a minor because its wire breaks. `@etherfold/platform-nodejs-triggers` is a patch because only its dev dependency, tests and README changed.
