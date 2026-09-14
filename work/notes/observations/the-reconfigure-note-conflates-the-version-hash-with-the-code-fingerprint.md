---
title: 'The reconfigure note says a generation identity hashes handler SOURCE; it hashes the DECLARED version, so an ordinary handler edit registers nothing'
slug: the-reconfigure-note-conflates-the-version-hash-with-the-code-fingerprint
observed: 2026-09-14
---

2026-09-14 — Noticed while building `an-endpoint-triggers-a-reconfigure-in-a-running-process`. Hazard 2 of `work/notes/observations/a-reconfigure-cannot-reach-a-running-run.md` (and the task body derived from it) says the processor half of a generation identity is "a hash whose code fingerprint hashes the SOURCE TEXT of the author's handlers", and concludes that "an ordinary dev edit does change source text, so this is a secondary hazard rather than the common case". Both halves are wrong the same way: the identity is `getVersionHash()`, which is `${version}-${simple_hash({entities, config})}` (`entityProcessorVersionHash`, `packages/processor-entities/src/EntityEventProcessor.ts`), and `getCodeFingerprint()` is a SEPARATE, advisory value that `packages/core/src/utils/fingerprint.ts` says in as many words stays out of the version hash (a deliberate deviation from ADR-0008). `CONTEXT.md`'s own `generation` entry has it right.

So the frequency estimate is inverted: an edit to a handler BODY alone leaves the identity where it was, and a re-read of it is legitimately a no-op. That does not change the endpoint's design — it strengthens the reason the endpoint must report `unchanged` distinctly — but the two notes will mislead whoever reads them next. Not fixed here: correcting another item's body is not this task's work.
