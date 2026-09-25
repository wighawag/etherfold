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
 *   away from it" are indistinguishable from the rows (ADR-0084). It is assigned
 *   by the RECEIVING runtime ONLY (ADR-0089): a move on the chain-facing container
 *   assigns none, because in a browser the code that generation's fold needs is
 *   absent from the build, so the slot would name something that runtime cannot
 *   instantiate. The NAME stays in the vocabulary either way -- what differs is
 *   which runtime assigns it, never what it means. See `moveCanonicalTo`.
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
	/**
	 * EVERY STREAM THIS INDEXER HOLDS, whether or not a generation still folds it
	 * (ADR-0087).
	 *
	 * A stream is what CHAIN FETCHES bought, and it OUTLIVES every fold over it: the
	 * last generation on a stream going away is not a reason to delete the stream,
	 * it is precisely the state a stream is in between an old fold being dropped and
	 * a new one being built. So the fact "this indexer fetched this stream" is a
	 * DURABLE RECORD of its own rather than something inferred from the generations,
	 * which is what lets it survive a restart.
	 *
	 * It is what the SWEEP compares against, and it is the whole of how a KEPT stream
	 * is told from a PRE-GENERATION ORPHAN across a restart: a kept stream is one this
	 * registry RECORDED, and an orphan -- a subtree written under a placeholder digest
	 * before generations existed, or under a digest rule a later change replaced -- was
	 * never recorded and is still collected.
	 *
	 * A stream ENTERS this set when a generation is registered on it, and LEAVES it
	 * only when something ASKS for the stream to go: `deleteStream`, or
	 * `deleteGeneration` told to reap. Deliberately NOT part of `maxStreams`, which
	 * goes on counting the distinct streams among REGISTERED GENERATIONS, so keeping
	 * a stream nothing folds does not bring a deployment closer to a refusal.
	 */
	readonly keptStreams: readonly string[];
};

/**
 * What ONE commit writes.
 *
 * `remove` runs before `put`, and `slots` is applied last: a write may remove a
 * generation and clear the slots that named it in the same commit, which is what
 * keeps a slot from ever naming a record that has gone. An absent slot name means
 * LEAVE IT WHERE IT IS rather than clear it; see `SlotAssignment`.
 *
 * ## `remove` takes EVERYTHING the substrate keeps under that identity
 *
 * The record AND its `bundle` (ADR-0092), in the same commit and as one act. That is
 * the whole of how a bundle dies with its generation: every path that deletes one --
 * `deleteGeneration` (which a reclaim, a replaced successor and a drop on promotion
 * all reach) and `deleteStream` -- writes a `remove`, and a substrate that kept the
 * bytes anywhere a `remove` does not reach would have forked a second deletion
 * mechanism nobody calls.
 */
export type GenerationRegistryWrite = {
	readonly remove?: readonly GenerationId[];
	readonly put?: GenerationRecord;
	/**
	 * THE BUNDLE THAT FOLDS `put`: the exact octets whose hash is `put.processor`
	 * (ADR-0086), written WITH the record and never without one (ADR-0092).
	 *
	 * Beside `put` rather than inside it, because a `GenerationRecord` is what every
	 * listing, every slot resolution and every substrate's plain `put` of a record
	 * handles, and bytes riding on it would be stored by a substrate that was never
	 * meant to keep any: a browser tab retains no code (ADR-0089), and its port REFUSES a
	 * write carrying one rather than storing it or silently dropping it.
	 *
	 * Absent means this registration retained no code. That is the chain-facing
	 * container's every registration, and on the receiving container it is
	 * unexpressible (`ReceivedGenerationSpec.bundle`).
	 */
	readonly bundle?: Uint8Array;
	readonly slots?: SlotAssignment;
	/** RECORD that this indexer holds this stream. Idempotent. See `GenerationRegistryState.keptStreams`. */
	readonly keepStream?: string;
	/** FORGET these streams, which is what an ASKED-FOR deletion of one writes. */
	readonly forgetStreams?: readonly string[];
};

