# @etherfold/platform-nodejs-triggers

etherfold's reference trigger service on Node.js and libSQL: the `etherfold-triggers` command. One process hosts several apps from one config; each app follows its indexer's canonical feed (`etherfold run`'s `/{indexer}/canonical`) and fires authenticated, idempotent actions when a trigger matches, such as a Web Push through [push-notification-server](https://github.com/wighawag/push-notification-server) or a call to an operator's reward service.

It runs as its own process beside the indexer, never inside it ([ADR-0005](https://github.com/wighawag/etherfold/blob/main/docs/adr/0005-triggers-run-outside-the-indexer-server.md), [ADR-0100](https://github.com/wighawag/etherfold/blob/main/docs/adr/0100-the-reference-trigger-service-lives-in-this-repo-as-its-own-packages-and-runs-as-its-own-process.md)): each app owns its cursor, its gate, its outbox and its auth, in an app-keyed slice of the database it shares (or one of its own), and the indexer stores nothing about it. How it works (the consumer, the two kinds of trigger, the outbox, the actions) is in the core's README, [`@etherfold/triggers`](https://github.com/wighawag/etherfold/tree/main/packages/triggers); this package adds a libSQL database, the safe lane's RPC gate, the registration API's HTTP server and the command, and re-exports the core, so a config file imports everything from here.

## Running it

Install it in the project that holds your config module (the module imports from it), write the config, and run the command beside it:

```sh
npm i @etherfold/platform-nodejs-triggers
npx etherfold-triggers run --config triggers.config.js
```

One process hosts several APPS ([ADR-0101](https://github.com/wighawag/etherfold/blob/main/docs/adr/0101-a-trigger-service-hosts-several-apps-in-one-app-keyed-schema-each-behind-its-own-lease.md)): the config's default export is `{database?, api?, intervalMs?, apps}`, and `apps` maps each app's NAME to everything that app is: its chain, its feed (the etherfold server and named indexer it follows), its gate, its triggers, its actions with their tokens, and its verifier. A single app is an `apps` of one, so there is one shape and one route layout however many apps you run, and adding a second app changes nothing for the first. This one hosts a greetings demo and a game, on different chains and indexers:

```js
// triggers.config.js
import {
	defineConfig,
	delegatedIdentityVerifier,
	pushAction,
	rewardAction,
	stateReader,
} from '@etherfold/platform-nodejs-triggers';

const GreetingsRegistry = '0x...';
const MessageChanged = {
	type: 'event',
	name: 'MessageChanged',
	inputs: [
		{indexed: true, name: 'user', type: 'address'},
		{indexed: false, name: 'message', type: 'string'},
	],
};
const Game = '0x...';
const TurnPlayed = {
	type: 'event',
	name: 'TurnPlayed',
	inputs: [
		{indexed: true, name: 'player', type: 'address'},
		{indexed: true, name: 'next', type: 'address'},
	],
};

// the indexer's state as of a log's block, over the same etherfold server's `/graphql`
const state = stateReader({url: 'http://localhost:34002'});
const GREETINGS_OF = `query GreetingsOf($block: BlockAddress!, $account: String!) {
	greeter(where: {account: {eq: $account}}, first: 1, block: $block) { greetings }
}`;

// this service's public origin, what every app's clients sign their requests for
const serverOrigin = 'https://triggers.example.com';

export default defineConfig({
	// one database for every app, unless an app names its own; `file:triggers.db` when absent
	database: 'file:triggers.db',
	// one HTTP server for every app's registration API
	api: {port: 8787},

	apps: {
		// the app's NAME, a URL-safe slug: its routes are /greetings/subscriptions, ...
		greetings: {
			chainId: '31337',
			etherfold: {url: 'http://localhost:34002', indexer: 'greetings'},
			// the safe lane: the finalized block, or `depth` blocks below the tip on a chain without the tag
			gate: {rpcUrl: 'http://localhost:8545', depth: 0},

			triggers: {
				// what can be decoded: users never send an ABI
				events: {greeting: {address: GreetingsRegistry, abi: MessageChanged}},

				// what a user may register for themself (the recipient is whoever the proof recovers)
				subscriptions: {
					'new-greeting': {
						event: 'greeting',
						notFrom: 'user', // "from anyone but me"
						filterable: ['user'], // a registration may ask for one author only
						action: 'push',
						ttlMs: 90 * 24 * 60 * 60 * 1000, // expires unless the app renews it
						render: (log) => ({
							message: {web_push: 8030, notification: {title: 'New greeting', body: log.args.message, navigate: '/'}},
							topic: 'new-greeting',
						}),
					},
				},

				// what fires on its own, for a computed recipient
				rules: {
					'third-greeting': {
						event: 'greeting',
						recipients: (log) => log.args.user,
						// a predicate is operator code. `MessageChanged` carries no count, so it reads the
						// indexer's state as of the log's block, pinned by its hash (etherfold ADR-0011). Its
						// `signal` aborts at the per-call timeout: pass it to each read, so they are cancelled with it
						predicate: async (log, recipient, {signal}) => {
							const data = await state.query(GREETINGS_OF, log, {account: recipient}, {signal});
							return (data.greeter[0]?.greetings ?? 0) >= 3;
						},
						action: 'reward',
						// the SEMANTIC key: the same account is never rewarded twice for it
						key: (log, recipient) => `third-greeting:${recipient}`,
						render: (log, recipient) => ({achievement: 'third-greeting', account: recipient}),
					},
				},
			},

			actions: {
				// pushes under THIS app's domain, with this app's token
				push: pushAction({
					url: 'https://push.example.com/api',
					domain: 'greetings.example.com',
					token: process.env.GREETINGS_PUSH_TOKEN,
				}),
				reward: rewardAction({url: 'https://rewards.example.com/award', token: process.env.REWARD_TOKEN}),
			},

			// how a registration proves its address; without one this app serves no routes.
			// delegated-identity's proof, the one push-notification-server's `/register` checks:
			// `domain` is this app's, and a proof for any other app is refused on its routes
			verifier: delegatedIdentityVerifier({serverOrigin, domain: 'greetings.example.com'}),
			// the bound on each call to the outside (the gate, a feed read, a predicate, a delivery); 10 s when absent
			callTimeoutMs: 10_000,
			// how long this app's lease lasts (one ticker of the app at a time); 60 s when absent,
			// and the timeout plus 10 s must be under half of it
			leaseMs: 60_000,
		},

		game: {
			chainId: '10',
			etherfold: {url: 'https://indexer.example.com', indexer: 'game'},
			gate: {rpcUrl: 'https://mainnet.optimism.io'},
			// this app keeps its rows in a database of its own
			database: 'libsql://game-triggers.example.turso.io?authToken=' + process.env.GAME_DB_TOKEN,
			triggers: {
				events: {turn: {address: Game, abi: TurnPlayed}},
				subscriptions: {
					'my-turn': {
						event: 'turn',
						filterable: ['next'],
						action: 'push',
						render: () => ({message: {web_push: 8030, notification: {title: 'Your turn', navigate: '/'}}}),
					},
				},
			},
			actions: {
				// also named `push`: an action name, a subscription kind or a rule key never collides across apps
				push: pushAction({
					url: 'https://push.example.com/api',
					domain: 'game.example.com',
					token: process.env.GAME_PUSH_TOKEN,
				}),
			},
			verifier: delegatedIdentityVerifier({serverOrigin, domain: 'game.example.com'}),
		},
	},
});
```

The config's top level holds only what the process shares: `database`, `api` (`port` 8787 and `hostname` 127.0.0.1 when absent) and `intervalMs` (the wait between one app's rounds, 5000 when absent). An app's name is its key in `apps`: lower-case letters, digits and inner hyphens, at most 64 characters, so it reads cleanly in a route and a log line whatever the app's domain (`localhost:5173` included). A config whose `apps` is missing (the one-app shape of earlier versions, with `chainId`, `etherfold` and the rest at the top) is refused at start with the shape to write instead, and so is an app name that is not such a slug.

### One database, or one per app

All apps share ONE database by default (`database`, `file:triggers.db` when absent); an app that names its own `database` keeps every row there and none in the shared one. The schema is the same either way, because every row is keyed by the app ([ADR-0101](https://github.com/wighawag/etherfold/blob/main/docs/adr/0101-a-trigger-service-hosts-several-apps-in-one-app-keyed-schema-each-behind-its-own-lease.md)), so moving an app between the two is copying its rows, never a redesign. The shared database is the default for fewer moving parts, not for price: an extra database costs next to nothing on Turso or D1 (`work/notes/findings/a-database-costs-almost-nothing-on-d1-and-turso.md` in this repo). Apps naming the same URL share one connection. A database written before the app key is refused at start: start from an empty one.

### A database holds only the apps the config declares for it

At start, before any round, each database the config opens is checked against the apps the config declares FOR IT: one holding rows of any other app (an app whose consumer ran a round there) is refused, naming the app and the database (without its query string, so an `authToken` is not printed). That is what catches a config pointed at the wrong database, or a second service sharing one, before two services cross data ([ADR-0101](https://github.com/wighawag/etherfold/blob/main/docs/adr/0101-a-trigger-service-hosts-several-apps-in-one-app-keyed-schema-each-behind-its-own-lease.md)). Every command checks it, `run` and the operator commands alike.

Removing an app, or moving it to a database of its own, leaves its rows where they were: nothing is ever quietly deleted ([ADR-0012](https://github.com/wighawag/etherfold/blob/main/docs/adr/0012-triggers-expire-unless-renewed.md)). Say so with the top-level `retired`, a list of app names whose rows a database may keep where the config does not declare them:

```js
export default defineConfig({
	database: 'file:triggers.db',
	// `board` was removed, and `game` moved to its own database: their old rows stay in triggers.db
	retired: ['board', 'game'],
	apps: {
		greetings: {/* ... */},
		game: {database: 'file:game.db' /* ... */},
	},
});
```

An app may be in both `apps` and `retired`, which is the move: it runs on the database it is declared for, and its old rows in the others are left alone. `retired` never deletes or changes those rows; to bring an app back, declare it again on the database that holds its rows.

### One loop per app

`run` runs each app's own loop, concurrently, in the one process: its own consumer, cursor, gate, outbox and registration API, so one app's slow or failing round (a predicate that throws, a feed that does not answer) delays no other app's, and the journal records the stall under that app's name. Each round is bounded: at most `maxPagesPerRound` pages of the app's feed (100 when absent; a round that reaches it is not a stall, and the next starts at once) and at most `maxDeliveriesPerRound` due deliveries (100 when absent; the rest wait for the next round), both per app. What the process does NOT isolate is a synchronous infinite loop in one app's own code (a `render`, `recipients` or `predicate` that never returns without awaiting): it freezes the whole process, every app with it, because the apps share one event loop. That is acceptable because every app here is the one operator's own; running mutually untrusted apps' code in one process would need a sandbox, which this is not.

### One ticker per app

Two processes ticking one app over one database (a rolling deploy's overlap, a `tick` from cron beside a `run`) never work at once: each app's round runs under a LEASE held in its database ([ADR-0101](https://github.com/wighawag/etherfold/blob/main/docs/adr/0101-a-trigger-service-hosts-several-apps-in-one-app-keyed-schema-each-behind-its-own-lease.md)). The holder renews it under half of `leaseMs` (60 s when absent), about one row written per 30 s per app; the other reports `"lease": "not-leased"` for that app and does nothing. `run` releases its leases when it stops on SIGINT or SIGTERM, and `tick` releases them at the end of its round, so the next process ticks at once; a process that crashes holds its lease until it lapses, at most `leaseMs` later. The lease assumes the hosts' clocks agree within 5 s (NTP). A `callTimeoutMs` too long for the lease (the timeout plus 10 s not under half of `leaseMs`) is refused at start, naming both: lengthen the lease or shorten the timeout.

### A reward target

The reward service is yours. It receives, with `Authorization: Bearer <token>` and `Idempotency-Key: <key>`:

```json
{
	"key": "third-greeting:0xabc...",
	"recipient": "0xabc...",
	"reward": {"achievement": "third-greeting", "account": "0xabc..."},
	"trigger": "rule:third-greeting",
	"log": {"app": "greetings", "blockNumber": 123, "blockHash": "0x...", "logIndex": 0, "transactionHash": "0x..."}
}
```

It MUST honour the key (the same key twice is one award: answer the second with the first's `2xx`), because delivery is at-least-once. A `2xx` is delivered; `408`, `409` (the key still in flight), `429` and `5xx` are retried with backoff (`Retry-After` honoured); any other status dead-letters at once. Retries run for about five days by default before a dead letter.

### The state a predicate reads

`stateReader({url})` runs a GraphQL document against the etherfold server the consumer follows (its `/graphql`, the schema an app reads), AS OF a log's block: `state.query(document, log, variables, {signal})` (the signal optional, the predicate's own to bound it) passes `block: {hash: log.entry.blockHash}` as `$block`, which the document hands to each root field. It is the state at the end of that block, so two logs of one block see the same state; a level-triggered rule (a predicate and a semantic key) is indifferent to it. A read that cannot answer throws a `StateReadError` (a GraphQL code such as `block-not-recorded` or `block-not-retained`, `http-<status>`, or `no-answer`): the page is then not committed and is read again next round, so a trigger is never dropped because the indexer was down. The other side of that: a read that keeps failing (a broken query, a pruned block) HOLDS the consumer at that page until it answers, so nothing after it is acted on. The journal records it as `stalled` (with the error and its code, once per distinct failure) and `recovered` when it moves again; `etherfold-triggers journal` shows both. The read is pinned to a block, not to the indexer's generation: if the indexer promotes a new processor between a page and its reads, those reads answer from the new one's state, and the consumer pauses on the feed's next answer (`generation-changed`). The indexer must keep the history the consumer acts at, which is etherfold's default (`unbounded` retention); a `--retention revert-only` indexer has pruned the blocks the safe lane reads.

### Timeouts

Every call the service makes to the outside is bounded by `callTimeoutMs` (10 s when absent), so a hung endpoint holds a round for at most that long: the gate (`rpcGate`, or a gate function of yours, called with `{signal}`), each read of the canonical feed, each predicate invocation (as a whole, with the state reads it makes: pass its `{signal}` to `state.query`, as above) and each delivery (`pushAction`, `rewardAction` or an adapter of yours, called with `{signal}`). The service gives up at the timeout even when your function ignores the signal. A gate, feed read or predicate past it fails the round as a stall: nothing is committed for that page, it is read again next round, and `etherfold-triggers journal` shows `stalled` with the code `gate-timeout`, `feed-timeout` or `predicate-timeout`, then `recovered`. A delivery past it is retried like a `5xx` (backoff, then the retry budget, then a dead letter); the target may still have received it, which is why it must honour the `Idempotency-Key`.

### Registration

Each app with a verifier is served at `/{app}/...` on the one server, whatever the number of apps (`/greetings/subscriptions` and `/game/subscriptions` above); an app without a verifier serves no routes, and only its global rules fire. Each route acts for the address the proof recovers, never one the body names:

- `POST /{app}/subscriptions` `{kind, filter?}`: register, or renew the same `(kind, filter)`.
- `POST /{app}/subscriptions/renew`: renew every subscription of the prover in that app.
- `POST /{app}/subscriptions/cancel` `{kind, filter?}`.
- `POST /{app}/subscriptions/list`.

With `delegatedIdentityVerifier`, the proof is [delegated-identity](https://github.com/wighawag/delegated-identity)'s, the same a client sends to push-notification-server's `/register`, so one identity in the app registers its device there and its triggers here. Each body also carries `{address, domain, ownershipSignature}`: the wallet's address, the app's domain (a bare host, `localhost:5173` for `http://`, or an origin), and the wallet's signature authorizing the app's delegate key for that origin. The `SIGNATURE` header is the delegate key's signature over the request (`signRequest({serverOrigin, method: 'POST', path, body}, delegateKey)`, with `serverOrigin` this service's public origin and `body` the exact bytes sent). A request is refused with `401 invalid-proof` and the reason when the header is missing or malformed, its timestamp is more than a minute off, the app is not the `domain` of the app whose route it calls (a proof for one app is refused on another's routes), or the proofs do not recover `address` (another account's key, a proof signed for another app, a request signed for another route or server, a changed body). Each signed request is accepted once: a replay within the minute is refused (`replayed`), so a captured registration cannot undo a later cancel; the service remembers each accepted request until its signature would have expired anyway.

Each app's routes answer CORS for that app's origin (its verifier's `domain`'s) and no other, so the app's pages call its routes straight from the browser and no app's pages can call another's.

The routes are checked at the full path the service sees, the `/{app}` prefix included, which is the path the client signs: a client of the app `greetings` signs `/greetings/subscriptions`, and a request signed for `/subscriptions` is refused there. So serve the API at the root of `serverOrigin`: a proxy that strips a prefix or rewrites the path would refuse every request, and a `serverOrigin` with a path is refused when the verifier is built.

### Operating it

```sh
etherfold-triggers status                        # each app, where its consumer is, and why it is paused
etherfold-triggers status --app greetings        # that app only
etherfold-triggers resume                        # after a pause: the ONE paused app follows the new generation or stream
etherfold-triggers resume --app greetings        # that app, whichever others are paused
etherfold-triggers deliveries --status dead      # every app's dead letters, as JSON lines
etherfold-triggers requeue <id> [--app <name>]   # send a dead letter again
etherfold-triggers journal [--app <name>]        # rewinds, pauses, stalls, expiries, dead letters
etherfold-triggers tick [--app <name>]           # one round of every app (or of that one), then release its lease and exit
```

Every command but `run` takes `--app <name>`, the app's key in the config's `apps`: with it, the command reports or acts on that app only; an unknown name is refused before any database is opened, listing the configured apps. Without it, `status`, `deliveries`, `journal` and `tick` cover every app, one JSON line per row, each naming its `app`; `tick` exits 1 when any app's round failed, and reports that app's error beside the others' rounds. Each `tick` line says `"lease": "held"` for a round it ran, `"not-leased"` when another process held that app's lease (it did nothing), or `"lost"` when the round stopped part-way because the lease was taken (what it committed stays committed).

`status` of a paused app says why under `paused`, beside its `app`: a generation change is `{"kind": "generation-changed", "from": "<old>", "to": "<new>"}`, a refused cursor is `{"kind": "refused", ...}`. Resuming is a decision about ONE app, so `resume` without `--app` acts only when exactly one app is paused, and otherwise refuses, naming the paused apps (or saying none is), so an operator never resumes the wrong one by accident.

`requeue <id>` prints `{"app": ..., "requeued": <id>}`. With `--app`, it refuses an id whose row belongs to another app, naming that app. Without it, it works on any app's row and says which app it belonged to; when the apps keep their own databases and two of them hold a row of that id, it refuses, naming them, until `--app` picks one. Every row the service writes is keyed by its app, so `deliveries` and `journal` never mix two apps' rows under one name.

## Status

Built in steps S2a and S2b of the plan `docs/plans/template-tree-features.md` on the `work` branch of [jolly-roger](https://github.com/wighawag/jolly-roger), in its own repo (`wighawag/etherfold-triggers`), and moved here with its history in step S2c (ADR-0100). Its end to end runs jolly-roger's greetings (the `with/indexer` processor, `packages/triggers/test/greetings.test.ts`) through push-notification-server's Node.js platform in process. Not built yet: the fast lane (ADR-0007), digests (ADR-0011's coalescing), dormancy from delivery feedback (ADR-0012's fast path); see `work/notes/ideas/what-the-first-build-left-out.md`.

## Development

From the root of this repo, `pnpm install`, then this package's tests (`pnpm --filter @etherfold/platform-nodejs-triggers test`, after `pnpm build`) or the whole gate (`verify` in `dorfl.json`). No test opens a port.

## License

MIT, as the rest of etherfold ([LICENSE](../../LICENSE)).
