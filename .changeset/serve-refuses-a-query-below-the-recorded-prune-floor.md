---
'@etherfold/state-store-sqlite': patch
'etherfold': patch
---

The SQLite accessor (`VersionedStateStore.accessor()`, ADR-0099) now refuses an as-of `find` or `children` read below `retainedFrom()`, not only below the retention its own handle claims: a block below the floor a prune pass RECORDED in the database throws `BlockNotRetainedError` (`reason: 'outside-window'`, `retained` naming the blocks storage still holds), so `etherfold serve`, which opens the database with no retention of its own, answers a GraphQL `block:` below the writer's prune floor with `block-not-retained` instead of from partly deleted history. A database that was never pruned is answered exactly as before, and a `revert-only` store still refuses every block. `etherfold` gains a test proving it end to end over `serve`'s `/graphql`.
