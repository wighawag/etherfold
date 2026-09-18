import {logs} from 'named-logs';

const namedLogger = logs('@etherfold/core');

/**
 * THE GENERATION REGISTRY: which generations an indexer holds, which SLOT holds
 * each of them, what a cap refuses, and what is swept because nothing claims it.
 *
 * A **generation** is a stream plus a fold over it. An indexer holds any number
 * of them; ONE is canonical and answers every read. Reconfiguring builds a new
 * generation beside the live one and moves the pointer when it is ready, which
 * is why a reconfigure is not an outage -- and moving the pointer BACK is how a
 * processor change that made the state worse is reverted, with no re-index and
 * no fetch.
 *
 * This module is BOOKKEEPING and nothing else. It never fetches, never folds,
 * never opens a state store, and holds no reference to a chain: everything here
 * is exercisable with no indexer running, which is the point. The rules live
 * here once, over a port, exactly as `createSegmentedStream` does, so a second
 * substrate (SQL for a server, another keeper in a browser) supplies five
 * operations and inherits all of them.
 *
 * What is deliberately NOT here:
 *
 * - **The promotion POLICY.** WHEN the pointer moves automatically -- on
 *   catch-up, immediately, or never -- needs a running indexer and is
 *   `the-promotion-policy-moves-the-canonical-pointer`. This owns the pointer as
 *   a MECHANISM: move it, read it, move it back.
 * - **Eviction.** A cap REFUSES and names what to delete. See
 *   `GenerationCapReachedError`.
 * - **Where a generation's state store lives.** Dropping one is a port
 *   operation the host supplies, because the container above `StateStore` that
 *   decides that is a later task.
 */

/**
 * WHICH generation: the stream it folds, and the processor that folds it.
 *
 * The two halves are the whole identity. The stream digest (`streamDigestOf`)
 * already covers the fetch filter AND the stream config, so naming the config
 * again here would be redundant; the processor half covers what the fold MEANS. A
 * processor change is therefore a new generation over the SAME stream and
 * re-fetches nothing, and a filter or config change is a new stream.
 *
 * Kept as two FIELDS and never packed into one delimited string: a composite key
 * whose parts can be compared element by element cannot confuse one component's
 * rendering with another's, which is the hazard the stream address removed by
 * addressing hierarchically (ADR-0036).
 */
export type GenerationId = {
	/** The stream digest, as `streamDigestOf` renders it. */
	readonly stream: string;
	/**
	 * WHAT THE FOLD IS CALLED: the identity the ARRIVAL that produced it derived
	 * (ADR-0086) -- the SHA-256 of a bundle's octets where a deployment read one off
	 * disk, and a derivation over the handler sources for the one arrival that has no
	 * bytes. An author cannot state it and no part of this package computes one.
	 *
	 * An OPAQUE string, and that is load-bearing rather than incidental: this
	 * registry COMPARES it for equality and RENDERS it into messages, nothing in this
	 * tree parses it, and that is exactly what lets the arrivals derive one their own
	 * way without this package knowing there is more than one way.
	 */
	readonly processor: string;
};

/** A registered generation: its identity, plus when it was registered. */
export type GenerationRecord = GenerationId & {
	/**
	 * When it was created, in ms since the epoch.
	 *
	 * ORDERING only, never identity: it is what puts "the previous generation"
	 * in a defined place in a listing an operator reads when a cap tells them to
	 * delete something, and it is what `writerOf` reads to name the oldest
	 * surviving generation on a stream.
	 *
	 * STRICTLY INCREASING within one registry, so it is a registration ORDER and
	 * not merely a timestamp: `create` takes `max(now, newest + 1)`. A wall clock
	 * has millisecond resolution, and two generations registered in one
	 * millisecond used to tie -- after which `byAge` broke the tie on the processor
	 * HASH and `writerOf` could name a SUCCESSOR as the writer of a stream its
	 * incumbent already wrote, giving one stream two writers (ADR-0072). The
	 * identity tie-break below is KEPT, and not only for totality: a registry
	 * WRITTEN BY AN EARLIER BUILD can still hold two records that tie, and nothing
	 * repairs those on open. So the guarantee is precise -- no two records CREATED by
	 * this code can tie -- and a legacy tie still resolves by hash, deterministically
	 * and stably, which is what it always did. Nothing is published yet
	 * (`CONTEXT.md`), so that legacy set is empty today; a deployment that predates
	 * this and holds a tied pair is the case that would want a repair-on-open, and it
	 * does not exist.
	 */
	readonly createdAt: number;
};

