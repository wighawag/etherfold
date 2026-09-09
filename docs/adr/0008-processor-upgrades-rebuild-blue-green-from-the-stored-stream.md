# Processor upgrades rebuild blue-green from the stored stream

When the processor's logic changes but the stream does not (same contracts, same events), the state must be discarded and recomputed, and the old state must keep being served until the new one is ready. The rebuild replays the **locally stored** emission stream into a **new state namespace** keyed by the processor version hash, chunk by chunk, while live indexing continues to write and serve the old namespace. Once the rebuild reaches the stream head, both namespaces are fed for a short window, then a single `current_version` pointer row is flipped atomically and the old namespace is dropped. We chose blue-green because a rebuild takes arbitrarily long and readers must never see partial state.

## Considered Options for driving the replay

A serverless worker cannot run a rebuild as a loop, so it must be chunked against a durable checkpoint and re-invoked:

- **Self-enqueueing via a queue (chosen).** Process a chunk sized to a CPU and statement budget, commit the state chunk and the rebuild cursor in one `batch`, then enqueue "continue from X" to itself. Near-immediate re-invocation, so it runs at full speed as a sequence of short invocations.
- **Cron-driven.** Cloudflare's one-minute minimum granularity makes a multi-million-block rebuild impractical on its own. **Kept as a watchdog**: a tick that restarts a rebuild whose checkpoint has not advanced, so a lost queue message cannot strand a migration.
- **Piggyback on the fetcher's pushes.** Rebuild speed capped at chain speed. Useless for history.
- **External driver** (CLI or container). Works, but adds a second runtime to operate.
- Cloudflare **Workflows** is a legitimate managed alternative to the hand-rolled queue loop. The design should name it without depending on it.

## Consequences

- The rebuild is a **local sequential scan**, not a re-fetch from the chain or across the wire, which is a direct benefit of the stream living next to the state (ADR-0003, ADR-0006).
- The double-write window between catch-up and the pointer flip is short and cheap; rollback before the flip is free.
- **Retention becomes load-bearing.** A rebuild needs the stream from genesis, so pruning the stream is what makes processor upgrades impossible. This is the main argument for pair-compaction being off by default.
- **`getVersionHash` becomes load-bearing in a way it was not.** It is author-maintained today, and the processor's construction-time configuration is not part of it (`docs/reviews/server-cli-batch.md`, HIGH-2 and MEDIUM-3). Previously a missed bump meant reusing a stale snapshot. Now it means the rebuild **never triggers**, so state computed by logic that has already been replaced is served indefinitely, with no cold start to rescue it.

### Amended 2026-08-21: the hash is not derived from the bundle, and that is now the decision

This ADR originally closed the bullet above with "deriving that hash from the processor bundle itself, rather than trusting an author-maintained string, is a requirement of this design and not a follow-up". That requirement is **withdrawn**, and what replaced it is narrower on purpose. `processor-version-hash-cannot-silently-lie` built the deviation deliberately and flagged it for ratification rather than resolving it silently; this is the ratification.

A hash derived from the bundle moves whenever a bundler or a minifier re-emits the same behaviour differently. Under this design that is not a stale-looking string, it is a **full blue-green rebuild triggered by a deploy that changed no logic**, replaying the stream from genesis. Paying that on an unpredictable subset of deploys is a worse failure than the one it prevents, and it is unpredictable in exactly the way that erodes trust in the mechanism: nobody can tell, before deploying, whether this is a rebuild deploy.

What was built instead, in two parts:

- **`version` is mandatory and unfakeable-by-omission.** Both `EventProcessor` implementations refuse to construct without a non-empty one, and both fallback constants (`unknown`, `not-configured`) are deleted rather than made unreachable. The failure mode where a processor hashes to a shared constant, so that NO logic change ever invalidates anything, is gone by construction.
- **A code fingerprint, derived from the handler sources, sits BESIDE the hash and never inside it.** It is persisted with the sync cursor and compared on load. Version hash unchanged plus fingerprint changed is precisely the missed bump, and it is reported at error level and through a host callback.

**What this ADR must be honest about: the residual risk is not eliminated, it is made loud.** A missed bump still means the rebuild does not trigger, because the rebuild keys off the version hash and the fingerprint is deliberately not part of it. The mitigation is that the condition is now *announced*, on every load, instead of being invisible. A deployment that cannot tolerate serving state from replaced logic sets `strictProcessorDrift`, which turns the report into a refusal to start: that is the fail-stop this design needs, and it is opt-in because the false positive (a re-minification) is real and would otherwise refuse a perfectly good deploy.

If the rebuild is later wired to fire on drift rather than only on a version change, this bullet needs revisiting again, and the false-positive cost returns with it. See `work/tasks/done/processor-version-hash-cannot-silently-lie.md` for the full reasoning and the measured limits of the fingerprint (it survives restarts and reformatting; it does not survive minification, a transpiler change, or a comment edit).

### Amended 2026-08-31: this is one case of a general GENERATION model, and the namespace key was too narrow

This ADR's mechanism is unchanged and still correct: rebuild from the locally stored stream into a new namespace, keep serving the old, flip a pointer, drop the old. What has changed is its SCOPE and its KEY, and both are recorded in `work/specs/tasked/a-reconfigure-is-not-an-outage.md`, which generalises this ADR rather than competing with it. **The SERVER side of that generalisation — the runtime this ADR was written for — is `work/specs/tasked/the-server-and-cli-hold-generations-too.md`**, which also absorbs `indexer-server-feed`'s rebuild stories (that spec keeps the emission table and the feed, and is this one's prerequisite), and which owns the stream keeper over the emission-stream table, the container above `StreamBuilder` that replaces `processor.clear()`, and this ADR's `current_version` row's successor.

- **Scope.** The blue-green rebuild was specified for the server. The same mechanism is now the answer in the browser and the CLI too, so it is described per NAMED INDEXER and per GENERATION rather than per runtime. The word there is **generation**; **blue-green** remains the right name for the two-at-a-time special case this ADR describes.
- **The key was too narrow, and that is the substantive correction.** This ADR keys the new namespace by the PROCESSOR VERSION HASH alone. That cannot express a change to the FETCH FILTER: two sources with different topic sets would collide on one namespace if their processor were unchanged, and — worse — a namespace keyed only by the processor implies the stream underneath it is always reusable, which is false exactly when the filter grew. A generation is therefore keyed by its STREAM plus the processor version hash, where the stream's own identity is a digest over the deduplicated `streamHash` values plus the STREAM CONFIG hash — which is ADR-0006's `{source, config}` stream keying made concrete, narrowed on the source side to the FETCH half per ADR-0034. The config sits in the STREAM identity, not on the generation, because a config change invalidates the stream itself. A processor-only change is a new generation over the SAME stream and re-fetches nothing, which is this ADR's case and stays free; a filter change is a new stream.
- **N, not two.** This ADR drops the old namespace after the flip. Generations are instead retained up to a configured cap, which is what makes moving the pointer BACK a supported operation rather than another full rebuild. The cap REFUSES rather than evicting, precisely because of this ADR's own retention argument: a rebuild needs the stream, so nothing may silently delete one.
- **The double-write window is gone.** This ADR feeds both namespaces briefly and then flips. Generations are independent, so the flip is the only step and neither side needs quiescing.

Unchanged and still load-bearing: retention is what makes upgrades possible, `getVersionHash` is what makes them TRIGGER, and the 2026-08-21 amendment on the code fingerprint stands exactly as written.
