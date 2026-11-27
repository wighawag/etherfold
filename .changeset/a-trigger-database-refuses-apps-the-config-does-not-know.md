---
'@etherfold/platform-nodejs-triggers': minor
---

`etherfold-triggers` refuses, at start, a database holding rows of an app the config neither declares for that database nor lists in the new top-level `retired: string[]` (ADR-0101), naming the app and the database (its query string, which may carry a token, left out). It catches a config pointed at the wrong database, or a second service sharing one, before two services cross data; every command checks it, `run` and the operator commands alike. `retired` is how an operator removes an app or moves it to a database of its own: its old rows stay where they were (ADR-0012), and the check lets them be. An app may be both in `apps` and in `retired` (the move): it runs on its declared database. A `retired` that is not a list of strings is refused.
