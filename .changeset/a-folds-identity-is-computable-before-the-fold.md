---
'@etherfold/processor-entities': minor
---

`entityProcessorVersionHash(processor, config)` exposes a fold's identity as a FUNCTION of what a host already holds — the declared version, the entity declarations and the processor config — so it can be computed BEFORE the processor exists.

A **generation**'s state is a table-name NAMESPACE named from `{stream digest, processor version hash}` (ADR-0053), and a generation is built STATE FIRST (ADR-0043), so the state factory has to name that namespace before the processor it will fold into has been constructed. ADR-0053 records that this is possible; this is where it is possible from.

`EntityEventProcessor.getVersionHash()` now returns exactly this call, so the two cannot diverge. That is the point, and it is not the thing ADR-0043 rejected: what was rejected was a caller DECLARING the hash beside its factory, because a declaration can silently disagree with `getVersionHash()` and would then key a store on a lie. Calling the owner's own function is the opposite of that.
