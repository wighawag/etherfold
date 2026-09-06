---
'@etherfold/server': minor
'etherfold': minor
---

A REBUILD IN PROGRESS is never an empty answer: it is VISIBLE on `/status`, and a read that would otherwise lie REFUSES.

"Nothing here yet" and "this is still being built" must not arrive in the same shape — the same absence-versus-contradiction discipline the reorg model and `SuspectedTruncationError` already keep. Two surfaces, no new endpoint, and no new top-level field.

**`/status` grows the GENERATION DIMENSION inside the `cursor` envelope, exactly where ADR-0047 reserved room for it.** A host's reporter now hands over the envelope's TWO SLOTS explicitly (`StatusReport`): `value`, where the generation that answers reads has got to, and `generations`, one entry per generation the host holds.

```
GET /status
{"healthy": true, "cursor": {
  "reported": true,
  "value": {"lastFromBlock": 4200, "lastToBlock": 4242, "latestBlock": 4250, "unconfirmedBlocks": 3},
  "generations": [
    {"generation": "9f…", "canonical": true,  "follows": false, "value": {"lastToBlock": 4242, …}},
    {"generation": "3c…", "canonical": false, "follows": true,  "value": {"lastToBlock": 1200, …}}
  ]}}
```

- **An entry is `{generation, canonical, follows, value?}` and the server fixes every field but the last.** `generation` is the same OPAQUE digest the feed advertises (compared, matched against the admin listing, never parsed); `follows` is the established word for a generation advanced by a REBUILD over the stored stream rather than by the wire (ADR-0044), so `value` on such an entry IS how far its rebuild has got — its own sync cursor, which is the rebuild's only durable checkpoint (ADR-0056). Fixing the shape is also what finally makes the SIZE bound structural: the only free-form part left is `value`, which owes exactly what the top-level `value` owes.
- **`reported` keeps its exact meaning — is there a CURSOR — and `generations` sits beside it on both branches.** A FIRST BUILD is what makes that load-bearing: it holds a generation and has folded nothing, so it has generations to report and no cursor, and folding the two together would throw away the half that says what is being built. A generation whose cursor cannot be read yet is reported with NO `value` rather than dropped from the listing or zeroed (a zero reads as "synced to block 0").
- **A host that injects no reporter still carries no `cursor` field at all**, and a reporter that throws, rejects, returns nothing or hands over something unserialisable still degrades the whole envelope to `{reported: false, reason}` without failing the request or changing `healthy`.

**BREAKING for a host that injects a reporter**: `getCursorReport` now returns `{value, generations?}` instead of the report itself, so `() => readCursorReport(store)` becomes `() => ({value: await readCursorReport(store)})` — or, on this repo's CLI, `readStatusReport({folds, canonical})`. The two slots are named explicitly rather than sniffed for, because `value` is reported VERBATIM and a host is free to put a key called `generations` inside it; inspecting the reported value to decide which shape it was is precisely the parsing ADR-0047 forbids.

**A READ against a named indexer with NO CANONICAL GENERATION is REFUSED with `503 no-canonical-generation`, never answered as an empty page (ADR-0058).** Both feed views resolve the pointer through ONE place below the routes (`resolveCanonicalGeneration`), so there is one answer to "which generation answers this read" and one refusal when none does — and a surface added later (a read tier answering over a database written elsewhere) inherits it rather than having to remember it.

```
GET /alpha/feed
503 {"success": false, "error": "no-canonical-generation", "indexer": "alpha", "building": ["3c…"], "message": "…"}
```

- **Why it cannot be a `200`**: a read against a name whose pointer names nothing finds no rows and would answer an empty page with `hasMore: false` — byte-identical to "you are caught up". That is ADR-0015's rule on the read side: a consumer holding an unresolvable address is TOLD, never served an answer it cannot tell apart from a true one.
- **Why `503`**: nothing about the request is wrong (not the `400` family), the name resolved (not the `404`), and the host CAN serve feeds (not the `501` a host with no registry answers). What is true is that this indexer cannot answer YET, and a caller that retries once a generation is canonical will be served.
- **What it does NOT refuse** is a canonical generation that has folded little or nothing. The question is WHICH generation answers and never how far it has got; a rebuilding generation is never the one answering, because the pointer moves at the END of a rebuild.
- `IndexerRegistryEntry.canonicalGeneration()` may therefore answer `undefined`, and the admin route REPORTS that state (`canonical` absent, the generations still listed) rather than refusing it — which is the right way round: a read served from nothing is a wrong answer, while "nothing answers reads yet, and here is what is registered" is what an operator opened that route to see.

**`readStatusReport` (`etherfold`)** is the reporter the folding commands now inject: one cursor read per generation, nothing computed on demand, and the canonical generation's answer reused as the top-level `value`. `run` and `index` hold ONE fold and report it as one generation, so the shape of `/status` does not depend on how many a deployment happens to hold; `readCursorReport` is unchanged and still summarises one store.
