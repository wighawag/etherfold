# `startServer` reports port 0 when given a hostname and port 0

Observed 2026-09-28 while building `a-server-answers-graphql-over-http`: `platforms/nodejs/src/index.ts` reads the bound port with `server.address()` straight after `serve(...)`, and with a `hostname` (for example `127.0.0.1`) Node binds asynchronously, so `address()` is still `null` and the returned `url` and `port` say `:0`. Without a hostname it binds in time. `etherfold serve --port 0 --host 127.0.0.1` would print an unusable URL; tests avoid it by passing no host.
