import {assertBlockNumber} from './blocks.js';
import type {CursorWrite} from './cursor.js';
import {normalizeEntities} from './entities.js';
import type {BlockPointer, EntityDeclaration, FieldType, Mutation, NormalizedEntity} from './types.js';

/**
 * ## The snapshot DOCUMENT: format 2 (ADR-0095)
 *
 * What a publisher writes and a client installs, as bytes. It is newline-delimited
 * JSON, gzipped, and every line is one small record, so a reader inflates it with
 * the platform's own `DecompressionStream` and installs it CHUNK BY CHUNK: nothing
 * here ever holds the whole downloaded or decoded document, and the install holds
 * at most ONE block's mutations at a time (the block it is about to apply).
 *
 * The lines, in order:
 *
 * 1. **The head** (`SnapshotHead`): `{format, processor, savedAt, takenAt, floor, cursor}`.
 *    It is the snapshot's small metadata, the same document a location's separate
 *    `head` URL serves, so a client reading only the first line of a body has read
 *    exactly what it would have fetched from the head URL.
 * 2. **One declaration per entity**: `{"declare": name, "id": [...], "fields": [[field, type], ...]}`.
 *    Written ONCE, and it fixes the COLUMN ORDER every row of that entity uses
 *    (the id columns, then the fields in the order listed).
 *    An entity that declares a relation (ADR-0098) carries it as a trailing
 *    `"parent": {entity, as}`; it changes no column, and it is part of the
 *    declaration an install is checked against.
 * 3. **Blocks**, ascending, each opened by `{"block": {number, hash, timestamp}}`.
 *    The FIRST is the FLOOR, and its mutations are the rows LIVE at it; every later
 *    block, up to the CUT (`takenAt`), carries the changes it made. Inside a block,
 *    `{"entity": name}` opens that entity's section, and each following line is one
 *    mutation of it: an ARRAY is an upsert, its values in the declared column order;
 *    `{"delete": [idValues...]}` is a delete, which only a block ABOVE the floor may
 *    carry (the floor is live rows, and a row deleted before it is simply absent).
 *
 * Columnar because the retired format 1 repeated every entity and field name on
 * every row; newline-delimited because a record that fits on a line can be parsed
 * the moment its newline arrives.
 *
 * A `blob` field travels as a `0x`-prefixed hex string (JSON has no bytes), and is
 * decoded back to a `Uint8Array` from the declaration: the one column type whose
 * JSON form is not its value.
 *
 * ## Replaying, not a new install path
 *
 * Installing a document is replaying its blocks through `applyBlock`, the seam
 * every backend already has (`SnapshotAwareStateStore.bootstrap`), so no backend
 * gains a verb for it. A block is ONE `applyBlock`, which is one atomic unit, so a
 * snapshot whose floor is the cut (history `none`) holds its live rows once, while
 * they are written: that is the unit the seam installs, and it is intended.
 */

/**
 * The on-the-wire version of the ENTITY snapshot document.
 *
 * Named for its envelope because it was not always the only format number a
 * snapshot carried in this repo: the free-form path's blob envelope had its own
 * (`BLOB_SNAPSHOT_FORMAT`, `@etherfold/core`) and a reader could hold both at
 * once, so they were separate constants with separate names rather than one
 * number a change to either would falsely invalidate the other. That envelope
 * is deleted with its path (ADR-0037) and this is the only one left; the NAME
 * stays, because a bare `SNAPSHOT_FORMAT` would be the coin toss the split
 * existed to prevent if a second artifact ever earns a number again.
 *
 * Bumped when the SHAPE changes in a way an older reader would misread. An
 * unknown format is refused (`SnapshotFormatError`) rather than parsed for the
 * fields that happen to be recognisable, because a snapshot half-understood is
 * state a client would accept and act on (ADR-0040).
 *
 * ## 2: rows at a floor, then per-block changes, columnar, newline-delimited, gzipped
 *
 * Format 1 was a JSON object of `Mutation` upserts at one block. It was never
 * published, so it was REPLACED rather than kept beside this one (ADR-0095), and a
 * format-1 document is refused like any other unknown format: it is not gzipped,
 * so it does not even inflate.
 *
 * ## It did NOT move when `processor` stopped being a declared version hash
 *
 * ADR-0086 changed where a `processor` label COMES FROM -- the identity the
 * producing deployment's arrival derived, rather than a hash of a field its
 * author wrote -- and that is a VALUE change, not a FORMAT change. `processor` is
 * the same field, saying the same thing (WHICH FOLD computed these rows), and it
 * is opaque on both sides, compared for EQUALITY and never parsed, so a label
 * derived the old way is simply not this client's fold: NOT A CANDIDATE
 * (`processor-mismatch`), or `SnapshotProcessorMismatchError` at install. A bump
 * would have converted that precise refusal into `unreadable-format`, which tells a
 * user their app or the publisher is out of date when the truth is that the
 * snapshot is for another processor. Bump this when a FIELD appears, disappears or
 * changes meaning, as format 2 did.
 */
