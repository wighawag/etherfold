---
'@etherfold/browser': minor
---

**A terminated indexer host is TOLD OF, RESTARTED, and RESUMES from the cursor** (ADR-0082).

Browsers evict workers, so a death is now an expected event with a defined outcome rather than something an app infers from a number that stopped moving. Four things happen and each is load-bearing: the app is told, every call in flight rejects with a typed error, the port starts another host, and the fold carries on from where it was.

```ts
indexer.onHostDeath(({attempt, restarting}) => {
	banner.textContent = restarting ? 'the indexer restarted' : `the indexer keeps failing (${attempt} times)`;
});
```

**`dedicatedWorkerHost` now takes the LINE THAT BUILDS a worker rather than a worker.** This is the one breaking change, and it is one arrow:

```diff
-const indexer = connectToIndexerHost(dedicatedWorkerHost(new Worker(url, {type: 'module'})));
+const indexer = connectToIndexerHost(dedicatedWorkerHost(() => new Worker(url, {type: 'module'})));
```

A hosting shape IS "how a port is obtained", so obtaining one again after a death belongs there and nowhere else. Handed an instance, a port could report a death and reject the calls and then do nothing, with nothing in the types saying the restart half was missing; handed a factory, every port can restart. `HostAccess` carries that as `reopen?`, so a shape that genuinely cannot be re-obtained (a wire somebody else owns) says `restarting: false` instead of pretending.

**Resume costs nothing and is demonstrated rather than asserted.** Nothing tells the new host where to start: the cursor is written in the same transaction as the block it describes (ADR-0027), so a host that starts reads it and carries on. The proof is a real dedicated worker terminated MID-WRITE in a real browser (`browser/restartsAndResumes.spec.ts`), asserting on the ranges the replacement asked the node for -- a restart that re-ran the load would land on identical rows and only the fetches can tell the two apart.

**In flight means REJECTED, by type.** `IndexerHostDiedError` carries the death (its cause, which consecutive attempt it was, whether a replacement is coming) and the CASE the lost call was on. It is narrowed by `instanceof`, unlike the refusals that cross the port, because it is raised in the tab about a host that is not there. A client that wants to retry can, and most already do; a silent retry would hide the event.

**A death is noticed by SILENCE, and a restart is BOUNDED.** No browser fires an event when it evicts a dedicated worker, so the port probes a host that has gone quiet (a new `ping` case) and treats an unanswered probe as a death: what is polled is liveness and never status, which stays pushed. Restarts are budgeted with a doubling backoff, and a host that stays alive long enough is settled so the count starts again -- a worker that dies on boot must not become a hot loop building workers for ever, and the app can see that is what is happening. Both are configurable and are meant to be left alone:

```ts
connectToIndexerHost(access, {watch: {everyInSeconds: 5}, restart: {attempts: 5}});
```

**Two hosts never write to one store.** The port releases the access it is replacing BEFORE it opens a successor, so a host merely suspected of being dead is terminated rather than left running beside its replacement. The writer claim (ADR-0075) sits underneath that as the guarantee rather than the mechanism: it neither blocks nor expires, so a writer killed mid-block leaves a store the next claim simply takes over.
