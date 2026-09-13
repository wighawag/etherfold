/**
 * HOW LONG AN INDEXER WAITS FOR ITS STORE'S WRITER CLAIM, in one place.
 *
 * `openForWriting` takes a claim with one round trip to the storage, and a
 * storage that never answers makes that hang for ever. That is measured, not
 * theoretical: on WebKit a database can be left permanently unable to run ANY
 * transaction, so the claim never lands and an application sits in `waiting` with
 * nothing to render and nothing to act on
 * (`work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`),
 * which is exactly the silence ADR-0082 exists to abolish.
 *
 * The SEAM deliberately invents no timeout -- there is no number that is right
 * for a cold mobile browser, a contended database and a server at once, so
 * `openForWriting` takes a signal and no default. A HOST is a different
 * proposition: it already owns every other cadence in the system (the watch
 * interval, the restart backoff, the tip interval), so owning this one is not a
 * new kind of decision, and it is the only place that can hand an application a
 * bound it did not have to think of.
 *
 * ## What it does NOT bound
 *
 * The signal is sized for ONE transaction and belongs on the claim alone. A
 * `createState` may legitimately take minutes -- installing a published snapshot
 * over a mobile connection is the documented example -- and bounding that would
 * refuse healthy deployments on every engine, which is a worse bug than the one
 * this avoids. So this is handed to the factory rather than wrapped around it:
 * the host cannot see the claim inside an application's factory, and pretending
 * otherwise would put a ten-second limit on a snapshot download.
 *
 * That makes forwarding a CONVENTION rather than a guarantee, and it is the
 * honest limit of what a host can do here: a factory that drops the signal waits
 * for ever exactly as it did before. Every documented example forwards it.
 */

/**
 * Ten seconds: a thousand times a healthy claim, and far inside the point at
 * which a person decides an application is broken.
 *
 * A claim is a single `readwrite` transaction over one key. It lands in
 * single-digit milliseconds on every engine this package ships to, including
 * under the load of a fold, so anything near this bound means the storage is not
 * answering rather than that it is busy.
 */
export const DEFAULT_CLAIM_WITHIN_SECONDS = 10;

/** What a state factory is handed beside its context. */
export type ClaimPatience = {
	/** Aborts once the host's patience for the writer claim has run out. */
	readonly signal: AbortSignal;
};

/**
 * Run a state factory with a bounded claim signal, and clean the timer up.
 *
 * The timer is cleared on every exit, so a host that opens many generations does
 * not accumulate one pending timeout per generation for as long as its patience
 * lasts.
 */
export async function withClaimPatience<T>(
	withinSeconds: number | undefined,
	run: (patience: ClaimPatience) => T | Promise<T>,
): Promise<T> {
	const seconds = withinSeconds ?? DEFAULT_CLAIM_WITHIN_SECONDS;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error(`the writer claim did not land within ${seconds}s`)),
		seconds * 1000,
	);
	try {
		return await run({signal: controller.signal});
	} finally {
		clearTimeout(timer);
	}
}