/**
 * What a SUBSTRATE supplies, scoped to ONE named indexer.
 *
 * Six operations, and the split between them is the design. `read` and
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
 * The other four reach OUTSIDE the registry's own records, and each of them is
 * a fact only the runtime knows: which stream subtrees exist, how a subtree is
 * dropped, and how a generation's state store is DROPPED and READ. Those last
 * two are injected rather than derived because WHERE a generation's state lives
 * is decided by the container above `StateStore` (ADR-0053 makes it a table
 * NAMESPACE named from the identity); the registry must not fork a naming
 * convention it does not own.
 */
export type GenerationRegistryPort = {
	/** Every registered generation, every slot assignment and every stream held, as one read. */
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
	/**
	 * HOW FAR THE FOLD IN THIS GENERATION'S STATE GOT: `lastToBlock`, read where it
	 * is durable, for a generation the ASKER may hold no fold for.
	 *
	 * `dropState`'s symmetric sibling, injected for exactly the reason that one is:
	 * a generation's state is a TABLE NAMESPACE named from its identity (ADR-0053),
	 * the registry does not own that convention, and whoever named the tables is the
	 * one who can address them. It is the READ half of the same fact.
	 *
	 * ## It takes an IDENTITY and never a fold, which is the whole point
	 *
	 * The promotion trigger compares a successor's position against the CANONICAL
	 * generation's, and on the ordinary upgrade the process holding the successor
	 * holds no fold for the incumbent at all -- the old processor's code is not in
	 * the build, so one is unbuildable by construction. That is the same fact the
	 * receiving container's module JSDoc (rule 1) and `promote`'s docstring already
	 * state: a generation ANSWERS with no engine, because its state is a namespace
	 * the pointer names. This read follows that rule instead of being the one place
	 * that still needs an engine.
	 *
	 * ## A NUMBER, and `undefined` is never a zero
	 *
	 * A NUMBER because that is what the comparison needs, and because the cursor
	 * itself is an opaque string behind the storage seam whose window holds whole
	 * decoded blocks (ADR-0027, ADR-0047): the codec lives above that seam, in the
	 * host, which is where this is implemented. `undefined` means NOT READABLE -- no
	 * cursor written yet, an unparseable one, or a cursor another fold wrote -- and
	 * it must never be reported as `0`, or "has folded nothing" would read as "level
	 * at block 0" and a successor that had done nothing would be promoted over an
	 * incumbent that had.
	 *
	 * Nothing here retains, re-imports or reconstructs a past processor: the number
	 * is a ROW, addressed by an identity the registry holds.
	 */
	readStateCursor(id: GenerationId): Promise<number | undefined>;
	/**
	 * THE BUNDLE STORED FOR THIS GENERATION (ADR-0092), or `undefined` where none is.
	 *
	 * The READ half of `GenerationRegistryWrite.bundle`, and deliberately not part of
	 * `read()`: that one is taken inside every commit's decision, and a bundle is a
	 * whole processor's worth of octets that no decision needs. So the bytes are written
	 * with the record and removed with the record, but READ only by somebody who asked
	 * for this one generation's code.
	 *
	 * `undefined` is a real answer and never an error: a generation that is not
	 * registered, and one registered by a runtime that retains no code (a tab, whose
	 * port answers `undefined` for everything), both hold no bytes here.
	 */
	readBundle(id: GenerationId): Promise<Uint8Array | undefined>;
};

