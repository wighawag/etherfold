---
title: 'A reconfigure cannot reach a running `run`: every part of the story is built except the TRIGGER'
slug: a-reconfigure-cannot-reach-a-running-run
observed: 2026-09-13
---

2026-09-13 — Noticed while scoping whether `run` could be made multi-tenant, and surfaced by the author saying "the whole point of `run` is that it works without restart, keeping the old generation until promoted or auto-promoted". That is NOT what the code does, and the divergence is worth recording because it is narrow: everything downstream of "a successor exists" is built and behaves exactly as intended. Only the thing that INTRODUCES the successor is missing.

## What is built, and works

- **A successor is registered BESIDE the incumbent and nothing is discarded.** `ReceivingIndexer.open` registers the configured generation next to the canonical one whenever they differ by stream OR processor, and says so: "the fold {stream, processor} is a SUCCESSOR: it was registered BESIDE the canonical generation {...}, which keeps its own state and goes on answering every read. Nothing was discarded."
- **Auto-promotion is real, and it is the DEFAULT.** `promotion.ts` states "`on-catch-up` is the DEFAULT EVERYWHERE", with the reasoning that there is "deliberately no per-runtime and no per-environment default, because the axis that would select one is NOT DETECTABLE". So the assumed dev behaviour (promote when the successor is level) is what happens in every environment, and the CLI exposes no flag to change it.
- **The incumbent keeps ANSWERING throughout**, and for the common reconfigure it also keeps ADVANCING: a processor-only change is a follower on the same stream (ADR-0044, it "fetches nothing at all"), so the incumbent stays the stream's writer and stays current off the wire while the successor re-folds, then the pointer moves on its own.

## What is missing: there is no restart-free way to introduce the generation

A generation is registered when the container OPENS, from config. Checked for every trigger a running process could have, and there is none:

- **No file watching anywhere in the CLI.** `fs.watch`, `watchFile`, `chokidar`, `watcher`: zero matches under `packages/cli/src`. There is no `--watch` flag, and no `dev` command (the set is `build`, `fetch`, `index`, `run`, `serve`).
- **No HTTP surface for it.** The entire admin API is one route, `POST /{indexer}/admin/canonical-generation`, which MOVES the canonical pointer (ADR-0057). There is no add-generation and no reconfigure route, so a client can only choose among generations that already exist.
- **No reload signal.** The CLI installs SIGINT and SIGTERM only, both for shutdown.

So a changed processor or source reaches a running `run` by stopping it and starting it again. The restart is cheap and is not a data outage, because the registry and the state are rows in the database, so the new process finds the incumbent already there, still canonical, still answering. But it IS a process restart: a brief interruption, and not overlappable, since a second `run` against the same database takes the writer claim and the first one's next write is refused (ADR-0075).

## Why the two understandings drifted

Likely this comment, at `packages/cli/src/index.ts:350`: "A `run` is a long-running host, **so a reconfigure can reach it**: a fold added beside the live one is a FOLLOWER, and a follower is advanced by a bounded REBUILD its host SCHEDULES". Read in context it is defensible and is about having TIME to advance a follower, contrasted with `build`, which "has no reconfigure, holds exactly ONE generation and exits". Read quickly it says a reconfigure arrives at runtime. What actually makes the restart survivable is the DURABLE REGISTRY, not the process being long-lived, and the comment credits the wrong one.

## The trigger shape is DECIDED: an endpoint, not a file watcher

Decided by the author on 2026-09-13, recorded here so it is not re-litigated: the trigger is an **ENDPOINT**, and whatever notices a file changed lives OUTSIDE the process and calls it. No file watcher goes into the CLI.

Two consequences worth stating, because they are the reason this is the better shape:

- **It is not a dev-only affordance.** A file watcher would be dev tooling by construction, which is what makes it tempting to gate behind a dev flag and then to skip. An endpoint is triggerable by a dev watcher, a deploy hook or a CI step equally, so the same mechanism serves production rather than a second one being needed later.
- **The auth question is already answered.** It sits beside the pointer move under `/{indexer}/admin/`, on the admin credential, which is "deliberately a SECOND credential and never the ingest one". So handing a remote caller the ability to start a fold reuses the existing story instead of opening a new one.

## What the endpoint can and cannot be, because a processor is CODE

It cannot be "here is a new processor": a processor cannot cross HTTP. So its job is **RE-READ**, not receive: re-resolve the config, re-import the processor module, and register whatever generation that now names beside the incumbent. The watcher rebuilds first and then calls, so the split is that the watcher owns *when* and the process owns *what*.

Two mechanism hazards to design for, both verified, because each turns the endpoint into a silent no-op rather than a visible failure:

1. **The module cache.** `loadProcessorModule` (`@etherfold/utils`) ends in `import(specifier)`, so re-importing an unchanged path returns the CACHED module and a reload would see nothing at all. There is already an injection point for this, `LoadProcessorModuleOptions.importModule`, so a cache-busting specifier or a fresh worker can be supplied without changing the loader's shape. Note the cost of the cheap route: a cache-busting query adds a module instance to the registry per reload and none are collected, which is fine for a dev loop and worth knowing before it runs in production.
2. **Identity blindness.** A generation is registered only when its identity DIFFERS, and the processor half of that identity is a hash whose code fingerprint "hashes the SOURCE TEXT of the author's handlers", so a change carried by a closure-captured value fingerprints identically (`the-processor-fingerprint-is-blind-to-closure-state`). An ordinary dev edit does change source text, so this is a secondary hazard rather than the common case, but it means a reload can legitimately register nothing.

Both argue for the same small thing: the endpoint should ANSWER what it did, naming the generation it registered or saying that the identity did not move. Otherwise "I saved the file and nothing happened" has three indistinguishable causes.

## The separate defect this does not fix

A filter change ALSO freezes the incumbent during catch-up in this shape: `a-filter-change-freezes-the-incumbent-in-run`. That is independent of this note, it is not fixed by adding a trigger, and the author has confirmed the incumbent is meant to keep advancing until the successor catches up. So both are needed for the intended story, and this one is only the half that starts it.
