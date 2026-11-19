# @etherfold/triggers

## 0.2.0

### Minor Changes

- e248f2a: The registration API answers CORS for the app its verifier serves, so a browser app on its own origin registers its triggers directly. A preflight (`OPTIONS`) from that origin is answered `204` with `Access-Control-Allow-Origin` set to it, `Access-Control-Allow-Methods: POST,OPTIONS`, `Access-Control-Allow-Headers: content-type,signature`, an `Access-Control-Max-Age` and `Vary: Origin`; every other response, refusals included, carries the same allow-origin and `Vary`, so the app can read a refusal's reason. Another origin gets no allow-origin, never `*`, and no credentials are allowed; the proof checks, `serverOrigin` and the signed path are unchanged.
  
  - `@etherfold/triggers`: `RegistrationVerifier` takes an optional `appOrigin`, the origin `createRegistrationAPI` answers CORS for (none when absent). `delegatedIdentityVerifier` sets it to its `domain`'s origin, the one app it serves.
  - `@etherfold/triggers`: an unexpected failure inside a registration route is answered as a JSON `500 internal-error` (with the CORS headers, the cause logged and not sent) instead of being rethrown to the server, whose bare 500 a browser could not read.
  - `@etherfold/platform-nodejs-triggers`: `etherfold-triggers run` serves it with no change to a config that names a verifier.

## 0.1.0

### Minor Changes

- 6a51ff5: First release of etherfold's reference trigger service, moved into this repo from `wighawag/etherfold-triggers` with its history (ADR-0100). It runs as its own process beside `etherfold run`, never inside the indexer-server (ADR-0005), and reaches the indexer only over HTTP.
  
  - `@etherfold/triggers` (was `etherfold-triggers`, never published): the platform-neutral core. A consumer of `/{indexer}/canonical` on the safe lane that commits its cursor and the deliveries a page implies in one batch, rolls its undelivered outbox back on a rewind and pauses on a generation change; subscription triggers registered with a proof (`delegatedIdentityVerifier`, the one push-notification-server's `/register` checks) and expiring unless renewed, and global rules whose predicate may read the indexer's state as of the log's block (`stateReader`); an outbox with a per-type delivery policy (a TTL, a retry budget, a dead letter); the `pushAction` and `rewardAction` adapters; `createTriggerService` composing them.
  - `@etherfold/platform-nodejs-triggers` (was `etherfold-triggers-nodejs`, never published): the same on Node.js and libSQL, as the `etherfold-triggers` command (`run`, `tick`, `status`, `resume`, `deliveries`, `requeue`, `journal`) reading one config file. Its README is the operator guide.
  
  Both are MIT, like the rest of etherfold.
