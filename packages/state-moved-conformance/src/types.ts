import type {StateMovedDetach, StateMovedHandler} from '@etherfold/core';

/**
 * ONE TRANSPORT UNDER TEST: how a reader ATTACHES to it, and how the fold behind
 * it is MOVED.
 *
 * This is the whole of what adding a transport costs. ADR-0083 says the
 * `MessagePort`, the `BroadcastChannel` and the server's stream are ADAPTERS over
 * one notification model rather than three semantics, which is a claim nothing
 * could check until all three existed: three independently-correct adapters agree
 * on the day they are written and drift one edit at a time afterwards, each still
 * passing its own file's tests. So the cases are ONE list and a transport supplies
 * this instead of copying them.
 *
 * ## What a transport must NOT do here
 *
 * It must not fabricate a notification. Every verb below moves a REAL fold and
 * lets the REAL producer publish; what the adapter owns is the two ends -- how a
 * block is made to land, and how a reader's handler is attached -- and nothing
 * in between. An adapter that pushed a value of its own onto its own channel
 * would pass every case here while demonstrating nothing, which is precisely the
 * failure this suite exists to catch.
 *
 * ## The verbs RESOLVE when the FOLD has moved, not when the reader has been told
 *
 * Delivery is best-effort and asynchronous on all three transports (a
 * `postMessage`, a channel hop, a chunk on a socket), so a case that assumed a
 * notification had arrived by the time `applyNextBlock` resolved would be a race
 * on two of them and not on the third. The suite waits on VALUES instead
 * (`watch`), and these verbs owe only that the producer has published by the time
 * they answer.
 */
export type StateMovedTransport = {
	/**
	 * ATTACH AN APP'S HANDLER at the READER end of this transport. Returns the
	 * detach.
	 *
	 * The handler is `StateMovedHandler`, `@etherfold/core`'s own, which is the
	 * shape ADR-0083 defines once so that the transports adapt to it rather than
	 * inventing three attach conventions. A transport that needed a handler of a
	 * different shape here would not compile, which is the check: the suite's cases
	 * attach the SAME handler function to all three (`readerRule`).
	 */
	onStateMoved(handler: StateMovedHandler): Promise<StateMovedDetach> | StateMovedDetach;
	/**
	 * MAKE THE CANONICAL FOLD APPLY ITS NEXT BLOCK, and answer which block that
	 * was.
	 *
	 * One block per call, so a case can assert on a SEQUENCE rather than on a set:
	 * a transport that coalesced two notifications into one, or reordered them,
	 * fails a case here rather than being discovered by an app.
	 */
	applyNextBlock(): Promise<number>;
	/**
	 * MAKE THE CANONICAL FOLD APPLY A BLOCK THAT TOUCHES NO ENTITY, and answer
	 * which block that was.
	 *
	 * The block is APPLIED -- it carries an event the fold decodes and hands to a
	 * handler -- and the handler mutates nothing, so the changed-set is empty. That
	 * is the ordinary case of a handler with a branch it did not take, and it is a
	 * different thing from a scanned range carrying no logs, which applies no block
	 * and publishes nothing because there is none to name (ADR-0083).
	 *
	 * It is REQUIRED rather than optional, and that is the point. "One notification
	 * per APPLIED block" is one rule rather than two, so an empty changed-set is a
	 * notification with `entities: []` and never a silence -- and a transport is
	 * exactly where that rule gets quietly "improved", by a layer that sees an empty
	 * array and concludes there is nothing worth posting. A reader that is not told
	 * has no way to distinguish it from a fold that has stopped.
	 */
	applyNextEmptyBlock(): Promise<number>;
	/**
	 * MAKE THE CHAIN TAKE A BRANCH BACK, and answer the FORK POINT the fold
	 * reverted to.
	 *
	 * CAUSED and never faked: story 15 of the spec asks for the reorg case to be
	 * tested by causing a reorg rather than by asserting a message shape, and an
	 * adapter that posted a hand-written `{kind: 'retracted'}` would be asserting
	 * its own literal. What a transport does here is serve a different branch, or
	 * push a block back under a different hash, and let the fold conclude what it
	 * concludes.
	 */
	retract(): Promise<number>;
	/**
	 * MOVE THE CANONICAL POINTER onto a different generation.
	 *
	 * It PUBLISHES nothing, deliberately -- a pointer move has no block to name and
	 * no fold applied anything -- so what a reader sees of it is the NEXT
	 * notification, wearing a token it has never held and naming the generation
	 * that answers now. The case asserts exactly that, which is why this verb does
	 * not answer anything.
	 */
	promote(): Promise<void>;
	/**
	 * WHAT A READ ANSWERS, as the HIGHEST BLOCK that answer accounts for.
	 *
	 * Present where this transport's reader has a state surface to re-read, which
	 * is what the notification is FOR: the browser transports both have one (a
	 * tab's port proxies the store's reads; a reader tab opens the same storage for
	 * reading). It is ABSENT on the server, which exposes status, ingest, feed and
	 * admin and no state query surface at all -- the query layer is deferred to
	 * `the-same-query-runs-against-a-worker-and-a-server` -- and such a transport
	 * owes `positionOnConnect` instead. One or the other is REQUIRED: see
	 * `stateMovedConformanceCases`.
	 */
	readsUpTo?(): Promise<number | undefined>;
	/**
	 * WHAT A READER IS TOLD WHEN IT CONNECTS, for a transport where connecting is
	 * an event at all.
	 *
	 * This is how a remote reader CONVERGES with no state surface to re-query: it
	 * is told the position and the token at once, so a reconnecting client knows
	 * immediately whether what it holds is stale (ADR-0083). A fresh reader end is
	 * opened and its opening frame read; nothing is subscribed by it.
	 */
	positionOnConnect?(): Promise<ConnectPosition>;
	/** Let go of the reader end and the fold behind it. Called once per case. */
	close(): Promise<void>;
};

