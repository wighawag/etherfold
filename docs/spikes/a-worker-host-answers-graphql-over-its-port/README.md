# What GraphQL adds to a worker bundle

Measured for `a-worker-host-answers-graphql-over-its-port` (ADR-0099), on 2026-09-28, with `measure.mjs` beside this file: one worker entry calling `hostIndexerInThisWorker`, bundled by esbuild for a browser (minified, ESM, `es2022`) twice, without and with `query: graphqlQueryHandler()` from `@etherfold/graphql/worker`, each gzipped at level 9.

| worker entry | minified | gzipped |
| --- | --- | --- |
| without the query handler | 157.5 KiB | 51.8 KiB |
| with `graphqlQueryHandler` | 348.4 KiB | 100.2 KiB |
| **what GraphQL adds** | **191.0 KiB** | **48.3 KiB** |

What is added is `graphql` (graphql-js 16), `@pothos/core` and the schema module (its builder, resolvers and executor). The entry without the handler contains no `graphql` module at all, which `packages/graphql/test/worker-bundle.test.ts` asserts on every run.

It is a worker bundle, so it is off the first-paint path either way; the number is what an app weighs when it decides between taking GraphQL locally and staying on the generated read surface (`createPortReadSurface`), which adds nothing. Rerun with `node docs/spikes/a-worker-host-answers-graphql-over-its-port/measure.mjs` after `pnpm build`.
