# Two trigger services pointed at one database cross their deliveries and their subscriptions

Observed 2026-11-26 while analysing `work/notes/ideas/a-trigger-service-that-serves-several-apps.md`, by reading `packages/triggers/src/schema.ts`, `delivery.ts` and `triggers.ts` at `5c387dff`; not reproduced by a test. The schema is only half keyed by consumer: `consumers` is keyed by name and `deliveries` carries a `consumer` column, but nothing else is. So two `etherfold-triggers` configs that name the same `database` (an easy mistake, since both default to `file:triggers.db`) share state they must not:

- `deliveries_by_key` is unique on `(action, key)`, so a delivery of app B whose action name and key collide with app A's (both call their push action `push`; a rule's semantic key such as `third-greeting:<account>` has no app in it) is silently dropped by `ON CONFLICT DO NOTHING`.
- `deliverDue` selects every due row regardless of `consumer` and sends it through ITS OWN `actions` map, so app B's process delivers app A's rows through app B's push action, under app B's domain and token, and reports them delivered.
- `subscriptions` is unique on `(kind, recipient, filter)` and the matcher looks subscriptions up by `kind` only, so a kind name both apps define is matched against both apps' registrants.
- `journal` rows name no consumer, so `etherfold-triggers journal` mixes the two.

Fix shape: key every table and every unique index by the app (the spec `one-trigger-service-serves-several-apps` does this as its schema decision), and until then make `setup` refuse a database whose `consumers` table already holds a row for a different consumer name, naming the other consumer. The guard is cheap and worth landing on its own, before the multi-app work.