/**
 * WHERE THE FOLD IS, as a connecting reader is told it.
 *
 * `lastToBlock` is absent before the fold has applied anything, on the
 * absent-rather-than-zeroed rule the browser's progress already follows: "it has
 * folded nothing yet" and "it is level at block 0" are different claims.
 */
export type ConnectPosition = {
	/** How far the canonical fold has got. Absent before it has folded a batch. */
	readonly lastToBlock?: number;
	/** The **coherence token** in force. COMPARE it, never parse it. */
	readonly coherence: string;
};

/**
 * How the suite gets a transport to interrogate: ask, get one.
 *
 * Called ONCE PER CASE, so every case starts from a fold that has applied
 * nothing and no case can be poisoned by another -- the same promise
 * `StateStoreFactory` makes about a fresh store. What a factory must NOT do is
 * vary what it OFFERS between calls: the suite reads the optional members from a
 * probe and selects the cases the transport has said it can answer.
 */
export type StateMovedTransportFactory = () => Promise<StateMovedTransport> | StateMovedTransport;

/**
 * One conformance case: a name, and a function that throws if the transport is
 * wrong.
 *
 * Data rather than registered tests, which is what lets the suite be run in the
 * two ways that both matter -- the same shape `@etherfold/state-store-conformance`
 * has, for the same reason. A transport's test file turns each case into a vitest
 * `it` (`describeStateMovedConformance`), so a failure is reported as the
 * BEHAVIOUR that broke on THAT transport. `runStateMovedConformance` runs them
 * without a test runner, which is how a deliberately-diverging transport can be
 * asserted to FAIL and how a transport outside vitest can check itself.
 */
export type ConformanceCase = {
	/** The chapter this case belongs to, e.g. `the coherence token`. */
	readonly group: string;
	/** What the case asserts, phrased as the behaviour an app can rely on. */
	readonly name: string;
	/** Runs the case against a fresh transport from the factory. Throws on failure. */
	run(): Promise<void>;
};

/** A case that did not hold, with the assertion error that says why. */
export type ConformanceFailure = {
	readonly group: string;
	readonly name: string;
	readonly error: unknown;
};

/** What a whole run came to. `failures` empty is what "one notification model" means. */
export type ConformanceResult = {
	readonly passed: number;
	readonly failures: readonly ConformanceFailure[];
};