/** What `deleteGeneration` did. */
export type GenerationDeletion = {
	readonly generation: GenerationRecord;
	/**
	 * The stream that was reaped with it, present only where the caller ASKED for a
	 * reap AND this was the last generation folding it.
	 *
	 * It used to be present whenever the last generation on a stream went, whoever
	 * had asked and for whatever reason. That was the AUTOMATIC reap ADR-0087
	 * removes: registering into an occupied `successor` slot drops the replaced
	 * generation, so saving twice in a tab deleted a stream nobody asked to delete --
	 * and "no registered generation folds it" is exactly the state a stream is in
	 * between an old fold being dropped and a new one being built, which is when its
	 * value is highest.
	 */
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
			`this indexer holds no stream ${digest} -- no generation folds it and the registry has no record of it -- so ` +
				`there is nothing here to delete. A subtree nothing claims is not deleted through this call: it is ` +
				`collected by the sweep on the next registry open. A stream this indexer DOES hold is deletable through ` +
				`this call even when no generation is left folding it, which is the ordinary state of a kept stream ` +
				`(ADR-0087).`,
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
	/**
	 * Register a generation over a stream, or resolve the one already registered.
	 *
	 * `bundle` is the code that folds it (ADR-0092), stored WITH the record in the same
	 * commit; see `GenerationRegistryWrite.bundle`.
	 */
	create(id: GenerationId, options?: {slot?: SlotName; bundle?: Uint8Array}): Promise<GenerationRecord>;
	/**
	 * THE BUNDLE STORED FOR THIS GENERATION, or `undefined` where none is. See
	 * `GenerationRegistryPort.readBundle`.
	 */
	bundleOf(id: GenerationId): Promise<Uint8Array | undefined>;
	/** Every registered generation, oldest first. */
	list(): Promise<GenerationRecord[]>;
	/** Every stream at least one registered generation folds. */
	streams(): Promise<string[]>;
	/** WHAT EACH SLOT HOLDS, resolved against the records, as one read. */
	slots(): Promise<SlottedGenerations>;
	/** The generation that answers reads, or nothing if none has been created. */
	canonical(): Promise<GenerationRecord | undefined>;
	/** The generation this stream was FETCHED FOR: the oldest surviving one on it. See `fetcherOf`. */
	fetcherOf(stream: string): Promise<GenerationRecord | undefined>;
	/**
	 * EVERY STREAM THIS INDEXER HOLDS, whether or not a generation still folds it.
	 *
	 * The durable half of "a stream outlives every fold over it" (ADR-0087), and what
	 * the sweep on open compares against. See `GenerationRegistryState.keptStreams`.
	 */
	keptStreams(): Promise<string[]>;
	/**
	 * Move the canonical pointer. Forwards it is promotion; backwards it is revert.
	 *
	 * `assignPredecessor` is the CALLING RUNTIME's answer to whether a move here
	 * leaves a revert window, and it defaults to TRUE -- see `moveCanonicalTo`'s
	 * implementation for why the chain-facing container is the one that says `false`
	 * (ADR-0089).
	 */
	moveCanonicalTo(id: GenerationId, options?: {assignPredecessor?: boolean}): Promise<GenerationRecord>;
	/**
	 * HOW FAR THE FOLD IN THIS GENERATION'S STATE GOT, for a generation the caller
	 * may hold no fold for. See `GenerationRegistryPort.readStateCursor`.
	 *
	 * Forwarded rather than answered here, because the records say nothing about it:
	 * it is the host's fact, reached through the port beside the DROP of the same
	 * state. It is on the registry because the registry is what a container holds,
	 * and the question it answers -- "is the successor level with the generation the
	 * pointer names" -- is asked about IDENTITIES the registry resolves.
	 */
	readStateCursor(id: GenerationId): Promise<number | undefined>;
	/**
	 * Drop a generation's row (and the bundle stored with it, ADR-0092) and its state
	 * store -- and its stream too, but ONLY where the caller ASKED and no other
	 * generation is left folding it.
	 *
	 * `reapStream` defaults to FALSE, which is the substance of ADR-0087's second
	 * half: deletion is a VERB, so the stream goes when an operator says so
	 * (`ReceivingIndexer.reclaim`, `deleteStream`) and never because a registration
	 * displaced the last fold over it.
	 */
	deleteGeneration(id: GenerationId, options?: {reapStream?: boolean}): Promise<GenerationDeletion>;
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
 * It says nothing about what DELETING one then costs, which belongs to the
 * container and not here. It used to answer one thing more, and no longer does:
 * a generation that WROTE a stream another held fold followed was kept, because
 * dropping it would have left that fold folding a stream nothing appends to
 * (ADR-0044). Its only callers are on the RECEIVING side, where no generation
 * writes a stream at all since ADR-0087, so that clause has no subject here.
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
 * Kinds of record come back, and they are the same rule seen more than once:
 *
 * 1. What `successor` NAMES, whether or not this process holds a fold for it --
 *    after a restart it does not, and that is exactly the case the DURABLE slot
 *    exists for.
 * 2. Every generation this container HOLDS A FOLD FOR that no slot names, which
 *    is what a DECLINED drop leaves behind.
 * 3. And, on a runtime that answers `unheldIsCollectable` (below), every record
 *    no slot names that this container holds NO FOLD for either.
 *
 * That third one is the ONE axis the two runtimes differ on, and the difference is
 * whether anything ELSE would ever collect such a record: where an operator's
 * `reclaim` will, a registration leaves rows it never touched alone.
 *
 * Nothing is displaced at all when the registry has no canonical generation (the
 * first registration takes `canonical` and supersedes nobody) or when some slot
 * ALREADY names the arriving generation (a restart on the canonical fold, or on
 * the one a revert returned to, takes nobody's place). That second clause is also
 * what keeps a page RELOAD from collecting anything: the fold a tab arrives with
 * is the one `canonical` names.
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
	runtime: DisplacementRuntime,
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
			// ...and what a declined drop left behind: a fold held here that no slot names,
			// plus -- where this runtime is the only thing that will ever collect one -- a
			// row no fold here exists for at all.
			return runtime.unheldIsCollectable || runtime.heldHere(record);
		})
		.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * THE CALLING RUNTIME'S ANSWER to the one clause of `displacedBySuccessor` that is
 * not the same on both containers.
 *
 * Both fields are stated at the call site rather than defaulted, because the
 * DEFAULT is the thing that would be wrong: a widening that leaked to the
 * receiving container would delete, with nobody present, exactly the generations
 * an operator keeps until they run `reclaim`.
 */
