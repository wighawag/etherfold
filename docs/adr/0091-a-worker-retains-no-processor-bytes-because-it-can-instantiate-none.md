# A Worker retains no processor bytes, because it can instantiate none; its way back is code in the build

`a-generation-retains-the-code-that-folds-it` stores each generation's bundle beside its state so that a redeployed process can RESUME a generation whose code is not in its build, instantiating it from those bytes. On a Cloudflare Worker that second half is impossible: measured on the `workerd` the lockfile pins, `import(data:)` (which is exactly how `loadProcessorArtifact` instantiates), `import(blob:)`, `new Function` and `eval` are all refused inside the isolate, while a control route runs (`work/notes/findings/a-worker-cannot-instantiate-a-processor-from-bytes.md`, harness in `docs/spikes/a-worker-cannot-instantiate-a-processor-from-bytes/`). **We decide that a Worker retains no processor bytes.** Code retention is a Node concern, and on a Worker the way back to an earlier processor is code that is present in the deployed build.

This is ADR-0089's argument in a second place, and it is not a matter of degree for the same reason. A Worker that folds gets its processor the one way the platform allows, bundled into its deployed script, so an earlier processor is not un-promoted but absent from the build, and stored bytes cannot bring it back.

## What this does NOT decide: folding on a Worker stays open

Folding on a Worker is POSSIBLE and is deliberately NOT a target this project spends on. It is not rejected. The attraction is real (a cheap subscription and a D1 database per deployment), and the repository already shapes for it: the fetcher needs a process and stays on Node, pushing batches to an indexer-server that "is a fine thing to host on a Worker" (`@etherfold/fetcher-host`), and `platforms/cf-worker` documents that a deployment which hosts a processor bundles it and builds its store with `createD1Store`. What is known to stand in the way, all already recorded elsewhere:

- **Invocations are isolated.** No I/O crosses requests and `waitUntil` extends work by at most 30 seconds (`work/notes/findings/a-worker-cannot-hold-a-timer-across-requests.md`). Steady-state folding is per-batch and fits; a REBUILD does not obviously fit, because re-folding a stored stream for a successor (ADR-0008) is long-running work with no single invocation long enough to hold it, so it would have to be chunked across invocations by something that does not exist yet. ADR-0053 already found that even UNDOING a rebuild on D1 needs its own bounded-chunk driver.
- **The state-moved signal is refused** without a Durable Object (ADR-0083).
- **D1 bounds a query at 100 bound parameters** (`work/notes/findings/d1-caps-bound-parameters-per-query-at-100.md`), which the store already has to respect.
- **And now: no code from bytes**, so no pushed artifact and no retained one.

Revisit when a deployment actually wants to fold on a Worker. The REBUILD across invocations is the question that decides it, not this one.

## The way back on a Worker

**Redeploy the earlier script.** That already works: identity is derived from the code (ADR-0086) and `GenerationRegistry.create` resolves an identity it already holds, so the earlier processor lands on its own generation record, and its state is still there.

**Or ship BOTH processors in one build**, so a revert needs no redeploy at all. A build carrying the current processor and the previous one holds a fold for each, and moving the pointer back is then a revert to something this process can actually run. The registry is already shaped for it: a generation that is ALREADY in a slot "stays where it is", and one redeployed with what `predecessor` names "must not be re-armed by the act of starting up" (the slot rules in `GenerationRegistry.create`; amended 2026-09-26 by ADR-0094, `an-arrival-of-the-predecessor-re-arms-it-as-successor`: an ARRIVAL of what `predecessor` names is now RE-ARMED into `successor`, so this route would need its own answer to how the previous processor is held without being re-armed). What is not built is the host side: the receiving container opens with ONE processor and takes further ones through `add`, and nothing yet gives an author an easy way to put the previous release's processor into the next build. That is recorded here as the intended route rather than decided work, and it has not been tested end to end.

## Considered options

**Dynamic Workers.** Rejected for now, as the Worker counterpart of the service worker ADR-0089 declined. It is the one route that survives: a Worker Loader binding creates a NEW isolate from module strings and hands back an RPC stub. It is not measured here, and its price is structural rather than incidental: the processor would run in a different isolate from the fold engine, every handler call would cross an RPC boundary, and every deployment wanting the feature would need a binding and configuration it does not have today. Paying that for a revert that redeploying already provides is the wrong trade while folding on a Worker is not even a target.

**Store the bytes anyway, for a future runtime that can instantiate them.** Rejected: a promise to resume that no code on the runtime can keep is the exact defect `a-generation-retains-the-code-that-folds-it` was written to remove, moved one runtime over.

## Consequences

**`a-generation-retains-the-code-that-folds-it` is a NODE spec.** Its stated reason for keeping bytes in the database, avoiding "a filesystem dependency on a runtime (a Worker) that has none", no longer holds. Keeping them in the database is still right on Node for its other reasons (one namespace holds everything a generation is, and it is reclaimed by one mechanism), so the storage decision stands and only that justification goes.

**`a-processor-artifact-is-pushed-to-a-running-deployment` loses its first motivating deployment.** Its problem statement opens with "A Cloudflare Worker has no filesystem to read a module from", which is the case this rules out. Its other cases are Node processes and are untouched.

**ADR-0085's claim that a Worker has the no-filesystem shape was corrected in place**, since it never described anything a Worker could do.

**Shipping both processors is not Worker-shaped.** Any runtime whose build can carry two processors can revert without retained bytes, which is a different route to part of what code retention buys on Node. Whether it should change what gets built on Node is raised with that spec rather than decided here.