export const ENTITY_SNAPSHOT_FORMAT = 2;

/**
 * A snapshot's small metadata: the first line of its document, and what a mirror
 * publishes separately so a client can CHOOSE between mirrors without downloading
 * any body.
 */
export type SnapshotHead = {
	readonly format: number;
	/**
	 * WHICH FOLD COMPUTED THESE ROWS: its identity, as the producing deployment's
	 * ARRIVAL derived it (ADR-0086) -- the SHA-256 of a bundle's octets where there
	 * are bytes.
	 *
	 * Checked for EQUALITY against the identity the local deployment was handed, so
	 * state computed by different logic is refused rather than trusted. It is never
	 * parsed, and nothing here has an opinion about which arrival produced either
	 * side, which is what lets a producer and a consumer derive one two different
	 * ways and still agree when they are the same fold.
	 */
	readonly processor: string;
	/** When the snapshot was produced. Informational; nothing keys off it. */
	readonly savedAt: string;
	/**
	 * The block the state is AS OF once the document is installed: the pointer of
	 * its LAST block (the cut).
	 *
	 * A producer points it at a RECORDED block (ADR-0095: the highest recorded block
	 * at or below the cut), because only a recorded block has a hash and a timestamp
	 * to give.
	 */
	readonly takenAt: BlockPointer;
	/**
	 * The HISTORY FLOOR: the number of the document's FIRST block, whose mutations
	 * are the rows live at it. The installed store reports it as its floor and
	 * refuses a read or a revert under it (ADR-0028). Equal to `takenAt.number` for
	 * a snapshot that carries no history (`none`).
	 */
	readonly floor: number;
	/**
	 * The cursor that belongs to the state at `takenAt`, installed in the SAME unit
	 * as the last block.
	 *
	 * Opaque here, as everywhere at this seam: it is a serialized `LastSync` and
	 * only the processor above knows that. Optional only so that a store can be
	 * seeded with rows in a test without inventing a cursor; a published snapshot
	 * without one would have its consumer resume from the start block and index
	 * over the rows it just installed.
	 */
	readonly cursor?: CursorWrite;
};

/**
 * A produced snapshot, whole: its head, and its document as gzipped bytes.
 *
 * What `createSnapshot` (`@etherfold/processor-entities`) hands back, and what a
 * mirror serves: `document` at its URL, `head` at its optional head URL.
 */
export type StateSnapshot = {
	readonly head: SnapshotHead;
	/** Backed by a plain `ArrayBuffer`, so it is a `BodyInit` a mirror can serve as it is. */
	readonly document: Uint8Array<ArrayBuffer>;
};

/**
 * A snapshot document as a host may hold it: bytes in hand, a response body, or
 * any async source of byte chunks. Always the GZIPPED document.
 */
export type SnapshotDocument = Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

/** One block of a document, as a reader yields it. */
export type SnapshotBlock = {
	readonly block: BlockPointer;
	readonly mutations: readonly Mutation[];
	/** Whether this is the document's LAST block, the one the head's `takenAt` names and the cursor rides. */
	readonly last: boolean;
};

/**
 * One block as the ENCODER takes it. The mutations may arrive lazily (a producer
 * paging rows out of a database), and the encoder writes each one as it comes, so
 * a producer never holds the floor's rows either.
 */
export type SnapshotBlockSource = {
	readonly block: BlockPointer;
	readonly mutations: Iterable<Mutation> | AsyncIterable<Mutation>;
};

/** A snapshot whose document this build does not know how to read. */
export class SnapshotFormatError extends Error {
	readonly name = 'SnapshotFormatError';

