/**
 * The declaration surface an indexer author writes, and nothing more.
 *
 * `{name, id, fields}` is the whole per-entity contract: the store owns the
 * versions, the storage layout, the as-of read and the reorg revert. That is the
 * subgraph ergonomic property this design is after: history falls out of a
 * schema instead of being re-implemented by every processor.
 *
 * These types are deliberately free of any storage vocabulary. The same
 * declaration is handed to versioned SQL rows, to an object-store backend, or to
 * the in-memory reference store in this package, and every one of them means the
 * same thing by it.
 */

/**
 * The storage classes an entity field may declare.
 *
 * Four, and no more, because the set is the INTERSECTION of what the backends
 * can hold rather than the union of what any one of them offers. A `uint256` is
 * therefore decimal `text` today, which is a real limitation recorded in
 * `work/notes/findings/sqlite-in-the-browser.md` (contortion 5) and left to
 * `tagged-bigint-codec-across-storage-adapters` to answer properly.
 */
export type FieldType = 'text' | 'integer' | 'real' | 'blob';

export type EntityDeclaration = {
	/** entity name, e.g. `token` */
	name: string;
	/**
	 * The BUSINESS key columns (e.g. `['id']`, or several for a composite key).
	 * Not the version key: a single business key has many versions over time.
	 */
	id: string | readonly string[];
	/** data fields, excluding the business key, and their storage class */
	fields: Readonly<Record<string, FieldType>>;
	/**
	 * The entity this one is a CHILD of, if any (ADR-0098). Optional: a declaration
	 * without it means exactly what it always meant.
	 */
	parent?: EntityRelation;
};

/**
 * A declared relation, written ONCE, on the child (ADR-0098).
 *
 * It is DESCRIPTIVE: the child's leading id columns must BE the parent's whole id,
 * by name and in order, so the relation says what the ids already encode rather
 * than adding a second fact that could disagree with them. The parent's children
 * are then the bounded id-prefix listing with the parent's key as the prefix
 * (ADR-0021), and the relation costs nothing at write time: no referential check
 * and no write order.
 *
 * Checked at DECLARATION time, for every backend (`normalizeEntities`).
 */
export type EntityRelation = {
	/** The declared name of the parent entity. */
	readonly entity: string;
	/**
	 * The name of the parent-side collection of these children: the one thing the
	 * id does not supply, so it is declared rather than guessed by pluralising.
	 */
	readonly as: string;
};

/**
 * An entity declaration after validation, with `id` always a list.
 *
 * `parent` is ABSENT, not `undefined`, on an entity that declares none, so a
 * normalized entity without a relation is the same object it always was.
 */
export type NormalizedEntity = {
	name: string;
	id: readonly string[];
	fields: Readonly<Record<string, FieldType>>;
	parent?: EntityRelation;
};

/** A business-key value: the columns named by the entity's `id`. */
export type EntityId = Record<string, string | number>;

/**
 * A block, as recorded by the store.
 *
 * `timestamp` is seconds since the epoch, as the chain reports it, and it is a
 * NUMBER here on purpose: `blockTimestamp` arrives off a log as hex from most
 * clients and as decimal from at least one, so it is normalised once at the
 * ingestion seam (`normalizeBlockTimestamp`) rather than being guessed at by
 * every reader. `hash` is folded to lower case on write, since it is the
 * identity consumers pin and look up again (`normalizeBlockHash`).
 *
 * There is no `parentHash`, and its absence is a decision rather than an
 * omission: it is not on a log, so it would cost a round-trip per block, and it
 * would describe a linkage this sparse record does not have.
 */
export type BlockPointer = {
	number: number;
	hash: string;
	timestamp: number;
};

/**
 * What a processor produced for one block.
 *
 * An `upsert` closes the live version and opens a new one; a `delete` is only
 * the close, so the entity is absent from that block onward while remaining
 * fully readable as of any earlier block.
 */
export type Mutation =
	| {type: 'upsert'; entity: string; id: EntityId; values: Record<string, unknown>}
	| {type: 'delete'; entity: string; id: EntityId};

/** One block and the mutations to apply with it, as one atomic unit. */
export type BlockUpdate = {block: BlockPointer; mutations: Mutation[]};
