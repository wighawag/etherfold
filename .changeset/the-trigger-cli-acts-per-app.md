---
'@etherfold/platform-nodejs-triggers': minor
'@etherfold/triggers': minor
---

The `etherfold-triggers` operator commands take `--app <name>` (ADR-0101): `status`, `deliveries`, `journal` and `tick` report or run that app only (without it, every app, each JSON line naming its app), and an unknown name is refused, listing the configured apps. `resume` without `--app` resumes the one paused app and refuses when several are paused (naming them) or none is; `resume --app <name>` resumes that app only, the others untouched. `requeue <id>` now prints `{"app", "requeued"}`; with `--app` it refuses a row of another app, naming it, and without it it finds the app the row belongs to (refusing, naming them, when apps on their own databases share the id). `NodeService.tick(only?)` runs the named apps only. In the core, `listDeliveries`' filter takes an `id`.