/**
 * THE THREE DURABLE NAMED SLOTS a generation can be held by (ADR-0084).
 *
 * A slot is an ASSIGNMENT: a durable name POINTING AT a generation, exactly as
 * `canonical` already was before there were three of them. It is deliberately
 * NOT part of `GenerationId`: identity is content-addressed (ADR-0053,
 * ADR-0036), so a slot inside the identity would make the same content under two
 * slots into TWO generations, two state namespaces and two folds of one stream.
 *
 * - **`canonical`** -- what answers every read. Unchanged by slots existing: it
 *   is simply the first slot, and the one a registry takes for the first
 *   generation registered.
 * - **`successor`** -- the generation being built beside the incumbent. It holds
 *   AT MOST ONE, so registering into an occupied `successor` REPLACES its
 *   occupant, whatever stream either sits on. That is the whole of "a second save
 *   replaces the first pending successor", and because the fact is a ROW it
 *   survives a restart, which no in-memory rule can.
 * - **`predecessor`** -- what a revert moves back to: the generation the pointer
 *   was last moved OFF. It is ASSIGNED by the move that creates one and is never
 *   INFERRED, because it cannot be: with the pointer at C and a newer generation
 *   N, "N was never canonical" and "N was canonical and the pointer was reverted
 *   away from it" are indistinguishable from the rows (ADR-0084).
 *
 * There are EXACTLY three and arbitrary named slots are deliberately not built:
 * with three fixed names each word means one thing, and a generation is a
 * successor exactly when the `successor` slot names it. A generation no slot
 * names, and that is not canonical, is GARBAGE -- which is a refcount, and far
 * easier to prove safe than the three-way in-memory predicate it replaced.
 */
export const SLOT_NAMES = ['canonical', 'successor', 'predecessor'] as const;

/** WHICH slot: one of exactly three. See `SLOT_NAMES`. */
export type SlotName = (typeof SLOT_NAMES)[number];

/** What each slot NAMES, as identities: the registry's durable assignments. */
export type GenerationSlots = {readonly [Name in SlotName]?: GenerationId};

/** What each slot names, RESOLVED against the records. See `GenerationRegistry.slots`. */
export type SlottedGenerations = {readonly [Name in SlotName]?: GenerationRecord};

/**
 * A SLOT ASSIGNMENT as a WRITE: an identity ASSIGNS, `null` CLEARS, and an absent
 * name leaves that slot exactly where it is.
 *
 * The three cases are distinct on purpose. "Leave it" is what a write that is not
 * about slots says (a registration that resolves, a cap-free put), `null` is what
 * a deletion says about the slots naming what it removed, and only an identity
 * moves one. `canonical` is never written as `null` by anything here: a registry
 * that holds generations and points at none of them answers nothing.
 */
export type SlotAssignment = {readonly [Name in SlotName]?: GenerationId | null};

/** The same, writable, for building one up. */
type SlotAssignmentDraft = {-readonly [Name in SlotName]?: GenerationId | null};

/** A COUNT of generations or streams an indexer may hold. Never *retention*. */
export type GenerationCaps = {
	/**
	 * How many generations this indexer may hold, IN TOTAL and never per stream.
	 *
	 * Per-stream would let total growth scale with the stream count, leaving the
	 * resource anyone actually cares about -- total storage, total state stores --
	 * unbounded. It is a CONFIGURED number, and it must never be derived from
	 * `navigator.storage.estimate()`: WebKit does not implement it, `quota` varies
	 * four-fold between engines and moves between runs on one, and with a real
	 * quota forced down to 8 MB it still reported 6.45 GB of headroom while writes
	 * were failing (`work/notes/findings/browser-storage-headroom-for-generations.md`).
	 * A pre-flight check against that number is worse than no check.
	 */
	readonly maxGenerations: number;
	/** How many distinct streams -- distinct fetch filters -- this indexer may hold. */
	readonly maxStreams: number;
};

/** Everything the registry holds, as one consistent read. */
export type GenerationRegistryState = {
	readonly generations: readonly GenerationRecord[];
	/** WHICH generation each of the three slots names, or nothing where a slot is empty. */
	readonly slots: GenerationSlots;
};

/**
 * What ONE commit writes.
 *
 * `remove` runs before `put`, and `slots` is applied last: a write may remove a
 * generation and clear the slots that named it in the same commit, which is what
 * keeps a slot from ever naming a record that has gone. An absent slot name means
 * LEAVE IT WHERE IT IS rather than clear it; see `SlotAssignment`.
 */
export type GenerationRegistryWrite = {
	readonly remove?: readonly GenerationId[];
	readonly put?: GenerationRecord;
	readonly slots?: SlotAssignment;
};

/**
 * What a SUBSTRATE supplies, scoped to ONE named indexer.
 *
 * Five operations, and the split between them is the design. `read` and
 * `commit` are the registry's own records, and `commit` takes a DECISION
 * FUNCTION rather than a write, for the same reason `commitSegmentWithCursor`
 * does: the decision (is this already registered, does it breach a cap) has to
 * be made from the CURRENT state INSIDE the substrate's transaction. Two tabs
 * that both read "one generation, cap two" and then both wrote would leave three
 * generations under a cap of two, with nothing afterwards able to tell. The
 * function is synchronous because inside a transaction there is nothing it could
 * legitimately await, and it may THROW: a refusal is a decision made on the
 * state the transaction read.
 *
 * The other three reach OUTSIDE the registry's own records, and each of them is
 * a fact only the runtime knows: which stream subtrees exist, how a subtree is
 * dropped, and how a generation's state store is dropped. That last one is
 * injected rather than derived because WHERE a generation's state lives is
 * decided by the container above `StateStore`, which is a later task; the
 * registry must not fork a naming convention it does not own.
 */
