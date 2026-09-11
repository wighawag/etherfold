/**
 * A FAILURE, as it crosses a port.
 *
 * An `Error` does not survive `postMessage` as itself in any useful sense -- the
 * class is gone on the other side even where the browser clones the object -- so
 * a failure crosses as DATA and is rebuilt as an `Error` on arrival. What is kept
 * is what a caller can act on: the `name` (which is the class's own name, and is
 * therefore what a later task narrows a typed refusal on) and the message.
 *
 * The `stack` is the HOST's, carried deliberately: a failure that happened inside
 * a worker and is reported in a tab has no stack a tab's debugger can show, and
 * the first thing anybody asks of a cross-boundary failure is where it came from.
 */
export type PortError = {
	readonly name: string;
	readonly message: string;
	readonly stack?: string;
};

/** Anything thrown, as the port carries it. */
export function portErrorOf(error: unknown): PortError {
	if (error instanceof Error) {
		return {name: error.name, message: error.message, ...(error.stack ? {stack: error.stack} : {})};
	}
	return {name: 'Error', message: String(error)};
}

/**
 * The failure again, as something a tab can throw and a `catch` can read.
 *
 * The name is restored onto a plain `Error` rather than a class being guessed at:
 * a constructor this side has no reference to cannot be rebuilt, and inventing a
 * subclass per crossing would be a second vocabulary for the same failures.
 */
export function errorFromPort(error: PortError): Error {
	const rebuilt = new Error(error.message);
	rebuilt.name = error.name;
	if (error.stack) {
		// Kept as the HOST's stack, prefixed so nobody reads it as this thread's.
		rebuilt.stack = `${error.name}: ${error.message}\n    (raised in the indexer host)\n${error.stack}`;
	}
	return rebuilt;
}