	constructor(
		readonly found: unknown,
		readonly supported: number = ENTITY_SNAPSHOT_FORMAT,
	) {
		super(
			`snapshot format ${JSON.stringify(found)} is not one this build reads (it reads ${supported}). Reading the ` +
				`fields that happen to be recognisable would install state understood only in part, which a client cannot ` +
				`tell apart from state it understood fully.`,
		);
	}
}

/**
 * A document opened for reading: its head, already read and checked, and the rest
 * still unread.
 *
 * Opening reads ONE line, so a client choosing between mirrors whose bodies are
 * their heads pays for the head and nothing else; `cancel` releases the download
 * of a mirror that lost.
 */
export type SnapshotReader = {
	readonly head: SnapshotHead;
	/**
	 * The document's blocks, in order, each yielded as soon as the NEXT block's
	 * opening line (or the end) proves it complete: at most one block's mutations
	 * are held. Callable once.
	 *
	 * With `declarations`, every entity the document declares must match the one
	 * of that name there exactly (id columns, fields and their types), so a row is
	 * never installed under a column layout it was not written in.
	 */
	blocks(options?: {readonly declarations?: ReadonlyMap<string, NormalizedEntity>}): AsyncIterable<SnapshotBlock>;
	/** Stop reading, and release the underlying source. */
	cancel(): Promise<void>;
};

/** Roughly how much text the encoder gathers before it hands a chunk to the compressor. */
const ENCODE_CHUNK = 64 * 1024;

/**
 * Write a format-2 document, as a stream of gzipped bytes.
 *
 * Pull-driven: nothing is read out of `blocks` until a reader asks for bytes, and
 * each mutation is written as it arrives, so the encoder holds a chunk of text and
 * never the rows. The head is checked here, before anything is written, and the
 * blocks as they pass (ascending, the first at the floor and carrying no delete,
 * the last at `takenAt`); a violation ERRORS the stream, which is what a writer
 * piping it to a file sees.
 */
export function encodeSnapshot(
	head: Omit<SnapshotHead, 'format'>,
	declarations: Iterable<EntityDeclaration>,
	blocks: Iterable<SnapshotBlockSource> | AsyncIterable<SnapshotBlockSource>,
): ReadableStream<Uint8Array> {
	const fullHead: SnapshotHead = {format: ENTITY_SNAPSHOT_FORMAT, ...head};
	assertHead(fullHead);
	const entities = normalizeEntities(declarations);
	const source = encodedLines(fullHead, entities, blocks);
	const encoder = new TextEncoder();

	const plain = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				let text = '';
				while (text.length < ENCODE_CHUNK) {
					const next = await source.next();
					if (next.done) {
						if (text.length > 0) controller.enqueue(encoder.encode(text));
						controller.close();
						return;
					}
					text += `${next.value}\n`;
				}
				controller.enqueue(encoder.encode(text));
			},
			async cancel() {
				await source.return(undefined);
			},
		},
		{highWaterMark: 0},
	);
	return plain.pipeThrough(codec(new CompressionStream('gzip')));
}

async function* encodedLines(
	head: SnapshotHead,
	entities: ReadonlyMap<string, NormalizedEntity>,
	blocks: Iterable<SnapshotBlockSource> | AsyncIterable<SnapshotBlockSource>,
): AsyncGenerator<string> {
	yield JSON.stringify(head);
	for (const entity of entities.values()) {
		// `parent` is written only when declared, so an entity without a relation
		// keeps the exact line it always had (ADR-0098: existing declarations keep working).
		yield JSON.stringify({
			declare: entity.name,
			id: entity.id,
			fields: Object.entries(entity.fields),
			...(entity.parent ? {parent: {entity: entity.parent.entity, as: entity.parent.as}} : {}),
		});
	}

	let previous: number | undefined;
	for await (const {block, mutations} of blocks) {
		assertBlockNumber(block.number);
		if (previous === undefined && block.number !== head.floor) {
			throw new Error(
				`a snapshot's first block is its floor: expected block ${head.floor}, the head's \`floor\`, got ${block.number}`,
			);
		}
		if (previous !== undefined && block.number <= previous) {
			throw new Error(`a snapshot's blocks must ascend: block ${block.number} follows block ${previous}`);
		}
		if (block.number > head.takenAt.number) {
			throw new Error(
				`a snapshot's blocks end at its cut: block ${block.number} is above \`takenAt\` (${head.takenAt.number})`,
			);
		}
		const atFloor = previous === undefined;
		previous = block.number;
		yield JSON.stringify({block: {number: block.number, hash: block.hash, timestamp: block.timestamp}});

		let section: string | undefined;
		for await (const mutation of mutations) {
			const entity = entities.get(mutation.entity);
			if (!entity) {
				throw new Error(`a snapshot mutation names entity \`${mutation.entity}\`, which the snapshot does not declare`);
			}
			if (section !== entity.name) {
				section = entity.name;
				yield JSON.stringify({entity: entity.name});
			}
			if (mutation.type === 'delete') {
				if (atFloor) throw deleteAtFloor(mutation.entity);
				yield JSON.stringify({delete: entity.id.map((column) => String(mutation.id[column]))});
			} else {
				yield JSON.stringify(encodeRow(entity, mutation));
			}
		}
	}
	if (previous !== head.takenAt.number) {
		throw new Error(
			`a snapshot's last block is its cut: the head says block ${head.takenAt.number}, and the last block written ` +
				`was ${previous === undefined ? 'none at all' : previous}`,
		);
	}
}

