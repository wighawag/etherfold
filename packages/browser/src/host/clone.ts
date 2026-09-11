/**
 * WHAT MAY CROSS A PORT, checked where the value is WRITTEN.
 *
 * A port carries messages between a **host** and a tab, and `postMessage` copies
 * them with the structured clone algorithm. So a value that cannot be cloned is
 * not a value that arrives wrong -- it is a `DataCloneError` thrown out of
 * `postMessage`, at the boundary, naming nothing useful: the browser reports the
 * offending OBJECT and not the FIELD it sat in, and the stack is the port's
 * rather than the caller's.
 *
 * This walks a message before it is posted and refuses it NAMING THE PATH, which
 * is the whole difference between "an object could not be cloned" and
 * "`progress.response.value.store` is a `IndexedDBStateStore` instance". Every
 * case a later task adds to the envelope is checked by the same walk for free,
 * which is why the check lives on the envelope rather than in each case.
 *
 * ## Why a CLASS INSTANCE is refused rather than allowed
 *
 * Because structured clone does not refuse it: it copies the own enumerable
 * properties, DROPS the prototype, and hands the other side a lifeless bag with
 * no methods. That is the failure this guard exists to catch -- a store handle, a
 * processor, a provider or a view sent across "successfully" and then failing on
 * the first call, one layer away from anything that would explain it. A plain
 * data object (`{...}`, `Object.create(null)`), an array, a `Map`, a `Set`, a
 * `Date`, a `RegExp`, an `Error`, an `ArrayBuffer` and its views are all carried
 * by clone AS THEMSELVES and are therefore let through.
 *
 * Values that a processor closes over -- functions and symbols -- are refused
 * first and by type, since they are the ordinary mistake: a processor is code and
 * closures and CANNOT cross, which is why the app authors the worker entry and
 * imports it there instead (ADR-0082).
 */

/**
 * A value the port refuses to carry, NAMING WHERE IT WAS.
 *
 * A `TypeError` because it is a fact about the value's type rather than about
 * the port's state: the same value is refused identically on every attempt, and
 * no retry, reconnection or restart makes it crossable.
 */
export class UnclonableValueError extends TypeError {
	/** The path to the offending value inside the message, e.g. `progress.response.rows[3].read`. */
	readonly path: string;

	constructor(path: string, reason: string) {
		super(`${path} cannot cross the indexer port: ${reason}`);
		this.name = 'UnclonableValueError';
		this.path = path;
	}
}

/** What structured clone carries AS ITSELF, so there is nothing inside to walk. */
function isCarriedWhole(value: object): boolean {
	if (value instanceof Date || value instanceof RegExp || value instanceof Error) return true;
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
	// Guarded, because these exist in a browser and not in the node runs of this
	// package's own tests.
	if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
	return false;
}

/** A data object: a literal, or one built with no prototype at all. */
function isPlainObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function nameOf(value: object): string {
	return value.constructor?.name ?? 'prototype-less';
}

function walk(value: unknown, path: string, seen: Set<object>): void {
	if (value === null || value === undefined) return;

	const kind = typeof value;
	if (kind === 'function') {
		throw new UnclonableValueError(
			path,
			`a function is CODE, and a port carries data only. A processor, a provider or a callback reaches the host ` +
				`by being IMPORTED in the worker entry point, never by being sent (ADR-0082).`,
		);
	}
	if (kind === 'symbol') {
		throw new UnclonableValueError(path, `a symbol is unique to the context that made it, so a copy of it is not it.`);
	}
	if (kind !== 'object') return;

	const object = value as object;
	// A cycle is fine -- structured clone preserves it -- and revisiting one here
	// would not terminate.
	if (seen.has(object)) return;
	seen.add(object);

	if (Array.isArray(object)) {
		object.forEach((element, index) => walk(element, `${path}[${index}]`, seen));
		return;
	}
	if (object instanceof Map) {
		let index = 0;
		for (const [key, entry] of object) {
			walk(key, `${path}.keys()[${index}]`, seen);
			walk(entry, `${path}.values()[${index}]`, seen);
			index++;
		}
		return;
	}
	if (object instanceof Set) {
		let index = 0;
		for (const entry of object) {
			walk(entry, `${path}.values()[${index}]`, seen);
			index++;
		}
		return;
	}
	if (isCarriedWhole(object)) return;

	if (!isPlainObject(object)) {
		throw new UnclonableValueError(
			path,
			`a \`${nameOf(object)}\` instance would be cloned as a BAG OF ITS OWN PROPERTIES with its prototype dropped, ` +
				`so the other side would hold a copy with none of its methods. Send the data it holds, or keep the object ` +
				`in the host and add a CASE to the port for what the tab wanted to ask it.`,
		);
	}

	for (const [key, entry] of Object.entries(object)) {
		walk(entry, `${path}.${key}`, seen);
	}
}

/**
 * REFUSE a value the port cannot carry, before `postMessage` is reached.
 *
 * `path` names where the value is, from the caller's point of view, and is what
 * the refusal message leads with -- so make it the thing the author of the value
 * would recognise (`the 'progress' response`, not `argument 1`).
 */
export function assertClonable(value: unknown, path: string): void {
	walk(value, path, new Set<object>());
}