export type DisplacementRuntime = {
	/** Whether THIS container holds a fold for this record. */
	readonly heldHere: (record: GenerationRecord) => boolean;
	/**
	 * Whether a generation NO FOLD HERE EXISTS FOR, that no slot names, is collectable
	 * by an arriving registration -- which is a fact about the RUNTIME and not a policy
	 * anybody configures.
	 *
	 * **`true` on the CHAIN-FACING container** (ADR-0090, point 3). There a row nothing
	 * holds a fold for can never answer a read and can never fetch -- after a page
	 * reload the previous processor's code is not in the bundle that loaded -- and
	 * NOTHING ELSE on that runtime will ever collect it: `reclaim` is deliberately not
	 * ported to a tab, which has neither an operator nor an `ADMIN_TOKEN` (ADR-0084).
	 * So the choice there is not between collecting it now and collecting it later, it
	 * is between collecting it at the one moment a developer's act makes room for and
	 * carrying it for ever -- measured, a save loop that met `maxGenerations` with a row
	 * no page reload could clear.
	 *
	 * **`false` on the RECEIVING container** (ADR-0090, point 4). There collecting one
	 * is an operator's VERB and deliberately not a collector: `reclaim` deletes because
	 * somebody ASKED, and a registration that took those rows as well would delete with
	 * nobody present -- which is the decision ADR-0084 declined to make, and it would
	 * take the generation an operator was keeping with it.
	 *
	 * It is NOT "is this record garbage": that question is the SLOTS' and is answered
	 * above this clause, which only ever widens the candidates among records no slot
	 * names.
	 */
	readonly unheldIsCollectable: boolean;
};