function deleteAtFloor(entity: string): Error {
	return new Error(
		`a snapshot's floor carries the rows that are LIVE at it, so it cannot contain a delete (\`${entity}\`). A row ` +
			`the processor deleted before the floor is simply absent from it; a delete there would describe a version ` +
			`boundary the snapshot has no history to hold.`,
	);
}

/** One upsert, as its values in the declared column order. */
function encodeRow(entity: NormalizedEntity, mutation: Extract<Mutation, {type: 'upsert'}>): unknown[] {
	const row: unknown[] = entity.id.map((column) => String(mutation.id[column]));
	for (const [field, type] of Object.entries(entity.fields)) {
		row.push(encodeValue(mutation.values?.[field] ?? null, type));
	}
	return row;
}

function encodeValue(value: unknown, type: FieldType): unknown {
	if (value === null || value === undefined) return null;
	if (type !== 'blob') return value;
	const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : (value as Uint8Array);
	if (!(bytes instanceof Uint8Array)) {
		throw new Error(`a \`blob\` field must hold bytes (a Uint8Array), got ${typeof value}`);
	}
	let hex = '0x';
	for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
	return hex;
}

function decodeValue(value: unknown, type: FieldType): unknown {
	if (value === null || type !== 'blob') return value;
	if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
		throw new Error(`a snapshot's \`blob\` value must be 0x-prefixed hex, got ${JSON.stringify(value)}`);
	}
	const bytes = new Uint8Array((value.length - 2) / 2);
	for (let index = 0; index < bytes.length; index++) {
		bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
	}
	return bytes;
}

function assertHead(head: SnapshotHead): void {
	if (typeof head.processor !== 'string' || head.processor.length === 0) {
		throw new Error(`a snapshot's head must name the processor that computed it`);
	}
	assertBlockNumber(head.takenAt?.number);
	assertBlockNumber(head.floor);
	if (head.floor > head.takenAt.number) {
		throw new Error(`a snapshot's floor (${head.floor}) cannot be above its cut (${head.takenAt.number})`);
	}
}

/**
 * Whether a value is a head this build reads: format 2, with the fields a client
 * selects on. What a separately published head document is checked with.
 */
export function isReadableSnapshotHead(value: unknown): value is SnapshotHead {
	const head = value as SnapshotHead | undefined;
	return (
		!!head &&
		typeof head === 'object' &&
		head.format === ENTITY_SNAPSHOT_FORMAT &&
		typeof head.processor === 'string' &&
		typeof head.takenAt?.number === 'number' &&
		typeof head.floor === 'number'
	);
}

/**
 * Open a document: inflate it incrementally and read its head.
 *
 * Refuses with `SnapshotFormatError` when the head cannot be read as format 2 --
 * the bytes do not inflate (format 1 was plain JSON), the first line is not JSON,
 * or its `format` is another number -- because every one of those is a document
 * this build cannot read, and none of them is a transport failure.
 */
