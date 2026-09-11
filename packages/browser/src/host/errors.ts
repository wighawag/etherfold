import {assertClonable} from './clone.js';

/**
 * A FAILURE, as it crosses a port.
 *
 * An `Error` does not survive `postMessage` as itself in any useful sense -- the
 * class is gone on the other side even where the browser clones the object -- so
 * a failure crosses as DATA and is rebuilt as an `Error` on arrival. What is kept
 * is what a caller can act on: the `name` (which is the class's own name, and is
 * therefore what a refusal is narrowed on), the message, and the refusal's own
 * fields (below).
 *
 * The `stack` is the HOST's, carried deliberately: a failure that happened inside
 * a worker and is reported in a tab has no stack a tab's debugger can show, and
 * the first thing anybody asks of a cross-boundary failure is where it came from.
 *
 * ## A REFUSAL KEEPS ITS OWN FIELDS
 *
 * The refusals this port carries are not prose with a name on top: a
 * `GenerationCapReachedError` says WHICH cap, at WHAT limit, for WHICH generation,
 * and lists the generations and streams that could be deleted to make room. An
 * app acts on those, and a crossing that kept only the sentence would leave it
 * parsing one. So `details` carries the refusal's OWN enumerable fields and
 * `errorFromPort` puts them back where the class declared them -- the failure a
 * tab catches has the shape the host's class has, minus the prototype no copy can
 * carry.
 */
export type PortError = {
	readonly name: string;
	readonly message: string;
	readonly stack?: string;
	/**
	 * The refusal's OWN fields, where it declares any: the data an app branches on.
	 *
	 * Absent where the failure carries nothing beside its message, which is most of
	 * them. A field that cannot cross (a function, a class instance -- a refusal
	 * naming the STORE it was refused by, say) is DROPPED rather than taking the
	 * whole refusal down with it: the message and the name always get through, and
	 * they are what makes it catchable at all.
	 */
	readonly details?: Readonly<Record<string, unknown>>;
};

/** Anything thrown, as the port carries it. */
export function portErrorOf(error: unknown): PortError {
	if (error instanceof Error) {
		const details = detailsOf(error);
		return {
			name: error.name,
			message: error.message,
			...(error.stack ? {stack: error.stack} : {}),
			...(details ? {details} : {}),
		};
	}
	return {name: 'Error', message: String(error)};
}

/**
 * WHAT A REFUSAL DECLARES BESIDE ITS MESSAGE, filtered to what can cross.
 *
 * `name`, `message` and `stack` are carried in their own slots and are skipped
 * here rather than sent twice. Everything else is whatever the class assigned --
 * which for this repository's refusals is the actionable half of the refusal.
 */
function detailsOf(error: Error): Record<string, unknown> | undefined {
	const details: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(error)) {
		if (key === 'name' || key === 'message' || key === 'stack') continue;
		try {
			assertClonable(value, key);
		} catch {
			// A field that cannot be cloned is dropped HERE, where the alternative is a
			// `DataCloneError` thrown while posting the answer -- which would leave the
			// tab's call with no refusal at all, in the one case where it most needs one.
			continue;
		}
		details[key] = value;
	}
	return Object.keys(details).length > 0 ? details : undefined;
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
	// Put back where the class declared them, so code written against the refusal's
	// own shape (`error.cap`, `error.candidates`) reads the same on this side of the
	// port as it does in the host. What cannot be restored is the PROTOTYPE, so
	// `instanceof` is not the narrowing here and the NAME is.
	if (error.details) {
		Object.assign(rebuilt, error.details);
	}
	if (error.stack) {
		// Kept as the HOST's stack, prefixed so nobody reads it as this thread's.
		rebuilt.stack = `${error.name}: ${error.message}\n    (raised in the indexer host)\n${error.stack}`;
	}
	return rebuilt;
}