export type GenerationRegistryPort = {
	/** Every registered generation and every slot assignment, as one read. */
	read(): Promise<GenerationRegistryState>;
	/**
	 * Read, decide and write in ONE transaction.
	 *
	 * `plan` is handed the current state and returns what to write, or
	 * `undefined` to write nothing at all. A throw from `plan` propagates and
	 * nothing is written.
	 */
	commit(plan: (current: GenerationRegistryState) => GenerationRegistryWrite | undefined): Promise<void>;
	/**
	 * Every stream digest that has a SUBTREE on the substrate under this indexer
	 * name, whether or not the registry has ever heard of it.
	 *
	 * The registry's knowledge is deliberately not consulted here: this is the
	 * other half of the comparison the sweep is.
	 */
	listStreamDigests(): Promise<string[]>;
	/** Delete one stream's whole subtree. Returns how many records went. */
	dropStreamSubtree(digest: string): Promise<number>;
	/** Drop the state store this generation folded into. */
	dropState(id: GenerationId): Promise<void>;
};

/** What `deleteGeneration` did. */
export type GenerationDeletion = {
	readonly generation: GenerationRecord;
	/** The stream that was reaped with it, if this was its last generation. */
	readonly reaped: string | undefined;
	/**
	 * How many substrate records the reaped subtree held, and `undefined` where no
	 * stream was reaped.
	 *
	 * REPORTED rather than counted by a caller, for the reason `StreamDeletion`
	 * already reports it: only the port that dropped the subtree knows what was in
	 * it, and an operator reclaiming disk is asking exactly that question. It is a
	 * COUNT OF RECORDS and never a size in bytes, which no substrate here can answer.
	 */
	readonly records: number | undefined;
};

/** What `deleteStream` did. */
export type StreamDeletion = {
	readonly generations: readonly GenerationRecord[];
	readonly digest: string;
	/** How many substrate records the dropped subtree held. */
	readonly records: number;
};

/**
 * A cap reached: the new generation is REFUSED, and what could be deleted to
 * make room is NAMED.
 *
 * **It never evicts, and that is the decision.** Eviction picks a victim by a
 * policy that cannot know which generation an operator was deliberately keeping
 * -- and keeping a superseded generation so the pointer can move BACK to it is
 * the whole reason non-canonical generations are retained. A refusal costs one
 * operator action; a wrong eviction costs a re-index, which on a public node,
 * where old logs are frequently not served at all, may not even be available.
 *
 * So the candidates are EVERY generation that may be deleted (every one that is
 * not canonical) rather than a chosen one. Naming them is information; picking
 * one would be the policy this refuses to have.
 */
export class GenerationCapReachedError extends Error {
	readonly name = 'GenerationCapReachedError';

	constructor(
		/** Which cap: a COUNT of generations, or a COUNT of streams. */
		readonly cap: 'maxGenerations' | 'maxStreams',
		/** The configured number this indexer may not exceed. */
		readonly limit: number,
		/** The generation that was refused. Nothing was written for it. */
		readonly refused: GenerationId,
		/** Every generation that CAN be deleted: all of them but the canonical one. */
		readonly candidates: readonly GenerationId[],
		/** Every stream `deleteStream` would accept: those holding no canonical generation. */
		readonly candidateStreams: readonly string[],
	) {
		super(
			`this indexer is at its ${cap} of ${limit}, so the generation ` +
				`{stream: ${refused.stream}, processor: ${refused.processor}} is REFUSED. Nothing has been evicted: an ` +
				`old generation is what the canonical pointer moves BACK to, and no policy can know which one you were ` +
				`keeping. Delete one of these first, then create it again -- ` +
				(cap === 'maxStreams'
					? `streams: ${candidateStreams.join(', ') || '(none: every stream holds the canonical generation)'}`
					: `generations: ${
							candidates.map((id) => `{stream: ${id.stream}, processor: ${id.processor}}`).join(', ') ||
							'(none: the only generation is the canonical one)'
						}`),
		);
	}
}

/** A generation this indexer does not hold. */
export class UnknownGenerationError extends Error {
	readonly name = 'UnknownGenerationError';

	constructor(readonly id: GenerationId) {
		super(
			`this indexer holds no generation {stream: ${id.stream}, processor: ${id.processor}}. It is refused rather ` +
				`than reported as a silent success, because the operation that names one is either a promotion or a ` +
				`deletion and both are worth getting a wrong name back from.`,
		);
	}
}

/** A stream digest this indexer holds no generation on. */
export class UnknownStreamError extends Error {
	readonly name = 'UnknownStreamError';

	constructor(readonly digest: string) {
		super(
			`this indexer holds no generation on the stream ${digest}, so there is nothing here to delete. A subtree ` +
				`nothing claims is not deleted through this call: it is collected by the sweep on the next registry open.`,
		);
	}
}

/**
 * The canonical generation cannot be deleted while it is canonical.
 *
 * Deleting what answers reads would blank the app for exactly as long as a
 * re-index takes, which is the outage this whole design exists to remove. Moving
 * the pointer is one small write, so the cost of requiring it first is one call,
 * and it is a call whose consequence the operator can see before the bytes go.
 */
export class GenerationIsCanonicalError extends Error {
	readonly name = 'GenerationIsCanonicalError';

	constructor(readonly id: GenerationId) {
		super(
			`{stream: ${id.stream}, processor: ${id.processor}} is the canonical generation: it is what answers every ` +
				`read, so deleting it would leave this indexer answering nothing until a re-index finished. Move the ` +
				`canonical pointer to another generation first, then delete this one.`,
		);
	}
}

