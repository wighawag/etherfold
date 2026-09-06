# @etherfold/platform-nodejs

The Node host for [`@etherfold/server`](https://github.com/wighawag/etherfold/tree/main/packages/server): it supplies a libSQL-backed `RemoteSQL` and the process environment, and serves the app over HTTP.

That is the whole adapter. No route, no chain logic and no storage decision lives here: those are the server's and the engine's.

## When you want this package

| you want | use |
| --- | --- |
| a read tier on Node, from a terminal | [`etherfold serve`](https://github.com/wighawag/etherfold/tree/main/packages/cli), which calls this |
| a server on Node, inside your own program | here |
| a server on Cloudflare Workers | [`platforms/cf-worker`](https://github.com/wighawag/etherfold/tree/main/platforms/cf-worker) |
| a host for a runtime neither of those covers | [`@etherfold/server`](https://github.com/wighawag/etherfold/tree/main/packages/server) directly |

## Minimal usage

```ts
import {startServer} from '@etherfold/platform-nodejs';

const running = await startServer({db: 'file:./etherfold.db', port: 2000});
console.log(running.url); // http://localhost:2000  --  /status is there
await running.close();
```

`createNodeDB(url)` is exported separately, so a program that wants the same libSQL handle for something else (the CLI's `index` command does) builds it the same way the server does.

| option | default |
| --- | --- |
| `db` | a libSQL URL **or** a `RemoteSQL` handle you already built; defaults to the `DB` variable, else `file:./etherfold.db` |
| `port` | the `PORT` variable, else `2000`. Pass `0` for any free port; `running.port` reports the one it got |
| `hostname` | Node's default |
| `autoSetup` | `true`: apply the fixed-table schema at startup if it is not already there |
| `env` | overrides merged over `process.env` |
| `getIndexer` | none: the ingestion routes answer `501` under every name |
| `getCursorReport` | none: `/status` carries no `cursor` field |

`INGEST_TOKEN` is read from the environment by the server itself, and ingestion is refused outright without it. The token guard sits on the `/{indexer}/ingest` path ahead of the registry lookup, so an unauthenticated caller gets `401` whether or not this deployment hosts a processor, and cannot enumerate the names it was built with; `501` is what an authenticated one gets from a server hosting none, and `404 unknown-indexer` from one that simply does not hold that name.

## One database, two users

Pass a handle rather than a URL when this process also folds into that database:

```ts
import {indexerRegistry, singleContextEntry} from '@etherfold/server';
import {createNodeDB, startServer} from '@etherfold/platform-nodejs';

const db = createNodeDB('file:./etherfold.db');
// ... build a store and a processor on `db`, then:
const running = await startServer({
	db,
	port: 2000,
	// the NAMED INDEXERS this process hosts, addressed as `/{indexer}/ingest`. A
	// named indexer IS a database (ADR-0053), and this process holds one name over
	// the one handle it folds into
	getIndexer: indexerRegistry({alpha: singleContextEntry(db, streamBuilder)}),
	getCursorReport: () => report,
});
```

The server then reads what the store just wrote, because it is the same connection: two handles onto one URL are two views of it, and against `:memory:` they are not even the same database. A handle you supplied is yours to close -- `running.close()` stops listening and leaves the database alone, so shutting the server down never takes a store's connection with it.

**`autoSetup` defaults ON here and is deliberately absent on the Worker host.** Node is the single-operator case: one process, owning one database file, where making a user POST to an admin route before the server is usable is ceremony with no safety payoff. On Workers there are many instances against one D1, so migration stays an operator action rather than something several isolates race to do.

**The two capabilities are carried through untouched, and this host builds neither.** `getIndexer` (the registry of named indexers whose stream-builders receive pushed batches) and `getCursorReport` (how far the pipeline has got, reported verbatim on `/status`) can only be built by the process that owns a processor and a store, so they arrive here in the server's own shape and are handed on unchanged. Supply both and the deployment RECEIVES pushes and folds them, which is what `etherfold index` is; supply neither and it SERVES a database rather than folding into one, which is what `etherfold serve` is. What a reporter owes the server -- a small, JSON-serialisable summary, never the store's raw serialized cursor -- is stated on `ServerOptions.getCursorReport` in [`@etherfold/server`](https://github.com/wighawag/etherfold/tree/main/packages/server).

## Related

[`@etherfold/server`](https://github.com/wighawag/etherfold/tree/main/packages/server) for the routes and the wire contract, [`@etherfold/platform-nodejs-fetcher`](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs-fetcher) for the OTHER Node deployable (the chain-facing half that pushes to a server like this one).

## Tests

`pnpm --filter @etherfold/platform-nodejs test`, vitest.
