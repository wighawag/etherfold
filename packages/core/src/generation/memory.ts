import {
	openGenerationRegistry,
	SLOT_NAMES,
	type GenerationCaps,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistry,
	type GenerationRegistryPort,
	type GenerationRegistryState,
	type SlotName,
} from './registry.js';

/**
 * THE REFERENCE SUBSTRATE for the generation registry: three collections in
 * memory.
 *
 * It is here for the same reason `MemoryStateStore` is at the storage seam --
 * the rules live over a PORT, and a port with only one real implementation is a
 * claim nobody has checked. It is also what a runtime with no durable place to
 * put the records uses: a container still needs a canonical pointer to resolve
 * reads through, and a tab that holds ONE generation re-registers it on every
 * boot anyway (`create` RESOLVES an already-registered generation), so a
 * forgetful registry costs that runtime nothing.
 *
 * What it does NOT do is survive a reload, so it is the wrong substrate for a
 * deployment that keeps a superseded generation in order to move the pointer
 * BACK to it. That one wants a durable port
 * (`openGenerationRegistryOnIndexedDB` in `@etherfold/browser`).
 *
 * `commit` applies the registry's decision to the state it was just handed, in
 * one synchronous step, which is what an IndexedDB `readwrite` transaction and a
 * SQL transaction give it for real. One JS heap has no second writer to race,
 * so that is not a simplification here, it is the whole of the guarantee.
 *
 * It reports NO stream subtrees, because it stores none: the streams a runtime
 * keeps live in that runtime's keeper, under its own address. So the sweep finds
 * nothing to collect here rather than pretending to have collected something --
 * a runtime that wants its orphan subtrees swept needs a registry port that can
 * SEE them, which is exactly what the IndexedDB one is.
 */
export function createMemoryGenerationRegistryPort(options?: {
	/** Drop the state store a deleted generation folded into. Nothing, by default. */
	dropState?: (id: GenerationId) => Promise<void>;
	/**
	 * How far the fold in one generation's state got (`lastToBlock`), for a
	 * generation the asker holds no fold for. NOTHING READABLE, by default.
	 *
	 * The same injection `dropState` is, for the same reason: this substrate holds
	 * the RECORDS and knows nothing about where a caller kept the state. A caller
	 * that supplies none is saying its generations' positions cannot be read from
	 * outside a fold, and the promotion trigger then moves no pointer on its own --
	 * which is the safe direction, and never a zero (see the port's JSDoc).
	 */
	readStateCursor?: (id: GenerationId) => Promise<number | undefined>;
}): GenerationRegistryPort {
	const generations = new Map<string, GenerationRecord>();
	/**
	 * THE STREAM RECORDS: every stream this indexer holds, folded or not (ADR-0087).
	 *
	 * It doubles as this substrate's SUBTREE list, which is honest rather than a
	 * shortcut: the memory port stores no stream bytes at all, so the only thing it
	 * can enumerate is what it was told about. A runtime that wants its orphan
	 * subtrees swept needs a port that can SEE them (the IndexedDB and SQL ones).
	 */
	const streams = new Set<string>();
	// THE THREE DURABLE SLOTS -- durable everywhere but here, which is this
	// substrate's whole trade-off (see the JSDoc above): the rule is one and the
	// place it is kept is the port's.
	const slots = new Map<SlotName, GenerationId>();
	// NUL is not producible by a digest or a version hash, so it cannot be read
	// as part of either half. The map key is an implementation detail; the
	// IDENTITY stays two fields, per the registry.
	const keyOf = (id: GenerationId) => `${id.stream}\u0000${id.processor}`;
	const snapshot = (): GenerationRegistryState => ({
		generations: [...generations.values()],
		slots: Object.fromEntries([...slots].map(([name, id]) => [name, {stream: id.stream, processor: id.processor}])),
		keptStreams: [...streams],
	});

	return {
		async read() {
			return snapshot();
		},

		async commit(plan) {
			const write = plan(snapshot());
			if (!write) {
				return;
			}
			for (const id of write.remove ?? []) {
				generations.delete(keyOf(id));
			}
			if (write.put) {
				generations.set(keyOf(write.put), write.put);
			}
			// RECORDED before anything is forgotten, and forgotten last, so one commit that
			// did both ends with the stream gone: an ASKED-FOR deletion wins over the
			// registration that happens to be in the same write.
			if (write.keepStream !== undefined) {
				streams.add(write.keepStream);
			}
			for (const digest of write.forgetStreams ?? []) {
				streams.delete(digest);
			}
			for (const name of SLOT_NAMES) {
				const assigned = write.slots?.[name];
				// ABSENT leaves the slot where it is, `null` CLEARS it, an identity assigns
				// it: the three cases of `SlotAssignment`, and the reason `undefined` may
				// not be read as "clear".
				if (assigned === undefined) continue;
				if (assigned === null) {
					slots.delete(name);
				} else {
					slots.set(name, {stream: assigned.stream, processor: assigned.processor});
				}
			}
		},

		async listStreamDigests() {
			return [...streams].sort();
		},

		async dropStreamSubtree(digest) {
			return streams.delete(digest) ? 1 : 0;
		},

		async dropState(id) {
			await options?.dropState?.(id);
		},

		async readStateCursor(id) {
			return options?.readStateCursor?.(id);
		},
	};
}

/** The registry over that substrate. The caps are the caller's: nothing here has a default. */
export function openMemoryGenerationRegistry(
	caps: GenerationCaps,
	options?: {
		dropState?: (id: GenerationId) => Promise<void>;
		readStateCursor?: (id: GenerationId) => Promise<number | undefined>;
	},
): Promise<GenerationRegistry> {
	return openGenerationRegistry(createMemoryGenerationRegistryPort(options), caps);
}
