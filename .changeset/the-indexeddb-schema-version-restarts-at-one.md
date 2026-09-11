---
'@etherfold/state-store-indexeddb': patch
---

**The IndexedDB schema version restarts at 1**, because the ladder it had climbed was a ladder for databases that do not exist.

`SCHEMA_VERSION` had reached 3, narrating three changes to this package's object stores (the cursor store, the writer token, and the seam's own records taking the writer store over). Nothing is published, so no browser anywhere holds a database an earlier build created, and every step of that ladder was an upgrade nothing could ever perform. A reader met migration notes for a population of zero.

What is KEPT is the mechanism, which needs no history to be useful: `open(name, version)` takes a version whatever we do, `upgrade` is written to CONVERGE rather than to step (every creation is `contains`-guarded, so one function brings a database at any earlier version to the declared shape), and the rule for when to bump is now stated forwards -- when THIS PACKAGE adds or renames an object store, which a processor declaring one more entity never does.

There is nothing to migrate and nothing that could be: a database created by a previous build of this unpublished package would be at a HIGHER version than this one opens at, which IndexedDB refuses. Delete it, or use a different `databaseName`.
