// ---------------------------------------------------------------------------
// THE PER-CALL TIMEOUT (etherfold ADR-0101): every call the core makes to the
// outside (the gate, a feed read, a predicate, a delivery) gets an
// `AbortSignal` that fires after the timeout, and the core gives up at the
// timeout WHETHER OR NOT the callee honours it: an operator's gate, feed,
// predicate or adapter that ignores its signal still cannot hold a round past
// it. The abandoned promise is left to settle on its own, its result ignored.
// The lease a later step adds sizes its fence margin from this bound, which is
// why it must hold even against a callee that never settles.
// ---------------------------------------------------------------------------

/** The bound on each call the core makes, when no other is given. */
export const DEFAULT_CALL_TIMEOUT_MS = 10_000;

/** The four calls the core bounds. */
export type BoundedCall = 'gate' | 'feed' | 'predicate' | 'delivery';

const WHAT: Record<BoundedCall, string> = {
	gate: 'the gate',
	feed: 'the canonical feed read',
	predicate: 'the predicate',
	delivery: 'the delivery',
};

/** A call the core gave up on at its timeout. Its `code` (`gate-timeout`, `feed-timeout`, ...) names which. */
export class CallTimeoutError extends Error {
	readonly code: `${BoundedCall}-timeout`;
	constructor(
		readonly call: BoundedCall,
		readonly timeoutMs: number,
	) {
		super(`${WHAT[call]} did not answer within ${timeoutMs} ms`);
		this.name = 'CallTimeoutError';
		this.code = `${call}-timeout`;
	}
}

/**
 * Run `call` with a signal that aborts after `timeoutMs`, and settle at the
 * timeout with a `CallTimeoutError` even when the call ignores the signal.
 */
export function withTimeout<T>(
	call: BoundedCall,
	timeoutMs: number,
	run: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			const error = new CallTimeoutError(call, timeoutMs);
			// reject first, so the timeout is what the caller sees even when the callee rejects on the abort
			reject(error);
			controller.abort(error);
		}, timeoutMs);
		Promise.resolve()
			.then(() => run(controller.signal))
			.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error: unknown) => {
					clearTimeout(timer);
					reject(error);
				},
			);
	});
}

/** A configured timeout, checked once at construction: the default when absent. */
export function callTimeoutOf(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return DEFAULT_CALL_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error(`the per-call timeout must be a positive number of milliseconds, not ${timeoutMs}`);
	}
	return timeoutMs;
}
