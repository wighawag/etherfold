# A Cloudflare Worker cannot turn stored bytes into a processor, by any in-isolate route

Asked before tasking `a-generation-retains-the-code-that-folds-it`, whose design stores each generation's bundle in the DATABASE partly so that "a runtime (a Worker)" with no filesystem can still resume a generation. ADR-0085 made the same assumption in passing, calling a deployment with no filesystem "the shape a browser tab and a Worker have". The browser half of that was measured on 2026-09-17 and came back no, except through a service worker. The Worker half had never been measured. This is that measurement, and it was RUN.

## What is here

| file | what |
| --- | --- |
| `worker.mjs` | the harness: one Worker that tries five ways to instantiate a one-line processor from a string, plus a control |
| `config.capnp` | the minimal `workerd` configuration serving it |
| `run.sh` | serves it on the `workerd` this repository already installs, fetches it once, and stops it |
| `results.txt` | its output, plus the same processor imported in Node for contrast |

Run it from this folder, after `pnpm install` at the repository root:

```sh
./run.sh
```

It binds `127.0.0.1:18787`. Measured on `workerd 2026-08-20` (the version the lockfile pins), with `compatibilityDate = "2026-08-20"`, on 2026-09-22.

## The result

Every in-isolate route is REFUSED, and the control proves the Worker itself runs:

| route | result |
| --- | --- |
| `import("data:text/javascript;base64,...")`, which is what `loadProcessorArtifact` does | refused: `No such module "data:..."` |
| `import("data:text/javascript,...")` | refused, same |
| `import(URL.createObjectURL(blob))` | refused: `URL.createObjectURL() is not implemented` |
| `new Function(...)` | refused: `EvalError: Code generation from strings disallowed for this context` |
| `eval(...)` | refused, same |
| static code (control) | runs |

The same processor imported through a `data:` URL under Node v24.19.0 runs, which is why the loader works everywhere it has been tested.

The platform documents the `eval` and `new Function` half as deliberate and not configurable ("For security reasons, the following are not allowed", Cloudflare Workers docs, "Web standards", last updated 2026-04-23). The module half is not documented at all, which is exactly why it was measured rather than read.

## The one route that survives, NOT measured here

Cloudflare's sanctioned way to run code supplied at runtime is a separate product, Dynamic Workers: a Worker Loader binding (`env.LOADER.load(...)` / `get(id, ...)`) creates a NEW isolate from module strings and returns a stub the caller invokes over RPC. That is the Worker counterpart of the browser's service worker, and like it, it is a real mechanism with a structural cost: the processor would run in a different isolate from the fold engine, so every handler call would cross an RPC boundary, and the deployment would need a binding and a configuration it does not have today. This spike did not exercise it.
