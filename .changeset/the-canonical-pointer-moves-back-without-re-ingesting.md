---
'@etherfold/core': minor
'@etherfold/server': minor
---

The canonical pointer moves BACK: an operator undoes a bad upgrade with one small write, and the previous generation answers exactly as before, with no re-index and no re-fetch.

**`POST /{indexer}/admin/canonical-generation` (`@etherfold/server`) is the operator's affordance** (ADR-0057), guarded by a NEW `ADMIN_TOKEN` that FAILS CLOSED when unset. Forwards it promotes, BACKWARDS it reverts, and there is deliberately no second verb for the second direction: it is one record write.

```
POST /alpha/admin/canonical-generation      Authorization: Bearer $ADMIN_TOKEN
{"stream": "<stream digest>", "processor": "<version hash>"}
-> 200 {"previous": {...}, "canonical": {"stream", "processor", "digest"}}
```

`GET` on the same path is how an operator learns what there is to point AT: which generation answers reads now, and every generation this name holds, each with the OPAQUE `digest` a feed response advertises it by (compared, never parsed), so the advertised value is matched against the listing rather than taken apart.

**It is an HTTP route because that is the only affordance every deployment shape has.** A Cloudflare Worker is reachable only over HTTP, so a flag on a command could never serve one, and the command set is pinned at five verbs. The CLI inherits the route by hosting the same app.

**`ADMIN_TOKEN` is a SECOND credential and deliberately not `INGEST_TOKEN`.** That one is handed to a log shipper and guards the WRITE path; letting it also decide which generation answers reads would give a fetcher control-plane authority. The two guards now share ONE constant-time comparison (`api/auth.ts`), so "is a token accepted" has one answer rather than two that drift. `POST /admin/setup` is untouched and stays unauthenticated.

**`ReceivingIndexer.promote` no longer requires this host to hold a FOLD for the target** (`@etherfold/core`). Reads on this runtime resolve the pointer to a table NAMESPACE (ADR-0053), so the generation reverted to answers with no engine at all -- which is the ORDINARY case, since a host redeployed with the new processor holds only the new fold. Requiring one would have meant a revert could only be performed by a process first rebuilt with the OLD processor, which is the re-index the design exists to remove. The refusal is now the registry's `UnknownGenerationError` (surfaced as `400 unknown-generation`, naming every generation the name holds) instead of a container-level "holds no fold" error.

**A BACKWARDS move drops NOTHING, under any promotion config.** `ReceivingIndexer` now tracks whether the pointer has EVER named a held fold -- the chain-facing container's `everCanonical` flag, as a set -- and drop-on-promotion applies only to a FORWARD move: a revert supersedes nothing, and dropping what it moved away from would delete the very generation a second move forward wants (ADR-0046).

**`IndexerRegistryEntry` gains two OPTIONAL questions**, `generations()` and `promote(id)`, which `ReceivingIndexer` already answers and `indexerEntryOn` forwards. A host holding one fold and no registry (`singleContextEntry`) answers `501 generations-not-held` on the admin surface: a capability that deployment lacks, not a route that is missing.
