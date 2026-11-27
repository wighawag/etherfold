---
'@etherfold/triggers': minor
'@etherfold/platform-nodejs-triggers': patch
---

The idempotency key `pushAction` and `rewardAction` send is now the delivery's key prefixed by its app (`<app>:<key>`, exported as `wireKeyOf`), in the `Idempotency-Key` header and in the reward body's `key`, so two apps sharing one reward service or one push domain never have one app's call absorbed as a replay of the other's (ADR-0101). A reward service sees new keys: an award already granted under the bare key would be granted once more. The tick's subscription expiry now re-checks the expiry as it writes, so a renewal landing between its read and its write is never overwritten, and only a subscription it actually expired is journalled. `etherfold-triggers run` refuses `--app` instead of silently serving every app.
