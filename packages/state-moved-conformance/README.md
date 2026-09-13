# @etherfold/state-moved-conformance

The conformance suite a **state-moved transport** must pass to be an _adapter_ rather than a second semantics.

[ADR-0083](../../docs/adr/0083-a-reader-is-told-the-state-moved-by-a-signal-carrying-a-coherence-token.md) decides that the side which applied the block TELLS the sides that are reading, over whichever transport a deployment has: a `MessagePort` from a worker to its tab, a `BroadcastChannel` from the indexing tab to the others, server-sent events from a hosted indexer. The whole value of that decision is that an app writes **one handler** and pointing it at a server instead of at its own browser worker is a deployment choice rather than a rewrite.

Three adapters built against one decided shape is necessary and not sufficient. Three independently-correct adapters agree on the day they are written and drift one edit at a time afterwards, each still passing the tests in its own file. This package is what stops that: **one case list, run over every transport**, asserting the app-visible outcome is identical.

## Using it

A transport supplies an adapter; it does not copy cases.

```ts
import {describeStateMovedConformance} from '@etherfold/state-moved-conformance';

await describeStateMovedConformance('the signal across a tab’s port', async () => {
	const world = await openWorld();
	return {
		onStateMoved: (handler) => world.port.onStateMoved(handler),
		applyNextBlock: () => world.applyNextBlock(),
		retract: () => world.retract(),
		promote: () => world.promote(),
		readsUpTo: () => world.readsUpTo(),
		close: () => world.close(),
	};
});
```

Every verb moves a **real fold** and lets the **real producer** publish. An adapter that pushed a value of its own onto its own channel would pass every case here while demonstrating nothing, which is precisely the failure the suite exists to catch.

## What it asks

| chapter                            | what breaks without it                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `one handler`                      | the value, the sequence, and what a reader ATTACHING is told                                       |
| `the coherence token`              | that it holds still while nothing invalidates, and rotates on a retraction and on a promotion      |
| `a dropped notification`           | that nothing is held for a reader that was away, and that it converges anyway                      |
| `coherent with what a reader reads` | that a read a notification prompted is not answered from underneath it                             |

The last chapter is selected on what the transport's READER can do. A reader with a state surface (both browser transports) is asked the coherence question. A reader with none — the server today, whose query layer is deferred to `the-same-query-runs-against-a-worker-and-a-server` — is asked how a connecting reader is told the position instead, which is how it converges with nothing to re-query. A transport offering **neither** fails a case saying so rather than silently skipping the chapter.

## Two ways to run it

`describeStateMovedConformance` registers each case as its own vitest `it`, so a divergence is reported as the behaviour that broke on the transport that broke it. `runStateMovedConformance` runs the same list without a test runner and reports which cases failed, which is how a deliberately-diverging transport can be asserted to FAIL the suite, and how a transport built outside this repository checks itself.

This package ships no tests of its own, deliberately: a case here is only worth what it does against a REAL transport, so the suite's own self-checks live where one exists. `packages/browser/test/oneHandlerForEveryTransport.test.ts` feeds `runStateMovedConformance` transports that are wrong in the three ways a real adapter goes wrong — replaying to a late joiner, re-stamping the token, dropping the retraction — plus one that answers neither convergence question, and asserts on WHICH cases went red.

## Related

- `@etherfold/state-store-conformance` — the same shape, one seam down: the suite a storage backend must pass.
- `packages/browser/browser/hostingShapes.ts` — the same shape again, for ADR-0082's three hosting shapes.