export async function readSnapshot(document: SnapshotDocument): Promise<SnapshotReader> {
	const lines = linesOf(toStream(document).pipeThrough(codec(new DecompressionStream('gzip'))));
	let head: unknown;
	try {
		const first = await lines.next();
		head = first.done ? undefined : JSON.parse(first.value);
	} catch {
		await lines.return(undefined);
		throw new SnapshotFormatError(undefined);
	}
	if (!isReadableSnapshotHead(head)) {
		await lines.return(undefined);
		throw new SnapshotFormatError((head as {format?: unknown} | undefined)?.format);
	}
	const checked = head;

	let started = false;
	return {
		head: checked,
		blocks(options = {}) {
			if (started) throw new Error(`a snapshot document's blocks can be read once`);
			started = true;
			return decodedBlocks(checked, lines, options.declarations);
		},
		async cancel() {
			await lines.return(undefined);
		},
	};
}

type Section = {readonly entity: NormalizedEntity; readonly columns: number};

async function* decodedBlocks(
	head: SnapshotHead,
	lines: AsyncGenerator<string>,
	expected: ReadonlyMap<string, NormalizedEntity> | undefined,
): AsyncGenerator<SnapshotBlock> {
	const declared = new Map<string, Section>();
	let current: {block: BlockPointer; mutations: Mutation[]} | undefined;
	let section: Section | undefined;
	let blocksSeen = 0;

	try {
		for await (const line of lines) {
			const record = JSON.parse(line) as unknown;

			if (Array.isArray(record)) {
				if (!current || !section) throw new Error(`a snapshot row appears outside an entity section of a block`);
				if (record.length !== section.columns) {
					throw new Error(
						`a \`${section.entity.name}\` row has ${record.length} values and the entity declares ${section.columns} columns`,
					);
				}
				current.mutations.push(decodeRow(section.entity, record));
				continue;
			}
			if (!record || typeof record !== 'object')
				throw new Error(`a snapshot line is not a record: ${line.slice(0, 80)}`);
			const fields = record as Record<string, unknown>;

			if ('delete' in fields) {
				if (!current || !section) throw new Error(`a snapshot delete appears outside an entity section of a block`);
				if (blocksSeen === 1) throw deleteAtFloor(section.entity.name);
				const values = fields.delete as unknown[];
				if (!Array.isArray(values) || values.length !== section.entity.id.length) {
					throw new Error(`a \`${section.entity.name}\` delete must carry its id values`);
				}
				const id: Record<string, string> = {};
				section.entity.id.forEach((column, index) => (id[column] = String(values[index])));
				current.mutations.push({type: 'delete', entity: section.entity.name, id});
			} else if ('entity' in fields) {
				if (!current) throw new Error(`a snapshot entity section appears before any block`);
				section = declared.get(String(fields.entity));
				if (!section) throw new Error(`a snapshot section names entity \`${fields.entity}\`, which it never declared`);
			} else if ('block' in fields) {
				const block = fields.block as BlockPointer;
				assertBlockNumber(block?.number);
				if (blocksSeen === 0 && block.number !== head.floor) {
					throw new Error(
						`a snapshot's first block is its floor (${head.floor}), and this one opens at ${block.number}`,
					);
				}
				if (current && block.number <= current.block.number) {
					throw new Error(`a snapshot's blocks must ascend: block ${block.number} follows ${current.block.number}`);
				}
				if (current) yield {...current, last: false};
				current = {block: {number: block.number, hash: block.hash, timestamp: block.timestamp}, mutations: []};
				section = undefined;
				blocksSeen++;
			} else if ('declare' in fields) {
				if (current) throw new Error(`a snapshot declares entity \`${fields.declare}\` after its first block`);
				const entity = declarationOf(fields);
				const local = expected?.get(entity.name);
				if (expected && !sameDeclaration(entity, local)) {
					throw new Error(
						`this snapshot declares \`${entity.name}\` as ${describe(entity)}, and this store declares ` +
							`${local ? describe(local) : 'no such entity'}. Its rows were written in a layout this store does not ` +
							`have, so they are refused rather than installed under the wrong columns.`,
					);
				}
				declared.set(entity.name, {entity, columns: entity.id.length + Object.keys(entity.fields).length});
			} else {
				throw new Error(`a snapshot line is not a record this build knows: ${line.slice(0, 80)}`);
			}
		}
	} finally {
		await lines.return(undefined);
	}

	if (!current) throw new Error(`a snapshot document carries no block at all, not even its floor`);
	if (current.block.number !== head.takenAt.number) {
		throw new Error(
			`a snapshot's last block is its cut: the head says block ${head.takenAt.number}, and the document ends at ` +
				`block ${current.block.number}`,
		);
	}
	yield {...current, last: true};
}

