---
status: superseded in part by ADR-0037
---

# A published blob snapshot's format number lives in `@etherfold/core` beside its codec, and a client that cannot read the file refuses that mirror

> **Which half is retired, because only one of them is.** The MECHANISM is gone: ADR-0037 retired the free-form JS-object path, and the blob snapshot envelope this ADR put a format number on went with it. `BLOB_SNAPSHOT_FORMAT` and `isReadableBlobSnapshot` no longer exist in `@etherfold/core`; the only surviving mention of either is a doc-comment in `packages/state-store/src/snapshot.ts`, which explains why the ENTITY envelope's constant keeps its qualified name now that it is the only format number left.
>
> The STANCE is untouched, and it is the half that gets cited: **an artifact a client cannot read is REFUSED rather than installed, and the refusal is returned as DATA a host acts on rather than thrown.** ADR-0064 builds its seed-refusal rule on it ("following ADR-0040's refused-not-installed stance") and rejects throwing on the ground that it "contradicts ADR-0040"; ADR-0065 calls it "the stance ADR-0040 settled"; and the shape it names, `bootstrapFromSnapshot`'s `NotBootstrappedReason`, is still the vocabulary those refusals use. The filename says the stance rather than the mechanism, which is why it still reads true.
>
> So: read this ADR for the rule, and do not go looking for the symbols.

The free-form path's snapshot file has ONE writer (`@etherfold/cli`'s keeper) and TWO readers (the CLI itself, and `keepStateOnIndexedDB` in `@etherfold/browser`, which downloads it to hydrate a tab). The format number that says which BigInt convention the bytes are in used to live with the writer, where the browser could not import it — the browser package must stay bundleable for a tab (`bundlesForABrowser.test.ts`), and the CLI is a node deployable — so the CLI refused a format-1 file locally while the browser installed the same bytes, and, with ADR-0029 having removed every fallback reviver, every `uint256` in `lastSync.unconfirmedBlocks[].events[].args` arrived as the string `"123n"` instead of a BigInt. The client then indexed on top of silently mistyped state: the exact plausible-wrong-answer failure the tagged codec exists to prevent, arriving through the one door left unwatched.

## The decision

`BLOB_SNAPSHOT_FORMAT` (and `isReadableBlobSnapshot`, the shallow readability check) lives in `@etherfold/core` (`src/snapshot.ts`), beside the codec the number versions. Both packages already depend on core; core is browser-bundleable; and one number imported by the writer and every reader is the only arrangement in which the check can exist on the reading side at all. A second constant in the browser kept in step with the CLI's by attention is the outcome this placement exists to avoid, and `@etherfold/browser` depending on `@etherfold/cli` is not an outcome at all.

## One constant PER ENVELOPE, named for its envelope

There were already TWO exported symbols named `SNAPSHOT_FORMAT` for unrelated artifacts: the CLI's (= 2, this blob envelope) and `@etherfold/state-store`'s (= 1, the ENTITY snapshot envelope refused with `SnapshotFormatError`). They version different file shapes and revise independently, so they are NOT merged — one envelope's revision must not falsely invalidate the other's — and they are now named so that a call site holding both (`@etherfold/browser` depends on both packages) cannot confuse them: `BLOB_SNAPSHOT_FORMAT` (`@etherfold/core`) and `ENTITY_SNAPSHOT_FORMAT` (`@etherfold/state-store`). No third identifier spelled `SNAPSHOT_FORMAT` is added to the graph.

## What a refusal means, and what it never means

A format this build does not recognise (1, or the bare pre-envelope form that reads as `undefined`) is refused AS A FILE — never translated (the translation IS the guess ADR-0029 ruled out) and never mined for the fields that happen to be recognisable. The refusal is loud: it names the location and both numbers, so a mis-published mirror is diagnosable from the tab. An unreadable mirror is a mirror that cannot serve this client, so it takes the path an unreachable one already takes: it is skipped when it loses selection and failed over from when it wins. Local state that is already ahead still wins over any remote snapshot, readable or not. The recovery ladder is therefore: next mirror, then local state, then a cold start — a cold start alone, which is the CLI's own recovery, is only right when no mirror can serve.

## The unversioned bare `lastSync` file is selection data only

A prefix-form mirror's separate `lastSync` file carries no format (the CLI writes it bare beside the enveloped state file), and it is read WITHOUT a format check, deliberately: the one field used from it is `lastToBlock`, a plain number identical under every encoding of the envelope, and nothing from it is ever installed — the file that IS installed is the state file, which carries the check. Refusing the head instead would make every mirror the CLI publishes unselectable, which is a guard placed where the damage is not. A stale head can mis-order the mirrors; it cannot smuggle an unreadable payload past them.

## Considered and rejected

- **A duplicate constant in the browser** — two numbers kept equal by attention; the browser reader would refuse format 2 the day the CLI shipped 3.
- **`@etherfold/browser` depending on `@etherfold/cli`** — unbundleable for a tab; this is the reason `@etherfold/utils/indexer` exists as a subpath.
- **Merging the blob and entity constants** — one envelope's revision would falsely invalidate the other's.
- **Translating an older format on read** — the guess ADR-0029 removed, under a new name.
- **Converging the free-form failover on the entity path's walk-every-candidate** — left for the free-form path's retirement (`retire-the-js-object-processor-path`), which is blocked by this change; the refusal reuses the failover the path already had.

This closes the gap ADR-0029 recorded as knowingly open, and it lands BEFORE anything is published under `@etherfold/*`, so it is a guard that was always there rather than a breaking correction to a shipped format.