/**
 * WHICH generation a stream was FETCHED FOR: the OLDEST SURVIVING one registered
 * on it.
 *
 * ## It is an ANSWER and no longer a DUTY on the receiving side (ADR-0087)
 *
 * It was `writerOf`, and it ELECTED the one generation per stream that held the
 * pen: the appender was handed to whichever fold this named and to nothing else.
 * That third role does not belong to a generation at all, and electing it by
 * registration ORDER is what produced the measured data-loss defect -- the elected
 * writer can be a generation the process holds no fold for, so the duty belonged
 * to something absent while a present fold folded happily.
 *
 * So the ELECTION is gone: on the receiving side the DEPLOYMENT fetches a stream
 * and appends to it, positioned from the STREAM's own coverage claim, and every
 * generation merely READS it. What survives here is the question ADR-0087 says may
 * survive -- *which generation was this stream fetched for* -- which is still the
 * oldest surviving record on it, still derived, still stored nowhere, and still
 * atomic with a delete. Nothing may read it as permission to append.
 *
 * The CHAIN-FACING container still derives `follows` from it, and that is the same
 * question rather than the retired one: there the engine that fetches a stream IS
 * a generation (`IndexerGeneration` opens `load()` with `eth_chainId`), so "which
 * generation fetched this" and "which generation writes this" are one fact, and
 * ADR-0044's follower rule is untouched.
 *
 * `undefined` means no registered generation folds this stream. That is no longer
 * a reason to delete anything: the stream is KEPT (`GenerationRegistryState.keptStreams`).
 */