function declarationOf(fields: Record<string, unknown>): NormalizedEntity {
	const id = fields.id;
	const pairs = fields.fields;
	const parent = fields.parent as {entity?: unknown; as?: unknown} | undefined;
	if (
		typeof fields.declare !== 'string' ||
		!Array.isArray(id) ||
		!id.every((column) => typeof column === 'string') ||
		!Array.isArray(pairs) ||
		!pairs.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string') ||
		(parent !== undefined &&
			(parent === null ||
				typeof parent !== 'object' ||
				typeof parent.entity !== 'string' ||
				typeof parent.as !== 'string'))
	) {
		throw new Error(`a snapshot entity declaration is malformed`);
	}
	return {
		name: fields.declare,
		id: id as string[],
		fields: Object.fromEntries(pairs as [string, FieldType][]),
		...(parent ? {parent: {entity: parent.entity as string, as: parent.as as string}} : {}),
	};
}

function sameDeclaration(a: NormalizedEntity, b: NormalizedEntity | undefined): boolean {
	if (!b) return false;
	if (a.id.length !== b.id.length || a.id.some((column, index) => b.id[index] !== column)) return false;
	if (a.parent?.entity !== b.parent?.entity || a.parent?.as !== b.parent?.as) return false;
	const fields = Object.entries(a.fields);
	return fields.length === Object.keys(b.fields).length && fields.every(([field, type]) => b.fields[field] === type);
}

function describe(entity: NormalizedEntity): string {
	const parent = entity.parent ? ` under ${entity.parent.entity} as ${entity.parent.as}` : '';
	return `(${entity.id.join(', ')}) {${Object.entries(entity.fields)
		.map(([field, type]) => `${field}: ${type}`)
		.join(', ')}}${parent}`;
}

function decodeRow(entity: NormalizedEntity, row: unknown[]): Mutation {
	const id: Record<string, string> = {};
	entity.id.forEach((column, index) => (id[column] = String(row[index])));
	const values: Record<string, unknown> = {};
	let index = entity.id.length;
	for (const [field, type] of Object.entries(entity.fields)) {
		values[field] = decodeValue(row[index++], type);
	}
	return {type: 'upsert', entity: entity.name, id, values};
}

/**
 * The platform's gzip transform, typed as the byte pair it is. The DOM typing's
 * writable side is `BufferSource`, which a `Uint8Array` stream does not narrow to.
 */
function codec(transform: CompressionStream | DecompressionStream): ReadableWritablePair<Uint8Array, Uint8Array> {
	return transform as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
}

/** Any document form, as a byte stream. */
function toStream(document: SnapshotDocument): ReadableStream<Uint8Array> {
	if (document instanceof Uint8Array || document instanceof ArrayBuffer) {
		const bytes = document instanceof ArrayBuffer ? new Uint8Array(document) : document;
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		});
	}
	if (typeof (document as ReadableStream<Uint8Array>).getReader === 'function') {
		return document as ReadableStream<Uint8Array>;
	}
	const iterator = (document as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				const next = await iterator.next();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			},
			async cancel() {
				await iterator.return?.();
			},
		},
		{highWaterMark: 0},
	);
}

/**
 * The lines of a byte stream, decoded as they arrive: only the current partial
 * line is ever held. Returning early CANCELS the stream, so a reader that stops
 * does not go on downloading.
 */
async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let partial = '';
	let finished = false;
	try {
		for (;;) {
			const {done, value} = await reader.read();
			if (done) break;
			const text = partial + decoder.decode(value, {stream: true});
			let start = 0;
			let newline = text.indexOf('\n', start);
			while (newline >= 0) {
				if (newline > start) yield text.slice(start, newline);
				start = newline + 1;
				newline = text.indexOf('\n', start);
			}
			partial = text.slice(start);
		}
		partial += decoder.decode();
		if (partial.length > 0) yield partial;
		finished = true;
	} finally {
		if (finished) reader.releaseLock();
		else await reader.cancel().catch(() => undefined);
	}
}
