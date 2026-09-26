---
status: accepted, not yet implemented
---

# `run` is CONFIGURED and never receives code; a new command, `node`, receives uploads and is never configured with code

A combined deployment can learn what to run from two places: its CONFIGURATION (`-p`, `--deployments`, `INDEXING_SOURCE`) and its REGISTRY, fed by uploads (ADR-0085's amendment of 2026-09-22, ADR-0092). While one process accepted both, every interaction between them needed a rule, and each rule needed another: a configured source that an upload must match, a start that may not silently replace an uploaded successor (`--override`), and finally a restart with an unchanged `-p v1` that would silently roll back a `v2` uploaded and promoted since, because a configured processor is an arrival. The last one has no good answer, because the same `-p v1` means "run v1" before any upload and "this configuration was never updated" after one. We decide that **each command has exactly ONE source of truth**:

- **`etherfold run` is CONFIGURED.** It takes its processor and source from configuration, as it always has, and never receives code over HTTP: it serves no upload route. Configuration is the truth, so a restart with a different `-p` is a deliberate deploy, including one that names a generation `predecessor` holds (a rollback by configuration).
- **`etherfold node` RECEIVES.** It takes the chain, the store and the database like `run`, and NO processor and NO source: it refuses `-p`, `--deployments` and `INDEXING_SOURCE`. What it runs is what its registry says, and code reaches it only by `etherfold upload`. It is The Graph's shape (graph-node holds no mappings in its configuration; subgraphs arrive by deploy), and it is the ADR-0093 mode promoted from an exception of `run` to a command of its own.

Recorded because it is hard to reverse (it fixes the command set and where remote-code authority lives) and surprising without context (two combined commands that differ only in how code arrives).

## Consequences

- **The re-read endpoint (`POST /{indexer}/admin/reconfigure`) is DELETED.** Its purpose was a dev loop on a configured process; that loop is now `node` plus a watcher calling `etherfold upload`, which exercises the path production uses, and a configured `run` changes its code by restarting, which the re-read only saved a process start over. With it go its arrival value `re-read` (`ReconfigureArrival` keeps `upload` and `hot-update`) and the CLI's reconfigurer. `ReconfigureReport` keeps its name for now; renaming it is not this decision.
- **The upload route (`POST /{indexer}/admin/upload`) moves from `run` to `node`.** Its configured-source match (ADR-0093's "match rule", ADR-0085's relocated decisions) has no subject on `node`, which never has a configured source, and is deleted with the branch that implemented it. Every other refusal is unchanged.
- **`run` with neither processor nor source is REFUSED again**, and ADR-0048's exception for `run` (its 2026-09-26 amendment) moves to `node`, where the absence is not a missing input but the command's whole meaning.
- **The start guard stays on `run`, `build` and `index`** (ADR-0084's amendment of 2026-09-26). A pending successor on a configured command can only have arrived by an earlier start, and replacing it at a start is still a deletion worth confirming. `node` has no configured processor, so its starts replace nothing.
- **One database opened by both commands is allowed.** `run` over a database a `node` wrote treats it as any configured start: configuration is the truth, a different `-p` registers as the successor, and the start guard protects a pending upload. `node` over a database a `run` wrote simply runs what the registry names. No mode is recorded in the database.
- **An arrival naming the predecessor RE-ARMS it as successor** on both commands (the maintainer's decision of 2026-09-26, task `an-arrival-of-the-predecessor-re-arms-it-as-successor`): an upload of its bytes on `node`, and a configured start naming it on `run`. On `run` that is a rollback by configuration, which is correct there because configuration is the truth.
- **What each command's `/status` and admin listing say is unchanged**; `cursor.waiting` is reported by `node`.
- **The command set grows to seven.** `node` is a deployment INTENT like the five (a way to run a process), unlike `upload`, which is a client. CONTEXT.md, ADR-0057's and ADR-0048's amendments and the CLI help say so when it lands.
- **`run` keeps its composition**: it is still `fetch` plus `index` plus `serve` in one process, and `build` is still `run` without the serving. `node` has no split form; a split receiver of uploads remains ADR-0093's "later".

## Considered Options

- **Remove `-p` and the source from `run` entirely**, so `run` is the upload node. Rejected: it gives up the configured shape's real strengths (a container image that bakes its bundle, the deployments-folder workflow, a restart that depends only on its configuration), and breaks `run`'s composition with `fetch`, `index` and `build`.
- **Keep one command and resolve the conflict by a rule** (a start naming the predecessor changes nothing; or re-arms, guarded by `--override`). Rejected: every such rule reads configuration as a statement of intent in one state and as stale in another, and `--override` in a pipeline's standing configuration is not a confirmation of any particular rollback.
- **Record the mode in the database and refuse to open it in the other.** Rejected as more machinery than the case needs: configuration being the truth on `run`, with the start guard, already makes the cross-over safe.