/** The registry, over one named indexer. */
export type GenerationRegistry = {
	/** The caps this registry was opened with. */
	readonly caps: GenerationCaps;
	/**
	 * The stream digests the sweep dropped when this registry was OPENED.
	 *
	 * It is a value rather than an operation on purpose: open is the one moment
	 * the known set is authoritative and nothing is mid-write, so there is
	 * deliberately no second entry point to put on a timer.
	 */
	readonly swept: readonly string[];
	/** Register a generation over a stream, or resolve the one already registered. */
	create(id: GenerationId, options?: {slot?: SlotName}): Promise<GenerationRecord>;
	/** Every registered generation, oldest first. */
	list(): Promise<GenerationRecord[]>;
	/** Every stream at least one registered generation folds. */
	streams(): Promise<string[]>;
	/** WHAT EACH SLOT HOLDS, resolved against the records, as one read. */
	slots(): Promise<SlottedGenerations>;
	/** The generation that answers reads, or nothing if none has been created. */
	canonical(): Promise<GenerationRecord | undefined>;
	/** The generation that WRITES this stream: the oldest surviving one on it. */
	writerOf(stream: string): Promise<GenerationRecord | undefined>;
	/** Move the canonical pointer. Forwards it is promotion; backwards it is revert. */
	moveCanonicalTo(id: GenerationId): Promise<GenerationRecord>;
	/** Drop a generation's state store, and reap its stream if it was the last one. */
	deleteGeneration(id: GenerationId): Promise<GenerationDeletion>;
	/** Drop every generation on a stream, and the stream's keyspace with them. */
	deleteStream(digest: string): Promise<StreamDeletion>;
};

/** Whether two identities name the SAME generation. */
export function sameGeneration(a: GenerationId, b: GenerationId): boolean {
	return a.stream === b.stream && a.processor === b.processor;
}

/**
 * WHICH SLOT names this generation, if any.
 *
 * The question a replacement, a collection and a promotion all ask, answered in
 * one place: a generation no slot names is dead work, and one ANY slot names is
 * not a replacement's to touch. No generation is ever named by two slots, so the
 * first match is the answer.
 */
export function slotHolding(slots: GenerationSlots, id: GenerationId): SlotName | undefined {
	return SLOT_NAMES.find((name) => {
		const held = slots[name];
		return !!held && sameGeneration(held, id);
	});
}

/**
 * EVERY GENERATION NO SLOT NAMES: the collection rule of ADR-0084, in one place.
 *
 * A generation some slot names is what a deployment is USING -- `canonical`
 * answers every read, `successor` is being built beside it, `predecessor` is what
 * a revert moves back to -- and one that NO slot names is dead work: nothing can
 * promote to it without being asked, nothing reverts to it, and nothing re-folds
 * it for an answer anybody will read. That is a REFCOUNT, which is why it is far
 * easier to prove safe than the three-way in-memory predicate it replaced.
 *
 * `canonical` needs no separate clause, because it IS a slot: "not canonical and
 * no slot names it" would be one rule written twice, and the second copy is what
 * drifts.
 *
 * It says nothing about whether such a generation may be deleted RIGHT NOW: one
 * that WRITES a stream another held fold follows is kept, because dropping it
 * would leave that fold folding a stream nothing appends to (ADR-0044). That is a
 * fact about held FOLDS and so belongs to the container, not here.
 */
export function unslottedGenerations(
	generations: readonly GenerationRecord[],
	slots: GenerationSlots,
): GenerationRecord[] {
	return generations.filter((record) => !slotHolding(slots, record));
}

/**
 * WHAT A REGISTRATION INTO `successor` DISPLACES -- the rule BOTH containers
 * apply, with ONE home (ADR-0071).
 *
 * `successor` holds AT MOST ONE (ADR-0084), so registering into it replaces
 * whatever it held, and the generation displaced is dead work: nothing promotes
 * to it, nothing reverts to it, and re-folding it would be work for an answer
 * nobody will ask for. This says WHICH records that covers; DROPPING them is the
 * caller's, because dropping differs per container (one holds engines, the other
 * receivers) while the rule does not.
 *
 * ## The safety property is this function, and it is ONE clause
 *
 * A generation ANY OTHER slot names is untouchable, which covers the incumbent
 * (`canonical`) and the revert target (`predecessor`) together. Stated as one
 * clause rather than left to follow from a loop, because it is the whole of what
 * makes replacement safe and two copies of it in two containers is how a revert
 * target gets deleted by the twin nobody was reading.
 *
 * Two kinds of record come back, and they are the same rule seen twice:
 *
 * 1. What `successor` NAMES, whether or not this process holds a fold for it --
 *    after a restart it does not, and that is exactly the case the DURABLE slot
 *    exists for.
 * 2. Every generation this container HOLDS A FOLD FOR that no slot names, which
 *    is what a DECLINED drop leaves behind.
 *
 * A generation this container holds no fold for and no slot names is deliberately
 * LEFT ALONE: collecting those is an operator's verb (`ReceivingIndexer.reclaim`),
 * not something a registration does to rows it never touched.
 *
 * Nothing is displaced at all when the registry has no canonical generation (the
 * first registration takes `canonical` and supersedes nobody) or when some slot
 * ALREADY names the arriving generation (a restart on the canonical fold, or on
 * the one a revert returned to, takes nobody's place).
 *
 * NEWEST FIRST, which is what lets a whole replaced chain go in ONE pass: the
 * ordinary churn leaves a replaced WRITER with a replaced FOLLOWER on its stream,
 * and the writer is only droppable once the follower is gone, so walking back to
 * front drops them in the order that frees both.
 */
