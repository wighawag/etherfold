---
'etherfold': patch
---

What an operator reads first, fixed after a hand smoke test of `node` + `upload` against a local chain:

- `etherfold node` WARNS at start when `ADMIN_TOKEN` is not set: such a node refuses every upload (401) and can never receive a processor, which used to surface only at the first upload. `node --help` names `ADMIN_TOKEN` in its usage line.
- `run` and `node` name the generation they came up serving (`serving generation <digest> (processor <sha256>)`), which on a restart is the one resumed from the registry.
- `run`, `node`, `build` and `index` print a configuration refusal as its MESSAGE rather than as an `Error` with a stack through the resolver, as `fetch` and `upload` already did. An injected `error` still receives the error object, and the full error goes to the `etherfold` logger.
- `etherfold upload`: `-p` has its own help text (it used to show the folding commands' description); a refused bundle given as the positional argument is named "the bundle" rather than `-p, --processor`; and `REGISTERED` no longer claims another generation answers reads on a first upload.
