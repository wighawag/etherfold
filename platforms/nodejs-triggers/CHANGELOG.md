# @etherfold/platform-nodejs-triggers

## 0.1.0

### Minor Changes

- 6a51ff5: First release of etherfold's reference trigger service, moved into this repo from `wighawag/etherfold-triggers` with its history (ADR-0100). It runs as its own process beside `etherfold run`, never inside the indexer-server (ADR-0005), and reaches the indexer only over HTTP.
  
  - `@etherfold/triggers` (was `etherfold-triggers`, never published): the platform-neutral core. A consumer of `/{indexer}/canonical` on the safe lane that commits its cursor and the deliveries a page implies in one batch, rolls its undelivered outbox back on a rewind and pauses on a generation change; subscription triggers registered with a proof (`delegatedIdentityVerifier`, the one push-notification-server's `/register` checks) and expiring unless renewed, and global rules whose predicate may read the indexer's state as of the log's block (`stateReader`); an outbox with a per-type delivery policy (a TTL, a retry budget, a dead letter); the `pushAction` and `rewardAction` adapters; `createTriggerService` composing them.
  - `@etherfold/platform-nodejs-triggers` (was `etherfold-triggers-nodejs`, never published): the same on Node.js and libSQL, as the `etherfold-triggers` command (`run`, `tick`, `status`, `resume`, `deliveries`, `requeue`, `journal`) reading one config file. Its README is the operator guide.
  
  Both are MIT, like the rest of etherfold.

### Patch Changes

- Updated dependencies [6a51ff5]
  - @etherfold/triggers@0.1.0