export function displacedBySuccessor(
	arriving: GenerationId,
	generations: readonly GenerationRecord[],
	slots: GenerationSlots,
	heldHere: (record: GenerationRecord) => boolean,
): GenerationRecord[] {
	if (!slots.canonical || slotHolding(slots, arriving)) {
		return [];
	}
	return generations
		.filter((record) => {
			if (sameGeneration(record, arriving)) return false;
			const slot = slotHolding(slots, record);
			// THE PROPERTY THE WHOLE RULE IS SAFE ON: a generation any OTHER slot names
			// is untouchable, which covers the incumbent and the revert target in ONE
			// clause.
			if (slot) return slot === 'successor';
			// ...and what a declined drop left behind: a fold held here that no slot names.
			return heldHere(record);
		})
		.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * WHICH generation writes a stream: the OLDEST SURVIVING one registered on it.
 *
 * Only one generation may append to a stream (the **one-writer rule**), and
 * ADR-0044 says which one: the FIRST held on it -- registration order, never the
 * canonical pointer -- so that a promotion cannot hand the append duty to a
 * different engine mid-flight. What it does not say is what happens when THAT
 * generation is deleted, and unhandled the answer is a silent stall: generations
 * on one stream share a wire context whose receiver is the writer, so with it
 * gone nothing appends AND an incoming batch resolves to no receiver, while
 * `/status` goes on looking healthy.
 *
 * So the rule is RESTATED rather than replaced (see ADR-0044's amendment): the
 * oldest SURVIVING generation on the stream. At the start the oldest survivor IS
 * the first one held, so ADR-0044's rule is subsumed rather than contradicted,
 * and succession is defined without letting the POINTER in -- "the canonical
 * takes over" would reintroduce the very coupling ADR-0044 refused, and leave
 * two rules where one does.
 *
 * **Succession is ATOMIC WITH THE DELETE because it is stored NOWHERE.** There is
 * no writer column to move in a second write, so no crash can land between the
 * two: the commit that removes the record is already the commit that makes the
 * next-oldest generation the answer here. Deriving it also keeps it true across a
 * restart, where a container's own in-memory registration order is whatever this
 * boot happened to add in.
 *
 * `undefined` means no registered generation folds this stream, which is
 * precisely when there is nothing left to append for and the stream is reaped.
 */
export function writerOf(generations: readonly GenerationRecord[], stream: string): GenerationRecord | undefined {
	return generations.filter((record) => record.stream === stream).sort(byAge)[0];
}

/** The identity alone, so a pointer write carries no record with it. */
function identityOf(id: GenerationId): GenerationId {
	return {stream: id.stream, processor: id.processor};
}

/** A total order: oldest first, then the identity, so a listing never wobbles. */
function byAge(a: GenerationRecord, b: GenerationRecord): number {
	return a.createdAt - b.createdAt || a.stream.localeCompare(b.stream) || a.processor.localeCompare(b.processor);
}

/**
 * CLEAR every slot that names one of these generations.
 *
 * Written in the SAME commit as the removal it accompanies, so no crash can land
 * between a record going and the slot that named it: a slot naming a record that
 * does not exist would answer `undefined` anyway (every slot read RESOLVES
 * against the records), but it would also be a row claiming something untrue,
 * and "a generation no slot names" is the rule collection is decided by.
 */
function clearSlotsNaming(slots: GenerationSlots, removed: readonly GenerationId[]): SlotAssignment | undefined {
	const cleared: SlotAssignmentDraft = {};
	for (const name of SLOT_NAMES) {
		const held = slots[name];
		if (held && removed.some((id) => sameGeneration(id, held))) {
			cleared[name] = null;
		}
	}
	return Object.keys(cleared).length > 0 ? cleared : undefined;
}

/** The slot assignments, resolved against the records that survive. */
function resolveSlots(current: GenerationRegistryState): SlottedGenerations {
	const held: {-readonly [Name in SlotName]?: GenerationRecord} = {};
	for (const name of SLOT_NAMES) {
		const id = current.slots[name];
		const record = id ? current.generations.find((candidate) => sameGeneration(candidate, id)) : undefined;
		if (record) {
			held[name] = record;
		}
	}
	return held;
}

function assertIdentity(id: GenerationId): GenerationId {
	if (typeof id?.stream !== 'string' || id.stream.length === 0) {
		throw new TypeError(`a generation's stream digest must be a non-empty string, got ${JSON.stringify(id?.stream)}`);
	}
	if (typeof id.processor !== 'string' || id.processor.length === 0) {
		throw new TypeError(
			`a generation's processor identity must be a non-empty string, got ${JSON.stringify(id.processor)}`,
		);
	}
	return identityOf(id);
}

/** A slot name, or nothing. Refused rather than ignored: a misspelt slot is a silent no-op otherwise. */
function assertSlot(slot: SlotName | undefined): SlotName | undefined {
	if (slot === undefined) {
		return undefined;
	}
	if (!SLOT_NAMES.includes(slot)) {
		throw new TypeError(
			`a generation slot is one of ${SLOT_NAMES.join(', ')}, got ${JSON.stringify(slot)}. There are exactly three ` +
				`and arbitrary named slots are deliberately not built (ADR-0084).`,
		);
	}
	return slot;
}

function assertCaps(caps: GenerationCaps): GenerationCaps {
	for (const cap of ['maxGenerations', 'maxStreams'] as const) {
		const value = caps?.[cap];
		if (!Number.isInteger(value) || (value as number) < 1) {
			throw new TypeError(
				`${cap} must be a whole number of at least 1, got ${JSON.stringify(value)}. It is a COUNT that REFUSES ` +
					`at the bound, configured by the deployment and never derived from available storage.`,
			);
		}
	}
	return {maxGenerations: caps.maxGenerations, maxStreams: caps.maxStreams};
}

/** Where a cap sends the operator: everything that may legally be deleted. */
function deletable(current: GenerationRegistryState): {
	candidates: GenerationId[];
	candidateStreams: string[];
} {
	const canonical = current.slots.canonical;
	const candidates = current.generations
		.filter((record) => !canonical || !sameGeneration(record, canonical))
		.map(identityOf);
	const candidateStreams = [...new Set(current.generations.map((record) => record.stream))]
		.filter((digest) => !canonical || canonical.stream !== digest)
		.sort();
	return {candidates, candidateStreams};
}

/**
 * Open the registry, and SWEEP every stream subtree it does not know about.
 *
 * ## Why the sweep is here, and why it is on OPEN
 *
 * The ordinary reaping rule cannot reach an orphan. Reaping fires when a
 * stream's LAST GENERATION goes, and a subtree written before generations
 * existed -- under the `chain-<chainId>` placeholder the segmented-stream work
 * left behind, or under any digest rule a later change replaces -- has no
 * generation whose departure could fire it. Nothing enumerates it, nothing
 * deletes it, and it does not even count against `maxStreams`, because the
 * registry never learns of it. Left alone, every browser that ran the earlier
 * code and then upgrades keeps its entire pre-upgrade stream forever, in the one
 * runtime where storage headroom is argued at length.
 *
 * It is keyed on **"the registry does not know this digest"** and NEVER on a
 * particular placeholder value, so it collects an orphan from any cause,
 * including a later redefinition of the digest rule and a crash between a
 * generation's record going and its stream being dropped.
 *
 * It runs on OPEN rather than on a timer, because that is the one moment the
 * known set is authoritative and nothing is mid-write. There is deliberately no
 * other way to run it.
 */
export async function openGenerationRegistry(
	port: GenerationRegistryPort,
	caps: GenerationCaps,
): Promise<GenerationRegistry> {
	const bounds = assertCaps(caps);

	const known = new Set((await port.read()).generations.map((record) => record.stream));
	const swept: string[] = [];
	for (const digest of await port.listStreamDigests()) {
		if (known.has(digest)) {
			continue;
		}
		const removed = await port.dropStreamSubtree(digest);
		swept.push(digest);
		namedLogger.info(
			`the stream subtree ${digest} is claimed by no registered generation, so it has been swept: ${removed} ` +
				`record(s) removed. Nothing could ever have reached it -- reaping fires when a stream's last generation ` +
				`goes, and this one has none.`,
		);
	}

	return {
		caps: bounds,
		swept,

		/**
		 * Register a generation, TAKING ITS STARTING STREAM AS AN INPUT.
		 *
		 * The stream is named rather than derived, and that is the seam
		 * `a-generation-can-be-seeded-from-a-published-artifact` needs: a generation
		 * does not assume it must fetch its own history. A processor change names
		 * the stream the live generation already folds, and re-fetches nothing; a
		 * seeded generation names a stream a captured artifact wrote. Neither path
		 * is visible from here, which is the point -- there is nothing in this
		 * module that could fetch anything.
		 *
		 * Creating one that is already registered RESOLVES it: a boot that names
		 * its own generation on every start must not accumulate duplicates, and must
		 * not be refused by a cap it does not push against.
		 *
		 * ## The SLOT it lands in, which is the durable half of "what is this FOR"
		 *
		 * A caller names the slot it is registering INTO (`{slot: 'successor'}` for
		 * every fold added beside a live one). Three rules decide what is written, and
		 * each of them exists to protect a case:
		 *
		 * 1. **An empty registry's first generation takes `canonical`**, whatever slot
		 *    was asked for, because a registry holding generations and pointing at none
		 *    of them answers nothing. That rule predates slots and is unchanged.
		 * 2. **A generation ALREADY IN A SLOT stays where it is.** A host redeployed
		 *    with the processor the pointer already names must not have it yanked into
		 *    `successor`, and one redeployed with what `predecessor` names -- the
		 *    generation an operator deliberately reverted TO or FROM -- must not be
		 *    re-armed by the act of starting up (ADR-0084's third symptom).
		 * 3. **Otherwise the named slot is ASSIGNED to it**, replacing whatever that
		 *    slot held. `successor` therefore holds AT MOST ONE by construction rather
		 *    than by a rule somebody has to remember, and the generation displaced is
		 *    left named by no slot -- which is precisely what makes it collectable.
		 *    Dropping it is the CALLER's, and is done BEFORE this call so that the cap
		 *    is decided with the room the replacement frees (see the receiving
		 *    container's `replaceTheSuccessor`).
		 *
		 * **Create the generation BEFORE anything writes its stream.** A stream no
		 * registered generation claims is what the sweep collects, so a subtree
		 * written ahead of its registration is one another tab's open may take. The
		 * cost is a re-fetch rather than a hole -- the keeper rebuilds a subtree that
		 * is not there -- but it is a cost nothing pays by registering first.
		 */
		async create(id: GenerationId, options?: {slot?: SlotName}): Promise<GenerationRecord> {
			const wanted = assertIdentity(id);
			const into = assertSlot(options?.slot);
			let resolved: GenerationRecord | undefined;
			await port.commit((current) => {
				const found = current.generations.find((record) => sameGeneration(record, wanted));
				if (found) {
					resolved = found;
					// A registry holding generations and pointing at none answers nothing,
					// so a pointer that was never set takes this one even here.
					if (!current.slots.canonical) {
						return {slots: {canonical: identityOf(found)}};
					}
					// ...and a generation some slot already names stays where it is: a restart
					// that re-registers the canonical generation, or the one a revert returned
					// to, is not asking for it to become a pending successor.
					if (!into || slotHolding(current.slots, found)) {
						return undefined;
					}
					return {slots: {[into]: identityOf(found)}};
				}

				if (current.generations.length + 1 > bounds.maxGenerations) {
					const {candidates, candidateStreams} = deletable(current);
					throw new GenerationCapReachedError(
						'maxGenerations',
						bounds.maxGenerations,
						wanted,
						candidates,
						candidateStreams,
					);
				}
				const streams = new Set(current.generations.map((record) => record.stream));
				if (!streams.has(wanted.stream) && streams.size + 1 > bounds.maxStreams) {
					const {candidates, candidateStreams} = deletable(current);
					throw new GenerationCapReachedError('maxStreams', bounds.maxStreams, wanted, candidates, candidateStreams);
				}

				// STRICTLY INCREASING within a registry, and never a bare `Date.now()`.
				//
				// `createdAt` is the ORDERING key `writerOf` reads to name the oldest
				// surviving generation on a stream, and a wall clock has MILLISECOND
				// resolution: two generations registered in one millisecond tie, and
				// `byAge` then breaks the tie on the processor HASH -- an order with no
				// relation to which was registered first. That is not a cosmetic wobble in
				// a listing. It makes `writerOf` name a SUCCESSOR as the writer of a
				// stream its incumbent already writes, and both containers then believe
				// they hold the write duty: measured at two writers on one stream, which
				// is the invariant ADR-0044 exists to hold (ADR-0072).
				//
				// One `Math.max` removes the tie at the source rather than teaching every
				// reader to break it the same way. It costs the field nothing it promised:
				// its own docstring already says ORDERING only, never identity, so a value
				// nudged a millisecond forward to stay ordered is more faithful to that
				// than a raw clock reading is.
				const newest = current.generations.reduce((high, record) => Math.max(high, record.createdAt), 0);
				resolved = {...wanted, createdAt: Math.max(Date.now(), newest + 1)};
				/**
				 * The FIRST generation is canonical, and a successor is NOT.
				 *
				 * This is not the promotion policy: that decides between an incumbent
				 * and a successor, and here there is no incumbent to protect. Every
				 * value the policy will take (`on-catch-up`, `immediate`, `manual`)
				 * needs a canonical generation to exist before it has a question to
				 * answer, so taking the first one costs the policy nothing and spares
				 * every caller a special case.
				 */
				const slots: SlotAssignmentDraft = {};
				if (!current.slots.canonical) {
					slots.canonical = identityOf(resolved);
				} else if (into) {
					slots[into] = identityOf(resolved);
				}
				return {put: resolved, ...(Object.keys(slots).length > 0 ? {slots} : {})};
			});
			return resolved as GenerationRecord;
		},

		async list(): Promise<GenerationRecord[]> {
			return [...(await port.read()).generations].sort(byAge);
		},

		async streams(): Promise<string[]> {
			return [...new Set((await port.read()).generations.map((record) => record.stream))].sort();
		},

		/**
		 * WHAT EACH SLOT HOLDS, resolved against the records, in ONE read.
		 *
		 * One read rather than three, because the three answers are read together
		 * wherever they are used: a replacement has to know that what it is about to
		 * displace is not what `canonical` or `predecessor` names, and three reads
		 * could answer from either side of another process's write.
		 *
		 * A slot naming a generation whose record has GONE resolves to nothing rather
		 * than to a dangling identity, exactly as `canonical` already did.
		 */
		async slots(): Promise<SlottedGenerations> {
			return resolveSlots(await port.read());
		},

		async canonical(): Promise<GenerationRecord | undefined> {
			return resolveSlots(await port.read()).canonical;
		},

		/**
		 * Which generation WRITES this stream, read from the records themselves.
		 *
		 * See `writerOf`: the oldest SURVIVING generation on the stream, so deleting
		 * a writer hands the append duty on in the same commit as the delete, with
		 * nothing stored and nothing to migrate.
		 */
		async writerOf(stream: string): Promise<GenerationRecord | undefined> {
			return writerOf((await port.read()).generations, stream);
		},

		/**
		 * Move the canonical pointer: ONE small record write, and the whole of
		 * promotion.
		 *
		 * Forwards it promotes; BACKWARDS it reverts, and the revert is exact
		 * because the generation it names was never touched -- its stream, its state
		 * store and its cursor are where they were, so nothing is re-indexed and
		 * nothing is fetched. That is why non-canonical generations are kept rather
		 * than evicted.
		 *
		 * ## It also ASSIGNS `predecessor`, in the SAME commit, and that is the point
		 *
		 * `predecessor` is what a revert moves back to, and WHICH generation that is
		 * is exactly the fact the rows never held: it cannot be derived afterwards,
		 * because "the pointer was moved off this one" and "this one was never named"
		 * look identical (ADR-0084). So it is ASSIGNED by the move that creates one,
		 * and never inferred: after any move, `predecessor` names the generation the
		 * pointer just came OFF. A second move back is therefore expressible as a move
		 * to what `predecessor` names, by any process, after any restart.
		 *
		 * It is ONE COMMIT with the pointer write for the reason writer succession is
		 * stored nowhere: a crash between two writes would leave a pointer that had
		 * moved and no record of what it moved off, which is the missing fact again.
		 *
		 * And a target the `successor` slot named LEAVES that slot, because it is the
		 * incumbent now and no longer something being built beside one. Nothing else
		 * is touched: a pending successor stays pending across a revert, which is what
		 * lets a developer keep iterating while an operator moves the pointer.
		 */
		async moveCanonicalTo(id: GenerationId): Promise<GenerationRecord> {
			const wanted = assertIdentity(id);
			let target: GenerationRecord | undefined;
			await port.commit((current) => {
				const found = current.generations.find((record) => sameGeneration(record, wanted));
				if (!found) {
					throw new UnknownGenerationError(wanted);
				}
				target = found;
				const movedOff = current.slots.canonical;
				if (movedOff && sameGeneration(movedOff, found)) {
					// already there: a move that moves nothing assigns nothing either, or it
					// would make a generation its own predecessor
					return undefined;
				}
				const slots: SlotAssignmentDraft = {canonical: identityOf(found)};
				if (movedOff) {
					slots.predecessor = identityOf(movedOff);
				}
				if (slotHolding(current.slots, found) === 'successor') {
					slots.successor = null;
				}
				return {slots};
			});
			return target as GenerationRecord;
		},

		/**
		 * Delete a generation: drop its state store, and REAP its stream if it was
		 * the last generation folding it.
		 *
		 * The order is the record FIRST and the bytes after, and it is deliberate.
		 * A crash between them leaks storage; the other order leaves the registry
		 * claiming a generation whose state has gone, which answers reads from
		 * nothing. The leak is not permanent either: an orphan subtree is collected
		 * by the sweep on the next open, which is exactly the recovery this ordering
		 * relies on.
		 */
		async deleteGeneration(id: GenerationId): Promise<GenerationDeletion> {
			const wanted = assertIdentity(id);
			let removed: GenerationRecord | undefined;
			let reaped: string | undefined;
			await port.commit((current) => {
				const found = current.generations.find((record) => sameGeneration(record, wanted));
				if (!found) {
					throw new UnknownGenerationError(wanted);
				}
				if (current.slots.canonical && sameGeneration(found, current.slots.canonical)) {
					throw new GenerationIsCanonicalError(wanted);
				}
				removed = found;
				reaped =
					current.generations.filter((record) => record.stream === found.stream).length === 1
						? found.stream
						: undefined;
				// ...and the slot that named it is cleared WITH it, so no slot survives the
				// generation it pointed at
				const cleared = clearSlotsNaming(current.slots, [found]);
				return {remove: [identityOf(found)], ...(cleared ? {slots: cleared} : {})};
			});

			await port.dropState(identityOf(removed as GenerationRecord));
			// ...and what came back with it, reported rather than discarded: an operator
			// reclaiming disk asked how much, and only the port that dropped the subtree can
			// say.
			const records = reaped === undefined ? undefined : await port.dropStreamSubtree(reaped);
			return {generation: removed as GenerationRecord, reaped, records};
		},

		/**
		 * Delete a stream: every generation on it, and its keyspace.
		 *
		 * Cheap and complete only because streams are self-contained -- separate
		 * keyspaces that never share entries -- so this is a scoped delete rather
		 * than a walk of anything.
		 */
		async deleteStream(digest: string): Promise<StreamDeletion> {
			let removed: GenerationRecord[] = [];
			await port.commit((current) => {
				const on = current.generations.filter((record) => record.stream === digest).sort(byAge);
				if (on.length === 0) {
					throw new UnknownStreamError(digest);
				}
				if (current.slots.canonical && current.slots.canonical.stream === digest) {
					throw new GenerationIsCanonicalError(current.slots.canonical);
				}
				removed = on;
				const cleared = clearSlotsNaming(current.slots, on);
				return {remove: on.map(identityOf), ...(cleared ? {slots: cleared} : {})};
			});

			for (const record of removed) {
				await port.dropState(identityOf(record));
			}
			const records = await port.dropStreamSubtree(digest);
			return {generations: removed, digest, records};
		},
	};
}