export function fetcherOf(generations: readonly GenerationRecord[], stream: string): GenerationRecord | undefined {
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

/**
 * Bundle bytes, or nothing. Refused rather than stored when they are not bytes, or
 * are NO bytes: an empty bundle hashes to an identity like any other and is no
 * processor at all, so storing one would be a generation whose retained code could
 * never fold it.
 */
function assertBundle(bundle: Uint8Array | undefined): Uint8Array | undefined {
	if (bundle === undefined) {
		return undefined;
	}
	if (!(bundle instanceof Uint8Array) || bundle.length === 0) {
		throw new TypeError(
			`a generation's bundle must be the non-empty octets that fold it (ADR-0092), got ` +
				`${bundle instanceof Uint8Array ? 'an empty Uint8Array' : typeof bundle}`,
		);
	}
	return bundle;
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
 * ## WHAT THE REGISTRY KNOWS IS NOW TWO THINGS, and that is ADR-0087's half here
 *
 * A stream is KEPT when the last generation folding it goes away, so "claimed by
 * no registered generation" stopped being the same question as "nothing ever
 * fetched this". Read the narrow way, this sweep would undo the keep at the next
 * restart -- silently, in the precise window the keep exists for, with a green
 * gate. So the comparison is against the generations AND the registry's own
 * STREAM RECORDS (`GenerationRegistryState.keptStreams`): a deliberately-kept
 * stream is one this registry RECORDED, which survives a restart because it is a
 * row, and a pre-generation orphan was never recorded and is still collected.
 * The sweep's own stated purpose is untouched.
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

	const opening = await port.read();
	// BOTH halves of what the registry knows: the streams its generations fold, and
	// the streams it RECORDED and has not been asked to delete. A digest in either is
	// not an orphan.
	const known = new Set([...opening.generations.map((record) => record.stream), ...(opening.keptStreams ?? [])]);
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

		/** The host's own read, forwarded unchanged. See the port's JSDoc. */
		readStateCursor(id: GenerationId): Promise<number | undefined> {
			return port.readStateCursor(assertIdentity(id));
		},

		/** The host's own read of the bytes it stored with the record, forwarded unchanged. */
		bundleOf(id: GenerationId): Promise<Uint8Array | undefined> {
			return port.readBundle(assertIdentity(id));
		},

		/** Every stream this indexer holds, folded or not. See `GenerationRegistryState.keptStreams`. */
		async keptStreams(): Promise<string[]> {
			return [...((await port.read()).keptStreams ?? [])].sort();
		},

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
		 *
		 * ## The BUNDLE is written with the record, in the same commit (ADR-0092)
		 *
		 * Storing the code is a property of REGISTERING, not of how the bytes arrived: a
		 * bundle read off disk and one pushed over a wire reach the store by this one
		 * call. It rides the commit that writes the record, so no crash can leave a
		 * registered generation whose code never landed, or code for a generation that
		 * was never registered -- and it leaves by the same `remove` that takes the record.
		 *
		 * A registration that RESOLVES writes no bytes. The identity is the hash of the
		 * bytes (ADR-0086), so whatever this call carries is what the record was registered
		 * with, and re-sending a processor's worth of octets on every restart would buy
		 * nothing.
		 */
		async create(id: GenerationId, options?: {slot?: SlotName; bundle?: Uint8Array}): Promise<GenerationRecord> {
			const wanted = assertIdentity(id);
			const into = assertSlot(options?.slot);
			const bundle = assertBundle(options?.bundle);
			let resolved: GenerationRecord | undefined;
			await port.commit((current) => {
				const found = current.generations.find((record) => sameGeneration(record, wanted));
				// THE STREAM IS RECORDED whether this registration is new or resolves, and it
				// is idempotent: the record is what makes the stream outlive every fold over it
				// (ADR-0087), and a registry written by an earlier build holds generations whose
				// streams were never recorded -- so re-registering one is where those learn
				// their own stream rather than having it swept out from under them.
				const keepStream = wanted.stream;
				if (found) {
					resolved = found;
					// A registry holding generations and pointing at none answers nothing,
					// so a pointer that was never set takes this one even here.
					if (!current.slots.canonical) {
						return {keepStream, slots: {canonical: identityOf(found)}};
					}
					// ...and a generation some slot already names stays where it is: a restart
					// that re-registers the canonical generation, or the one a revert returned
					// to, is not asking for it to become a pending successor.
					if (!into || slotHolding(current.slots, found)) {
						return {keepStream};
					}
					return {keepStream, slots: {[into]: identityOf(found)}};
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
				return {
					put: resolved,
					...(bundle ? {bundle} : {}),
					keepStream,
					...(Object.keys(slots).length > 0 ? {slots} : {}),
				};
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
		 * Which generation this stream was FETCHED FOR, read from the records themselves.
		 *
		 * See `fetcherOf`: the oldest SURVIVING generation on the stream. It is an ANSWER
		 * and never permission to append -- on the receiving side the DEPLOYMENT writes
		 * the stream it fetches (ADR-0087).
		 */
		async fetcherOf(stream: string): Promise<GenerationRecord | undefined> {
			return fetcherOf((await port.read()).generations, stream);
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
		 *
		 * ## ...unless the CALLER says its runtime can never run one (ADR-0089)
		 *
		 * `assignPredecessor: false` makes this a move that assigns NOTHING behind it:
		 * the generation the pointer came off is left named by no slot, and is
		 * collectable by the same rule as any other generation no slot names. The
		 * CHAIN-FACING container passes it (`Indexer.movePointerTo`) and nothing else
		 * does, because in a browser the code a predecessor's fold needs is ABSENT FROM
		 * THE BUILD -- so the slot would name something that runtime is structurally
		 * unable to instantiate. On the receiving runtime the slot is genuinely useful,
		 * an operator reverts without redeploying, and the default is therefore the
		 * assignment: a caller that says nothing keeps its revert window.
		 *
		 * It is read BEFORE the commit and applied INSIDE the plan, so the assignment is
		 * never DRAFTED rather than being drafted and undone. A clear afterwards would be
		 * a second act that can fail on its own and leave the slot populated, which is
		 * exactly the partially-assigned state the one-commit rule above exists to make
		 * unreachable.
		 *
		 * It is deliberately NOT in `GenerationCaps`, which is documented as a COUNT and
		 * never a policy, and deliberately not a property of the REGISTRY either: what
		 * differs is the container doing the moving, not the substrate holding the rows
		 * (one runtime opens a memory registry in a test and a durable one in a tab, and
		 * both are the same chain-facing container).
		 */
		async moveCanonicalTo(id: GenerationId, options?: {assignPredecessor?: boolean}): Promise<GenerationRecord> {
			const wanted = assertIdentity(id);
			const assignPredecessor = options?.assignPredecessor !== false;
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
				if (movedOff && assignPredecessor) {
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
		 * Delete a generation: drop its row and its state store -- and its stream too,
		 * but only where the CALLER ASKED and nothing else is left folding it.
		 *
		 * Its BUNDLE (ADR-0092) goes with the row, in the SAME commit, because the port's
		 * `remove` takes everything kept under the identity (`GenerationRegistryWrite`).
		 * That is why a reclaim, a replaced successor and a drop on promotion all take
		 * the bytes without any of them mentioning bytes: all three are this call.
		 *
		 * ## The reap is ASKED FOR now, and that is ADR-0087's second half
		 *
		 * It used to fire whenever the last generation on a stream went, whoever had
		 * asked. Two callers reach here without an operator anywhere near them --
		 * registering into an occupied `successor` slot drops what it replaced, and
		 * drop-on-promotion drops what a promotion superseded -- so saving twice in a tab
		 * deleted the stream. That is backwards: the stream is what CHAIN FETCHES bought
		 * and the state is derived from it, and "no registered generation folds it" is
		 * exactly the state a stream is in between an old fold being dropped and a new one
		 * being built.
		 *
		 * So deletion is a VERB. `reapStream` is false unless a caller says otherwise, and
		 * the one caller that says otherwise is the operator's `reclaim`. What is kept is
		 * RECORDED (`keptStreams`), so the sweep on the next open does not undo it.
		 *
		 * The order is the record FIRST and the bytes after, and it is deliberate.
		 * A crash between them leaks storage; the other order leaves the registry
		 * claiming a generation whose state has gone, which answers reads from
		 * nothing. The leak is not permanent either: an orphan subtree is collected
		 * by the sweep on the next open, which is exactly the recovery this ordering
		 * relies on.
		 */
		async deleteGeneration(id: GenerationId, options?: {reapStream?: boolean}): Promise<GenerationDeletion> {
			const wanted = assertIdentity(id);
			const reapStream = options?.reapStream === true;
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
					reapStream && current.generations.filter((record) => record.stream === found.stream).length === 1
						? found.stream
						: undefined;
				// ...and the slot that named it is cleared WITH it, so no slot survives the
				// generation it pointed at
				const cleared = clearSlotsNaming(current.slots, [found]);
				return {
					remove: [identityOf(found)],
					// the STREAM RECORD goes in the SAME commit as the row, and only where the
					// reap was asked for: a record kept for a stream whose bytes are gone would
					// make the sweep spare an orphan for ever
					...(reaped === undefined ? {} : {forgetStreams: [reaped]}),
					...(cleared ? {slots: cleared} : {}),
				};
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
		 *
		 * ## It accepts a stream NO GENERATION FOLDS, because that is now an ordinary
		 * state
		 *
		 * A stream OUTLIVES every fold over it (ADR-0087), so "no registered generation
		 * is on this digest" stopped meaning "this indexer has no such stream". Refusing
		 * there would make exactly the streams the keep exists for the ones an operator
		 * could not delete -- immortal bytes, which is not the trade the ADR makes. So a
		 * stream this registry RECORDS is deletable with no generation on it at all, and
		 * `UnknownStreamError` is left for a digest the registry has never heard of.
		 *
		 * The GUARD is untouched: a stream the canonical generation folds is refused,
		 * because deleting it would leave the indexer answering nothing.
		 */
		async deleteStream(digest: string): Promise<StreamDeletion> {
			let removed: GenerationRecord[] = [];
			await port.commit((current) => {
				const on = current.generations.filter((record) => record.stream === digest).sort(byAge);
				if (on.length === 0 && !(current.keptStreams ?? []).includes(digest)) {
					throw new UnknownStreamError(digest);
				}
				if (current.slots.canonical && current.slots.canonical.stream === digest) {
					throw new GenerationIsCanonicalError(current.slots.canonical);
				}
				removed = on;
				const cleared = clearSlotsNaming(current.slots, on);
				// ASKED FOR, so the stream RECORD goes with the rows: this is the operator's
				// verb, and what it deletes must not be spared by the sweep's keep rule.
				return {remove: on.map(identityOf), forgetStreams: [digest], ...(cleared ? {slots: cleared} : {})};
			});

			for (const record of removed) {
				await port.dropState(identityOf(record));
			}
			const records = await port.dropStreamSubtree(digest);
			return {generations: removed, digest, records};
		},
	};
}
