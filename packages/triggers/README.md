# @etherfold/triggers

The core of etherfold's reference trigger service: it follows an indexer's canonical feed (`etherfold run`'s `/{indexer}/canonical`), matches each log against triggers held as data, and delivers the actions they imply through a durable outbox, as authenticated HTTP calls carrying a semantic idempotency key: a Web Push through [push-notification-server](https://github.com/wighawag/push-notification-server), a call to an operator's reward service, or an adapter of your own.

It is platform-neutral: it takes a [`remote-sql`](https://www.npmjs.com/package/remote-sql) database and a `fetch`, opens no port and reads no environment. To run it, use [`@etherfold/platform-nodejs-triggers`](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs-triggers), the `etherfold-triggers` command on libSQL, whose README is the operator guide (the config file, a reward target, the state a predicate reads, the registration contract, operating it).

Triggers run outside the indexer-server by design, as their own process ([ADR-0005](https://github.com/wighawag/etherfold/blob/main/docs/adr/0005-triggers-run-outside-the-indexer-server.md), [ADR-0100](https://github.com/wighawag/etherfold/blob/main/docs/adr/0100-the-reference-trigger-service-lives-in-this-repo-as-its-own-packages-and-runs-as-its-own-process.md)): this service owns its database, its cursor, its gate, its outbox and its auth, and reaches the indexer only over the HTTP any consumer reads. The rules it implements are etherfold's ADRs [0007](https://github.com/wighawag/etherfold/blob/main/docs/adr/0007-consumers-gate-themselves-safe-and-fast-lanes.md), [0009](https://github.com/wighawag/etherfold/blob/main/docs/adr/0009-actions-are-idempotent-http-calls-with-per-type-delivery-policy.md), [0011](https://github.com/wighawag/etherfold/blob/main/docs/adr/0011-bound-triggers-by-delivery-rate-and-deliver-digests.md), [0012](https://github.com/wighawag/etherfold/blob/main/docs/adr/0012-triggers-expire-unless-renewed.md) and [0013](https://github.com/wighawag/etherfold/blob/main/docs/adr/0013-trigger-conditions-are-data-actions-are-code.md).

## How it works

- **The consumer** reads the canonical view page by page at or below a **gate** (the safe lane: the chain's `finalized` block, or `latest - depth`), matches each log, and commits the page's deliveries together with the cursor in one batch. A crash re-reads the page; the idempotency key absorbs anything matched twice. A rewind (`409 rewind-required`) retracts what was not yet sent from the fork block on, and records it. A change of the fold answering the feed (its `generation`) PAUSES the consumer until an operator resumes it.
- **Two kinds of trigger** (ADR-0013): a **subscription** is registered by a user for themself, of a kind the operator declared, filtered on decoded arguments, and it expires unless renewed (ADR-0012); a **global rule** is the operator's code over every log of an event, whose recipient is computed and whose predicate decides. A predicate may read the indexer's state as of the log's block (`stateReader`, over the server's `/graphql`, pinned by the block's hash).
- **The outbox** holds one row per delivery, frozen at match time, unique by `(action, key)`. Each action type has a **delivery policy** (ADR-0009): a TTL, a retry budget with backoff, then a dead letter. Every row ends **delivered**, **expired**, **dead** or **retracted**, and stays inspectable.
- **Actions** are adapters over one primitive, an authenticated `POST` carrying an `Idempotency-Key` header: `pushAction` (push-notification-server's `POST /api/push`, a token scoped to one domain; a `409`, the same key still sending, and a `502`, a failed send, are retried) and `rewardAction` (your reward service; safe lane only, retried for days). The service never submits a transaction: a mint is your reward service's job.
- **Registration** (`createRegistrationAPI`, a Hono app, served when a verifier is given): users register, renew, cancel and list their subscriptions with a proof the verifier checks. `delegatedIdentityVerifier` checks delegated-identity's, the same proof push-notification-server's `/register` takes. It answers CORS for the origin of the one app the verifier serves (its `appOrigin`, which `delegatedIdentityVerifier` sets to its `domain`'s origin), so that app's pages can call it from the browser.

## Using the core

`createTriggerService` composes, for ONE app, one consumer over one named indexer, its trigger registry, its deliverer and, with a verifier, the registration API. A platform supplies the database, the gate and a server around `service.api`:

```ts
import {canonicalFeed, createTriggerService, pushAction, rpcGate} from '@etherfold/triggers';

const service = createTriggerService({
	db, // a RemoteSQL
	app: 'greetings', // the app's slug: the key of every row it writes
	chainId: '31337',
	feed: canonicalFeed({url: 'http://localhost:34002', indexer: 'greetings'}),
	gate: rpcGate({url: 'http://localhost:8545', depth: 0}),
	definitions: {events: {/* ... */}, subscriptions: {/* ... */}, rules: {/* ... */}},
	actions: {push: pushAction({url: 'https://push.example.com/api', domain: 'greetings.example.com', token})},
});
await service.setup(); // its tables
await service.run({signal}); // or `await service.tick()` for one round
```

The trigger definitions, the actions and the verifier are written exactly as in the platform package's config file, whose README has a full example.

### Every call times out

The core bounds each call it makes to the outside by one per-call timeout, `callTimeoutMs` (10 s when absent, `DEFAULT_CALL_TIMEOUT_MS`), so a hung endpoint holds a round for at most that long ([ADR-0101](https://github.com/wighawag/etherfold/blob/main/docs/adr/0101-a-trigger-service-hosts-several-apps-in-one-app-keyed-schema-each-behind-its-own-lease.md)). The four calls it bounds:

- **the gate**: `gate({signal})`;
- **each feed read**: `feed.read(query, {signal})`;
- **each predicate invocation**: `predicate(log, recipient, {signal})`, which passes the signal on to each `state.query(document, log, variables, {signal})` it makes, so the predicate is bounded as a whole and each read is cancelled with it;
- **each delivery**: `adapter.deliver(delivery, {signal})`.

Each gets an `AbortSignal` that aborts at the timeout, and the built-ins (`canonicalFeed`, `rpcGate`, `stateReader`, `pushAction`, `rewardAction`) hand it to `fetch`. The core gives up at the timeout WHETHER OR NOT the callee honours the signal: a gate, feed, predicate or adapter of yours that ignores it still cannot hold the round past it (its promise is left to settle on its own, its result ignored). A timed-out gate, feed read or predicate fails the round with a `CallTimeoutError` (its `code` is `gate-timeout`, `feed-timeout` or `predicate-timeout`): nothing is committed for that page, it is read again next round, and the journal records `stalled` with that code and `recovered` once it moves again, as for an unreachable feed or a failing state read. A timed-out delivery is retried, like a `5xx` (backoff, then the retry budget, then a dead letter, ADR-0009, its `lastError` saying it did not answer in time); the attempt may still land at the target, which is what its idempotency key absorbs.

### One database, several apps

The schema is keyed by the APP ([ADR-0101](https://github.com/wighawag/etherfold/blob/main/docs/adr/0101-a-trigger-service-hosts-several-apps-in-one-app-keyed-schema-each-behind-its-own-lease.md)): every table carries an `app` column (the consumer's name, the `app` option) and every unique and lookup index leads with it, so services of different apps can share one database without crossing. Two apps may both name an action `push`, a subscription kind `new-greeting` or a rule key `third-greeting:<account>`: their deliveries, subscriptions, accepted requests and journal rows stay apart, and each app's deliverer sends only its own rows through its own adapters. The operator reads take the app too: `listDeliveries(db, app, filter)` and `readJournal(db, app, options)`; `service.app` names it.

There is no migration from the layout before the app key: `setup` over a database written by an earlier version refuses with `the trigger service's schema changed: every table is now keyed by app (etherfold ADR-0101), and there is no migration; start from an empty database`.

## Development

From the root of this repo, `pnpm install` and `pnpm build`, then `pnpm --filter @etherfold/triggers test`. The tests run against this workspace's own `@etherfold/server`, `core`, `processor-sqlite` and `processor-entities`, and push-notification-server's Node.js platform in process; no test opens a port.
