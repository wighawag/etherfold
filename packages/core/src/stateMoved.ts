import {logs} from 'named-logs';

const namedLogger = logs('@etherfold/core');

/* ---------------------------------------------------------------------------
 * THE SIGNAL: the side that APPLIED a block tells the sides that are READING.
 *
 * A client can read the state and has no way to know when to read it again, and
 * every direction this project goes breaks the one answer that worked (an app
 * subscribing to a store in the indexer's own heap): the fold moves into a
 * worker, a query surface replaces the handle, a remote indexer has no shared
 * heap at all, one tab indexes and the others do not. ADR-0083 decides the
 * answer, and this module is the WHOLE of the producer's half of it: the shape
 * that goes out, the token that makes best-effort delivery safe, and the
 * subscription that holds NOTHING per subscriber.
 *
 * What it is NOT is a delivery of DATA. It says WHAT MOVED so a reader re-reads
 * through the surface it already has -- no rows, no mutations, no state handle.
 * A reader handed the delta applies it by hand, and applying a delta by hand is
 * exactly what goes wrong at the next reorg.
 * ------------------------------------------------------------------------- */

/**
 * WHAT GOES OUT when a fold applied a block: four facts and nothing else.
 *
 * A reader's whole rule is two lines, and this payload exists to make those two
 * lines possible:
 *
 * - **token unchanged** -> invalidate NARROWLY, using `entities`;
 * - **token changed** -> invalidate EVERYTHING.
 *
 * `generation` is deliberately NOT part of that rule and must never be folded
 * into the token: the token says WHETHER what a reader holds may be stale and is
 * never parsed, so it can NAME nothing, while `generation` is a fact a reader
 * RENDERS and compares so that a refetch after a promotion is not silently
 * answered by a different lineage (ADR-0083).
 *
 * It crosses every transport unchanged: a `MessagePort` from a worker to its
 * tab, a `BroadcastChannel` from the indexing tab to the others, SSE or a socket
 * from a server. Those are ADAPTERS over this; an app writes one handler.
 */
export type StateMoved = {
	/** The block that was just applied. */
	block: number;
	/**
	 * Opaque. COMPARE it, never parse it. Changes when cached data may be stale.
	 *
	 * It is what makes best-effort delivery SAFE rather than merely cheap. "A
	 * missed notification is repaired by the next one" is true for an APPEND and
	 * false for a RETRACTION: after a reorg the stale entities are the ones the
	 * ABANDONED branch touched, and those are generally not in the changed-set of
	 * whatever block arrives next, so a reader that missed the retraction and
	 * invalidated narrowly on the next append would keep dead-branch rows on
	 * screen indefinitely. The next notification already carries a DIFFERENT
	 * token, so a missed retraction is self-correcting for the cost of one field.
	 */
	coherence: string;
	/**
	 * Entity NAMES this block touched. Bounded by the declaration, not by block
	 * size.
	 *
	 * NAMES and never ids in this version: the payload is then O(schema) rather
	 * than O(mutations), which is what stops the worst block on the real measured
	 * stream (457 mutations against a median of 7) producing a 457-element
	 * message. Ids can be ADDED later as an optional field without breaking a
	 * reader, while they could not be removed -- and shipping them early invites a
	 * reader to apply the delta by hand instead of re-reading.
	 *
	 * EMPTY is a real answer, and it is the honest one twice over: a block whose
	 * handlers produced no mutation touched no entity, and a fold with no entity
	 * declarations has no names to report. Narrow invalidation then degrades to
	 * whatever the token says, which is correct if coarse.
	 */
	entities: readonly string[];
	/** WHICH generation answered, so a refetch is not served by another lineage. */
	generation: string;
};

/**
 * THE APP-FACING HANDLER, and it is a plain callback.
 *
 * Defined once, here, so the transports that follow ADAPT to one shape rather
 * than inventing three attach conventions a later task has to reconcile. Plain
 * because every client library's invalidation API is one
 * (`invalidateQueries`, `refetchQueries`, `reexecuteOperation`), so nothing more
 * elaborate is needed and anything more elaborate will not fit them.
 */
export type StateMovedHandler = (moved: StateMoved) => void;

/**
 * Detach a handler. Returned by `subscribe`, so subscribing and unsubscribing
 * are symmetric and a caller never has to keep the handler around to remove it.
 */
export type StateMovedDetach = () => void;

