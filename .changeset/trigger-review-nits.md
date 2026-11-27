---
'@etherfold/triggers': minor
'@etherfold/platform-nodejs-triggers': minor
---

Follow-ups to the multi-app trigger service's review. Core: a lease that a guarded write finds lost forgets the expiry it held, so the next tick reports `not-leased` rather than `lost`; a round whose feed failed journals the stall before it delivers, and when a delivery then loses the lease the `lost` report carries the feed's failure (`followFailure`); the settle, retry and requeue statements name the app too; a subscription kind declaring more than `MAX_FILTERABLE` (48) filterable arguments is refused by `defineTriggers`, as its match query would pass D1's 100 bound parameters. Platform: a config's top level is refused when it holds anything but `database`, `api`, `intervalMs`, `retired` and `apps` (a per-app setting misplaced there was silently ignored); apps naming one `file:` database spelled two ways share one connection, compared by absolute path, so the start-up guard no longer refuses them.
