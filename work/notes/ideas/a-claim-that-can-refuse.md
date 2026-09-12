---
title: openForWriting had no way to say the store is unusable, and a wedged browser store proved it needed one
slug: a-claim-that-can-refuse
---

> **SETTLED, 2026-09-12.** `openForWriting(store, {signal})` rejects with `StoreClaimAbandonedError`. The bound is the caller's; the seam invents no timeout. What follows is the gap, the options that were weighed, and what each of the objections turned out to be worth -- kept because the shape that was reached is not the shape the obvious reading of the problem suggests.

## The gap

`openForWriting` claims a store by clearing the seam's `writerClaim` record, and its documented contract was emphatic: **"It does not block and it does not wait. There is no queue and no lease: a loser is not waiting its turn, it has lost."** The failure vocabulary that follows from that was a single verb: a writer that has lost learns so at its next mutation, as `StoreWriterChangedError`.

That vocabulary had no word for a store that will never answer. It was assumed the backend either performs the clear or throws, and one backend was measured doing neither: on WebKit a database can be left permanently unable to run any transaction (`work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`), so `clearSeamRecord('writerClaim')` never settles and `openForWriting` never returns. The host stayed in `phase: 'waiting'` for ever, with nothing to render, nothing to act on and nothing a reload would fix.

So the contract was false in both directions at once: the call DID block, for ever, and the caller was given no way to find out.

## What was built

A caller-supplied `AbortSignal`, and a typed refusal when it fires.

```ts
try {
	const store = await openForWriting(backend, {signal: AbortSignal.timeout(10_000)});
} catch (error) {
	if (error instanceof StoreClaimAbandonedError) {
		// the storage did not answer. Render something; offer a rebuild.
	}
}
```

Three properties are load-bearing and each is pinned by a test:

- **Abandoning does not cancel the claim.** There is nothing to cancel an issued IndexedDB mutation with, and a claim that lands late is still a claim. A second `openForWriting` joins the same attempt rather than issuing a second one, so a caller that retries does not take the store from itself.
- **The signal is per CALL, not per attempt.** One caller giving up must not shorten another's wait.
- **An abandoned attempt that later fails leaves no unhandled rejection**, which is the sort of thing that only shows up as a warning in someone else's console three releases later.

`StoreClaimAbandonedError.retryable` is **`true`**, unlike the seam's other two refusals. Abandoning proves nothing about the storage -- a slow open, a contended database and a permanently wedged one are indistinguishable from outside -- so asking again is legitimate, and only the first two are helped by it.

## What each objection turned out to be worth

- **"A bound is a number nobody has."** Decisive, and the reason there is no timeout in the seam and no default. Too low and a cold, contended or merely slow store is declared dead; too high and the app has been staring at a spinner. A signal moves the number to the only place that can know it, and `AbortSignal.timeout(ms)` makes the common case one line. It also means the claim's design still rests on there being no lease and no expiry: nothing here expires, a caller stops waiting.
- **"Every backend has to answer identically."** Dissolved: this is at the SEAM, above every backend, so there is nothing for `MemoryStateStore` or the SQL backend to implement and no new conformance case. The question "what does a memory store, which cannot wedge, do with a timeout?" has the answer "nothing, it has already returned".
- **"A refusal is not a recovery."** Stands, and is worse than it first looked: a reload does not clear the wedge, a new tab does not clear it, and `deleteDatabase` never completes. The only escape inside a browsing session is a DIFFERENT DATABASE NAME, which is a full re-index and a decision about the user's time that a seam cannot take on an application's behalf. The error message says so rather than implying a retry will do.
- **"It may belong one layer up."** Both, as it turned out, and not as alternatives. The mechanism belongs at the seam because that is where the truth is; the POLICY belongs in the host, and the host already had the surface for it. A rejection out of `createState` was already turned into `phase: 'refused'` with a `failure` that crosses the port (`serve.ts`), so once the claim could reject, the whole path to the tab existed. `browser/restartsAndResumes.spec.ts` asserts it end to end on a genuinely wedged WebKit database: `phase: 'refused'`, `failure.name === 'StoreClaimAbandonedError'`, in six seconds rather than never.

## What is still not decided

Whether `@etherfold/browser` should bound the claim ITSELF by default, rather than leaving every application to remember. The fixture worker passes a bound; a shipped app that forgets one is back where this started. The argument against is the same one that kept the timeout out of the seam -- the host would have to invent a number -- and the argument for is that a host already owns every other cadence in the system (watch interval, restart backoff, tip interval), so this would not be its first.
