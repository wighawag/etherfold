---
'@etherfold/platform-nodejs-fetcher': minor
---

**BREAKING: the `etherfold-fetch` binary is RETIRED, with its `bin` entry, and this package survives as a LIBRARY.**

There is exactly one way to run a fetcher and it is `etherfold fetch` (the `etherfold` CLI), which puts a flag surface in front of the configuration this package reads from the environment. The binary was a second front door onto the same loop, and a second front door is a second answer to how a fetcher is configured.

Nothing else moves: `startFetcher`, `runFetcherProcess`, `stopOnSignals`, the loop, the signal handling and the exit codes are unchanged, and the environment variables are still the ones documented here. This is precisely the shape `@etherfold/platform-nodejs` already has -- no binary, and the CLI imports its start function -- so the symmetry between the two host adapters is restored rather than invented, and the runtime adapter stays the only place a runtime is named (ADR-0003).

Two dependencies go with the entry point that used them: `ldenv` (loading a `.env` file is what a process does, and the CLI does it) and `named-logs-console` (hooking the log facade to the console is a process entry point's job, so `etherfold fetch` does it now, and an application embedding `startFetcher` still chooses its own sink).

**Migrating:** replace `etherfold-fetch` with `etherfold fetch`, whose flags default to the same variables this package always read.