/**
 * A COHERENCE TOKEN: a value only THIS producer, at THIS point in its history,
 * could have produced.
 *
 * OPAQUE, and the only question ever asked of it is whether two of them are
 * byte-identical. It is deliberately not a counter and not derived from
 * anything a reader could recompute: a reader that could derive it would be
 * deciding invalidation for itself, and the whole point is that the side which
 * applied the block decides and the reader compares. A counter would also
 * repeat across a restart, which is the one case where an unchanged token would
 * be a lie -- a rebuilt fold saying "nothing you hold is stale".
 *
 * Same construction as `@etherfold/state-store`'s writer token, for the same
 * reason and deliberately not shared: core cannot depend on the storage seam
 * (ADR-0016). `crypto.randomUUID` is present on Node, Workers and browsers; the
 * fallback is for a host that predates it.
 */
export function coherenceToken(): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	return (
		uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
	);
}

/**
 * THE PRODUCER'S HALF, as ONE assembly both containers hold.
 *
 * There are two things in this system that apply blocks -- the chain-facing
 * `Indexer` and the chain-free `ReceivingIndexer` -- and ADR-0083 says both
 * publish THE SAME signal FROM THE SAME ASSEMBLY, because one notification model
 * is the claim being made and two producers that drift is how that claim dies.
 * So the subscription, the containment and the token live here, and a container
 * supplies only what a container knows: which block, which generation, and
 * whether the fold that applied it is the one that answers reads.
 *
 * ## It holds NOTHING per subscriber
 *
 * Nothing is buffered, nothing is retried, nothing is remembered about who is
 * listening: one handler reference each, and that is the whole of it. That is
 * what stops a SharedWorker's memory growing with the number of open tabs, and
 * it is the property every transport downstream depends on, so it belongs here
 * rather than in each of them. A client that missed a notification is repaired
 * by the next one plus the token, which is the trade ADR-0083 makes explicitly.
 */
export class StateMovedPublisher {
	/** The subscribers, and the ONLY thing that scales with them. */
	private readonly handlers = new Set<StateMovedHandler>();
	/** The token every notification carries until something INVALIDATES. */
	private coherence: string = coherenceToken();

	/**
	 * BE TOLD THE STATE MOVED. Returns the detach.
	 *
	 * ```ts
	 * const detach = indexer.onStateMoved(({entities, coherence}) => {
	 *   if (coherence !== held) return queryClient.invalidateQueries();
	 *   for (const entity of entities) queryClient.invalidateQueries({queryKey: [entity]});
	 * });
	 * ```
	 *
	 * Best-effort: a handler is called as the block lands and is never called
	 * again for one it missed.
	 */
	subscribe(handler: StateMovedHandler): StateMovedDetach {
		this.handlers.add(handler);
		return () => {
			this.handlers.delete(handler);
		};
	}

	/** How many handlers are attached. Reported so a test can see that nothing else is kept. */
	get subscriberCount(): number {
		return this.handlers.size;
	}

	/** The token every notification is currently carrying. */
	get token(): string {
		return this.coherence;
	}

	/**
	 * ROTATE THE TOKEN: something happened that may have made ANYTHING a reader
	 * holds wrong.
	 *
	 * ONE LINE AT THE POINT WHERE THE REASON OCCURS, which is the whole shape of
	 * it: a RETRACTION rotates it because the stale entities are the abandoned
	 * branch's and no changed-set names them, and a PROMOTION rotates it because a
	 * different fold now answers, which from a cache's point of view is
	 * indistinguishable from "everything you hold may be wrong". One comparison
	 * and one code path rather than two. Both of those callers are their own
	 * tasks; what is here is the rotation they call.
	 *
	 * `reason` is LOGGED and never published: the token names nothing, because a
	 * reader that could read a reason out of it would be parsing it.
	 */
	rotate(reason: string): string {
		this.coherence = coherenceToken();
		namedLogger.info(`the coherence token rotated: ${reason}`);
		return this.coherence;
	}

	/**
	 * PUBLISH one applied block, stamped with the token in force.
	 *
	 * The token is stamped HERE rather than supplied by the caller, so that a
	 * producer cannot publish a token it has not rotated and a reader cannot be
	 * told two different things by two call sites.
	 *
	 * A THROWING HANDLER IS CONTAINED, exactly as `onStateUpdated` already
	 * contains one: it is caught and logged, never propagated. A subscriber is
	 * somebody else's code, and letting it break the fold would make the fold's
	 * correctness depend on every reader's.
	 */
	publish(moved: Omit<StateMoved, 'coherence'>): void {
		if (this.handlers.size === 0) {
			return;
		}
		const notification: StateMoved = {...moved, coherence: this.coherence};
		for (const handler of [...this.handlers]) {
			try {
				handler(notification);
			} catch (err) {
				namedLogger.error(`onStateMoved handler threw`, err);
			}
		}
	}
}
