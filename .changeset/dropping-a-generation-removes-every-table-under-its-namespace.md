---
'@etherfold/state-store-sqlite': patch
---

`VersionedStateStore.drop()` now also removes every entity table under its namespace that its own declarations do not name. A host drops a generation through a store built over the processor it holds now, which is not necessarily the processor that created that generation's tables (an uploaded successor that declared an extra entity, later replaced or reclaimed by a process configured with another), and those extra tables used to be left behind. A namespace has no underscore, so `<namespace>_*` is exactly that namespace's entity tables. An unnamespaced store is unchanged.
