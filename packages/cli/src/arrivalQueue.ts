import type {GenerationId} from '@etherfold/core';

/**
 * ONE LINE every ARRIVAL on a process waits in: `work` runs after whatever was
 * queued before it, whichever arrival queued it.
 *
 * The hazard it removes: two uploads landing together (a watcher firing twice in
 * quick succession) would otherwise both decide "is this identity already held"
 * against the same registry at the same time, and both could register. Debouncing
 * belongs to the watcher; not tripping over a burst belongs here. The queue never
 * carries a rejection forward: each arrival reports its own failures as outcomes,
 * and a caller's own handler sees anything else.
 *
 * It is a line for ARRIVALS rather than for uploads, and exported as such, because
 * the hazard is not per arrival: a process that answered a second one would share
 * this line with the upload rather than keep its own. Today the upload on
 * `etherfold node` is the only arrival a Node process answers (ADR-0094).
 */
export type ArrivalQueue = <T>(work: () => Promise<T>) => Promise<T>;

/** A fresh `ArrivalQueue`, for ONE process's arrivals to share. */
export function arrivalQueue(): ArrivalQueue {
	let queue: Promise<unknown> = Promise.resolve();
	return <T>(work: () => Promise<T>): Promise<T> => {
		const next = queue.then(work, work);
		queue = next.catch(() => undefined);
		return next;
	};
}

/** Whether two generation identities are the same one. */
export function sameIdentity(a: GenerationId, b: GenerationId): boolean {
	return a.stream === b.stream && a.processor === b.processor;
}
