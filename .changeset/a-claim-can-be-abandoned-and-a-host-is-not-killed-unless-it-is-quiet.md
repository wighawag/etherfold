---
'@etherfold/state-store': minor
'@etherfold/browser': minor
---

**A claim can be abandoned, and a host is no longer killed unless it is known to be quiet.** Two halves of the same failure: a store that can never answer, and the port that was helping to create it.

## `openForWriting(store, {signal})`

`openForWriting` claimed and its contract said it "does not block and it does not wait". That was true of the QUEUE -- there is no lease and no turn to take -- and false of the call, which awaits one round trip to the storage. A storage that never answers made it hang for ever, and there was no vocabulary for that: an application sat in `phase: 'waiting'` with nothing to render, nothing to act on and nothing a reload would fix.

```ts
try {
	const store = await openForWriting(backend, {signal: AbortSignal.timeout(10_000)});
} catch (error) {
	if (error instanceof StoreClaimAbandonedError) {
		// the storage did not answer. Render something; offer a rebuild.
	}
}
```

**The bound is the caller's and the seam invents none.** No timeout is defaulted anywhere, because there is no number that is right for a cold mobile browser, a contended database and a server at once, and turning "slow" into "failed" on a guess is how a working deployment acquires a mystery.

**Abandoning does not cancel the claim.** There is nothing to cancel an issued IndexedDB mutation with, and a claim that lands late is still a claim, so a second `openForWriting` joins the same attempt rather than issuing a second one -- a caller that retries cannot take the store from itself. The signal applies per CALL rather than to the shared attempt, so one caller giving up never shortens another's wait, and an attempt that is walked away from and later fails leaves no unhandled rejection behind.

`StoreClaimAbandonedError.retryable` is **`true`**, unlike `StoreWriterChangedError` and the caller-bug refusals. Abandoning proves nothing about the storage: a slow open, a contended database and a permanently wedged one are indistinguishable from outside, and only the first two are helped by asking again. Its message says so, and says that a store which never answers is not always recoverable, because on the measured case it is not: no reload, no new tab, and `deleteDatabase` never completes.

This is at the SEAM, above every backend, so no store implements anything and no conformance case changes.

## The port stops killing hosts it only suspects are dead

`HostAccess.close` now takes `{quiesced}`, and `dedicatedWorkerHost` calls `Worker.terminate()` only when it is `true`.

The port used to kill on both release paths. The justification was that a dedicated worker belongs to the tab that made it, so killing it is free, and that killing before a restart is what stops a second writer. The second half was never load-bearing -- ADR-0075's writer token is what stops a second writer, and it stops one that survived a failed kill too -- and the first half is measurably false: ending a worker that has a `readwrite` and a `readonly` transaction in flight can leave its IndexedDB database permanently unable to run any transaction on WebKit. A death is concluded from SILENCE, so the host being killed was overwhelmingly likely to be one that was BUSY. The port was manufacturing the failure mode it exists to survive.

- **`port.close()`** now asks the host to `stopIndexing` first and releases it with `{quiesced: true}` when it answers. That answer is a promise that the cycle in flight LANDED and no other will start, which is exactly the quiet a shape needs before it may kill anything. It still returns immediately and everything an app can observe is unchanged: no further events, every call in flight rejected at once.
- **A concluded death** releases with `{quiesced: false}`, and a shape that would otherwise kill declines. The worker is abandoned instead.

Abandoning leaks a thread, and the leak is bounded by a fact worth stating: a dedicated worker cannot outlive the document that created it. One idle worker until the page goes away, against a local index the user cannot get back. A SharedWorker is unaffected -- it has no kill to gate, since it is serving other tabs.

`close` gaining a required argument is the only breaking edge, and only for code that implements `HostAccess` by hand; the three shapes this package ships handle it.
