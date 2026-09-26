---
'etherfold': minor
---

One configuration path for every command: flags first, environment behind them, and a refusal that names both.

The three entry points disagreed. The fetcher deployable read everything from the ENVIRONMENT and refused by name; the CLI read FLAGS and made requiredness a parser setting; the Node server host read two variables of its own. Now one module (`src/config.ts`) owns the whole flag-and-environment resolution for the CLI, both shipped commands run entirely off it, and the three commands that do not exist yet (`run`, `fetch`, `index`) already have their row in the same table.

**`ETHEREUM_NODE` is RETIRED. The node URL variable is `ETH_NODE_URI`**, which is the name a fetcher deployable already refuses by, and it is now the only one. There is one name per input.

```sh
ETHEREUM_NODE=https://rpc.example etherfold build …   # before
ETH_NODE_URI=https://rpc.example etherfold build …    # after
```

**`etherfold serve` now REFUSES to start without a database.** It resolves `--db`, then `DB`, and refuses naming both when neither is set, instead of falling through to the Node adapter's convenience default and creating an empty `./etherfold.db` nobody named. `@etherfold/platform-nodejs` is unchanged: the CLI passes the database it resolved explicitly, so that default is no longer reachable from a command.

**Every input is resolved the same way, and there is one name for each (ADR-0048).** A flag beats the environment; the environment is used when the flag is absent; neither present is a refusal that names the flag AND the variable, made before the chain is dialled or a database is opened. The variables are the fetcher host's (`INDEXING_SOURCE`, `ETH_NODE_URI`, `INGEST_ENDPOINT`, `INGEST_TOKEN`, `REQUESTS_PER_SECOND`) plus the Node server host's (`DB`, `PORT`). The other six inputs (`-p`, `--store`, `--retention`, `-d`, `--host`, `--no-auto-setup`) are flags only: the environment carries what varies between deployments of one image, a flag carries what the image IS.

**`INDEXING_SOURCE` now works on the CLI**, as the variable form of `-d, --deployments`: one JSON document, parsed and refused by field name. It resolves a source with NO chain call, which is what the wire receiver will need, since it makes none.

**Nothing is accepted and ignored.** A flag a command does not own now PARSES and is refused with the reason it does not own it, rather than meeting `unknown option`: `etherfold serve -p ./processor.js` says that a read tier holds no processor and points at `index`, `run` and `build`. Those flags are hidden from `--help`, so the surface a user reads is still exactly what the command owns. An ambient VARIABLE a command does not own is not read at all rather than refused, so one host can run several commands side by side.

**`--port` lost its commander default.** It was `'2000'` at the parser, which meant the flag was always present and `PORT` could never be reached. The default is now the resolver's, applied only when neither the flag nor the variable said anything. It is the only defaulted input.

**`--rps` is parsed to a number.** It was typed as one and arrived as a string; a value that is not a positive number is now refused.

**`prepareIndexing` takes the command name first**: `prepareIndexing('build', options, deps)`. `Options` now covers every flag any of the five commands takes, and every field on it is optional, because requiredness lives in the resolver and not in the parser. `resolveIndexOptions` is replaced by `resolveCommandConfig(command, options, env)`, which is exported along with the command table, the resolved shapes and `serve(options, deps)`.
