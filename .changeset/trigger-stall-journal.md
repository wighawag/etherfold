---
'@etherfold/triggers': patch
---

A round's `stalled` and `recovered` journal entries are now confirmed written before the service remembers them: a guarded journal row carries `RETURNING`, so a lease lost just before the write stops the round (`lost`, with `followFailure`) instead of silently dropping the entry, and the next round that holds the lease journals it. A journal write that fails for another reason no longer holds back the round's deliveries: they go out, then the round reports its failure.
