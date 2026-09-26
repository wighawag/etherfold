---
'etherfold': minor
'@etherfold/platform-nodejs': patch
'@etherfold/server': patch
---

The one-shot is `etherfold build`, `serve` is only the read tier, and no command is implicit.

**BREAKING, and it is the whole point.** `etherfold index` is gone and resolves to nothing: the word is needed for the wire receiver, which receives pushed batches, owns the database and does not terminate. The one-shot that folds to the tip and exits is now named for what it PRODUCES.

```sh
etherfold index -p ./processor.js --store sqlite --db file:./etherfold.db   # before
etherfold build -p ./processor.js --store sqlite --db file:./etherfold.db   # after
```

**There is no DEFAULT command any more**, so a bare `etherfold …` now needs a command word: `etherfold -p ./processor.js --store sqlite --db file:./etherfold.db` was the one-shot and is now an unknown-option error. `etherfold` with nothing after it prints help and indexes nothing. The default existed so the rename from `ei` would not also cost users their argument order (ADR-0017); the name is changing anyway, and under a set of five names chosen so a reader can tell what a process will DO, an invocation that silently means one of them is the ambiguity the set exists to remove.

Nothing about the pipeline moved. `build` keeps every flag (`-p`, `--store`, `--db`, `--retention`, `-d`, `-n`, `--rps`, and the `ETHEREUM_NODE` fallback), every refusal, the stop-at-tip driver and the exit codes (0 at the tip, non-zero on a refusal no waiting fixes). The package's exported `run(options)` is renamed to `build(options)` to match, and `main`'s injectable `run` collaborator becomes `build`, because `run` is a DIFFERENT command in the set being built (it follows the chain, answers queries and never terminates).

**`serve` keeps its name and narrows its promise to serving.** It holds no processor, makes no chain call and writes no indexed state: it answers over a database something else wrote. That was already true of the code and not of the docs. It is now asserted rather than described: a server started the way `serve` starts one answers `501 ingestion-not-configured` on `/ingest` and `/ingest/expected-from-block` to an authenticated caller, while `/status` still answers, and an unauthenticated caller still gets `401` first, so the absence of a processor is not something an anonymous caller can probe.
