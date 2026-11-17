# etherfold-triggers

A generic trigger service for [etherfold](https://github.com/wighawag/etherfold): it follows an indexer's canonical feed (`etherfold run`'s `/{indexer}/canonical`) and fires authenticated, idempotent actions when a trigger matches, such as a Web Push through [push-notification-server](https://github.com/wighawag/push-notification-server) or a call to an operator's reward service.

Triggers run outside the indexer by design (etherfold ADR-0005): this service owns its database, its cursor, its gate, its outbox and its auth, and the indexer stores nothing about it. The rules it implements are etherfold's ADRs [0005](https://github.com/wighawag/etherfold/blob/main/docs/adr/0005-triggers-run-outside-the-indexer-server.md), [0007](https://github.com/wighawag/etherfold/blob/main/docs/adr/0007-consumers-gate-themselves-safe-and-fast-lanes.md), [0009](https://github.com/wighawag/etherfold/blob/main/docs/adr/0009-actions-are-idempotent-http-calls-with-per-type-delivery-policy.md), [0011](https://github.com/wighawag/etherfold/blob/main/docs/adr/0011-bound-triggers-by-delivery-rate-and-deliver-digests.md), [0012](https://github.com/wighawag/etherfold/blob/main/docs/adr/0012-triggers-expire-unless-renewed.md) and [0013](https://github.com/wighawag/etherfold/blob/main/docs/adr/0013-trigger-conditions-are-data-actions-are-code.md).

## How it works

- **The consumer** reads the canonical view page by page at or below a **gate** (the safe lane: the chain's `finalized` block, or `latest - depth`), matches each log, and commits the page's deliveries together with the cursor in one batch. A crash re-reads the page; the idempotency key absorbs anything matched twice. A rewind (`409 rewind-required`) retracts what was not yet sent from the fork block on, and records it. A change of the fold answering the feed (its `generation`) PAUSES the consumer until an operator resumes it.
- **Two kinds of trigger** (ADR-0013): a **subscription** is registered by a user for themself, of a kind the operator declared, filtered on decoded arguments, and it expires unless renewed (ADR-0012); a **global rule** is the operator's code over every log of an event, whose recipient is computed and whose predicate decides.
- **The outbox** holds one row per delivery, frozen at match time, unique by `(action, key)`. Each action type has a **delivery policy** (ADR-0009): a TTL, a retry budget with backoff, then a dead letter. Every row ends **delivered**, **expired**, **dead** or **retracted**, and stays inspectable.
- **Actions** are adapters over one primitive, an authenticated `POST` carrying an `Idempotency-Key` header: `pushAction` (push-notification-server's `POST /api/push`, a token scoped to one domain; a `409`, the same key still sending, and a `502`, a failed send, are retried) and `rewardAction` (your reward service; safe lane only, retried for days). The service never submits a transaction: a mint is your reward service's job.

## Packages

| Package                                         |                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| [`etherfold-triggers`](packages/triggers)       | the core, platform-neutral (a `remote-sql` database and a `fetch`) |
| [`etherfold-triggers-nodejs`](platforms/nodejs) | the `etherfold-triggers` CLI, on libSQL                            |

## Running it

Write a config module and run the CLI beside it:

```sh
etherfold-triggers run --config triggers.config.js
```

```js
// triggers.config.js
import {defineConfig, pushAction, rewardAction} from 'etherfold-triggers-nodejs';

const GreetingsRegistry = '0x...';
const MessageChanged = {
	type: 'event',
	name: 'MessageChanged',
	inputs: [
		{indexed: true, name: 'user', type: 'address'},
		{indexed: false, name: 'message', type: 'string'},
	],
};

export default defineConfig({
	chainId: '31337',
	database: 'file:triggers.db',
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
			'first-greeting': {
				event: 'greeting',
				recipients: (log) => log.args.user,
				// a predicate is operator code: a point read of the indexer's state as of
				// `log.entry.blockHash` goes here (etherfold ADR-0011)
				predicate: async (log, recipient) => true,
				action: 'reward',
				// the SEMANTIC key: the same account is never rewarded twice for it
				key: (log, recipient) => `first-greeting:${recipient}`,
				render: (log, recipient) => ({achievement: 'first-greeting', account: recipient}),
			},
		},
	},

	actions: {
		push: pushAction({
			url: 'https://push.example.com/api',
			domain: 'greetings.example.com',
			token: process.env.PUSH_TOKEN,
		}),
		reward: rewardAction({url: 'https://rewards.example.com/award', token: process.env.REWARD_TOKEN}),
	},

	// how a registration proves its address; without one the registration API is not served.
	// The shared ownership proof of push-notification-server (its S1-3) is the one to use.
	// verifier: {...},
	api: {port: 8787},
});
```

### A reward target

The reward service is yours. It receives, with `Authorization: Bearer <token>` and `Idempotency-Key: <key>`:

```json
{
	"key": "first-greeting:0xabc...",
	"recipient": "0xabc...",
	"reward": {"achievement": "first-greeting", "account": "0xabc..."},
	"trigger": "rule:first-greeting",
	"log": {"consumer": "greetings", "blockNumber": 123, "blockHash": "0x...", "logIndex": 0, "transactionHash": "0x..."}
}
```

It MUST honour the key (the same key twice is one award: answer the second with the first's `2xx`), because delivery is at-least-once. A `2xx` is delivered; `408`, `409` (the key still in flight), `429` and `5xx` are retried with backoff (`Retry-After` honoured); any other status dead-letters at once. Retries run for about five days by default before a dead letter.

### Registration

With a verifier configured, the service serves (every body carries a `proof`; the recipient is the address the proof recovers, never one the body names):

- `POST /subscriptions` `{kind, filter?, proof}`: register, or renew the same `(kind, filter)`.
- `POST /subscriptions/renew` `{proof}`: renew every subscription of the prover.
- `POST /subscriptions/cancel` `{kind, filter?, proof}`.
- `POST /subscriptions/list` `{proof}`.

### Operating it

```sh
etherfold-triggers status                     # where the consumer is, and why it is paused
etherfold-triggers resume                     # after a pause: follow the new generation or stream
etherfold-triggers deliveries --status dead   # the dead letters, as JSON lines
etherfold-triggers requeue <id>               # send a dead letter again
etherfold-triggers journal                    # rewinds, pauses, expiries, dead letters
etherfold-triggers tick                       # one round, then exit
```

## Status

Step S2a of the plan `docs/plans/template-tree-features.md` on the `work` branch of [jolly-roger](https://github.com/wighawag/jolly-roger): the core, tested against the repo's own test contract folded by an in-process etherfold server and recording targets. Not built yet: the fast lane (ADR-0007), digests (ADR-0011's coalescing), dormancy from delivery feedback (ADR-0012's fast path), and the production verifier on push-notification-server's shared ownership proof with an end to end on GreetingsRegistry (step S2b).

## Development

```sh
pnpm install
pnpm format:check && pnpm build && pnpm typecheck && pnpm test   # the gate, `verify` in dorfl.json
```

No test opens a port.

## License

[AGPL-3.0-only](LICENSE).
