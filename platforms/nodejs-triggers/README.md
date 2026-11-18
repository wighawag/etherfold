# @etherfold/platform-nodejs-triggers

etherfold's reference trigger service on Node.js and libSQL: the `etherfold-triggers` command. It follows an indexer's canonical feed (`etherfold run`'s `/{indexer}/canonical`) and fires authenticated, idempotent actions when a trigger matches, such as a Web Push through [push-notification-server](https://github.com/wighawag/push-notification-server) or a call to an operator's reward service.

It runs as its own process beside the indexer, never inside it ([ADR-0005](https://github.com/wighawag/etherfold/blob/main/docs/adr/0005-triggers-run-outside-the-indexer-server.md), [ADR-0100](https://github.com/wighawag/etherfold/blob/main/docs/adr/0100-the-reference-trigger-service-lives-in-this-repo-as-its-own-packages-and-runs-as-its-own-process.md)): it owns its database, its cursor, its gate, its outbox and its auth, and the indexer stores nothing about it. How it works (the consumer, the two kinds of trigger, the outbox, the actions) is in the core's README, [`@etherfold/triggers`](https://github.com/wighawag/etherfold/tree/main/packages/triggers); this package adds a libSQL database, the safe lane's RPC gate, the registration API's HTTP server and the command, and re-exports the core, so a config file imports everything from here.

## Running it

Install it in the project that holds your config module (the module imports from it), write the config, and run the command beside it:

```sh
npm i @etherfold/platform-nodejs-triggers
npx etherfold-triggers run --config triggers.config.js
```

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

// the indexer's state as of a log's block, over the same etherfold server's `/graphql`
const state = stateReader({url: 'http://localhost:34002'});
const GREETINGS_OF = `query GreetingsOf($block: BlockAddress!, $account: String!) {
	greeter(where: {account: {eq: $account}}, first: 1, block: $block) { greetings }
}`;

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
			'third-greeting': {
				event: 'greeting',
				recipients: (log) => log.args.user,
				// a predicate is operator code. `MessageChanged` carries no count, so it reads the
				// indexer's state as of the log's block, pinned by its hash (etherfold ADR-0011)
				predicate: async (log, recipient) => {
					const data = await state.query(GREETINGS_OF, log, {account: recipient});
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
		push: pushAction({
			url: 'https://push.example.com/api',
			domain: 'greetings.example.com',
			token: process.env.PUSH_TOKEN,
		}),
		reward: rewardAction({url: 'https://rewards.example.com/award', token: process.env.REWARD_TOKEN}),
	},

	// how a registration proves its address; without one the registration API is not served.
	// delegated-identity's proof, the one push-notification-server's `/register` checks:
	// `serverOrigin` is this service's public origin (what clients sign for), `domain` the ONE app it serves
	// (the push action pushes under one domain, so one service serves one app)
	verifier: delegatedIdentityVerifier({
		serverOrigin: 'https://triggers.example.com',
		domain: 'greetings.example.com',
	}),
	api: {port: 8787},
});
```

### A reward target

The reward service is yours. It receives, with `Authorization: Bearer <token>` and `Idempotency-Key: <key>`:

```json
{
	"key": "third-greeting:0xabc...",
	"recipient": "0xabc...",
	"reward": {"achievement": "third-greeting", "account": "0xabc..."},
	"trigger": "rule:third-greeting",
	"log": {"consumer": "greetings", "blockNumber": 123, "blockHash": "0x...", "logIndex": 0, "transactionHash": "0x..."}
}
```

It MUST honour the key (the same key twice is one award: answer the second with the first's `2xx`), because delivery is at-least-once. A `2xx` is delivered; `408`, `409` (the key still in flight), `429` and `5xx` are retried with backoff (`Retry-After` honoured); any other status dead-letters at once. Retries run for about five days by default before a dead letter.

### The state a predicate reads

`stateReader({url})` runs a GraphQL document against the etherfold server the consumer follows (its `/graphql`, the schema an app reads), AS OF a log's block: `state.query(document, log, variables)` passes `block: {hash: log.entry.blockHash}` as `$block`, which the document hands to each root field. It is the state at the end of that block, so two logs of one block see the same state; a level-triggered rule (a predicate and a semantic key) is indifferent to it. A read that cannot answer throws a `StateReadError` (a GraphQL code such as `block-not-recorded` or `block-not-retained`, `http-<status>`, or `no-answer`): the page is then not committed and is read again next round, so a trigger is never dropped because the indexer was down. The other side of that: a read that keeps failing (a broken query, a pruned block) HOLDS the consumer at that page until it answers, so nothing after it is acted on. The journal records it as `stalled` (with the error and its code, once per distinct failure) and `recovered` when it moves again; `etherfold-triggers journal` shows both. The read is pinned to a block, not to the indexer's generation: if the indexer promotes a new processor between a page and its reads, those reads answer from the new one's state, and the consumer pauses on the feed's next answer (`generation-changed`). The indexer must keep the history the consumer acts at, which is etherfold's default (`unbounded` retention); a `--retention revert-only` indexer has pruned the blocks the safe lane reads.

### Registration

With a verifier configured, the service serves these routes. Each acts for the address the proof recovers, never one the body names:

- `POST /subscriptions` `{kind, filter?}`: register, or renew the same `(kind, filter)`.
- `POST /subscriptions/renew`: renew every subscription of the prover.
- `POST /subscriptions/cancel` `{kind, filter?}`.
- `POST /subscriptions/list`.

With `delegatedIdentityVerifier`, the proof is [delegated-identity](https://github.com/wighawag/delegated-identity)'s, the same a client sends to push-notification-server's `/register`, so one identity in the app registers its device there and its triggers here. Each body also carries `{address, domain, ownershipSignature}`: the wallet's address, the app's domain (a bare host, `localhost:5173` for `http://`, or an origin), and the wallet's signature authorizing the app's delegate key for that origin. The `SIGNATURE` header is the delegate key's signature over the request (`signRequest({serverOrigin, method: 'POST', path, body}, delegateKey)`, with `serverOrigin` this service's public origin and `body` the exact bytes sent). A request is refused with `401 invalid-proof` and the reason when the header is missing or malformed, its timestamp is more than a minute off, the app is not the configured `domain`, or the proofs do not recover `address` (another account's key, a proof signed for another app, a request signed for another route or server, a changed body). Each signed request is accepted once: a replay within the minute is refused (`replayed`), so a captured registration cannot undo a later cancel; the service remembers each accepted request until its signature would have expired anyway.

The routes are checked at the path the service sees, which is the path the client signs, so serve the API at the root of `serverOrigin`: a proxy that strips a prefix or rewrites the path would refuse every request, and a `serverOrigin` with a path is refused when the verifier is built.

### Operating it

```sh
etherfold-triggers status                     # where the consumer is, and why it is paused
etherfold-triggers resume                     # after a pause: follow the new generation or stream
etherfold-triggers deliveries --status dead   # the dead letters, as JSON lines
etherfold-triggers requeue <id>               # send a dead letter again
etherfold-triggers journal                    # rewinds, pauses, stalls, expiries, dead letters
etherfold-triggers tick                       # one round, then exit
```

## Status

Built in steps S2a and S2b of the plan `docs/plans/template-tree-features.md` on the `work` branch of [jolly-roger](https://github.com/wighawag/jolly-roger), in its own repo (`wighawag/etherfold-triggers`), and moved here with its history in step S2c (ADR-0100). Its end to end runs jolly-roger's greetings (the `with/indexer` processor, `packages/triggers/test/greetings.test.ts`) through push-notification-server's Node.js platform in process. Not built yet: the fast lane (ADR-0007), digests (ADR-0011's coalescing), dormancy from delivery feedback (ADR-0012's fast path); see `work/notes/ideas/what-the-first-build-left-out.md`.

## Development

From the root of this repo, `pnpm install`, then this package's tests (`pnpm --filter @etherfold/platform-nodejs-triggers test`, after `pnpm build`) or the whole gate (`verify` in `dorfl.json`). No test opens a port.

## License

MIT, as the rest of etherfold ([LICENSE](../../LICENSE)).
