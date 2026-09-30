import {describe, expect, it, vi} from 'vitest';
import {
	BlockNotRetainedError,
	encodeSnapshot,
	MemoryStateStore,
	openSnapshotAware,
	readSnapshot,
	RevertBeyondSnapshotError,
	SnapshotFormatError,
	SnapshotProcessorMismatchError,
	type BlockPointer,
	type CursorWrite,
	type EntityDeclaration,
	type Mutation,
	type StateStoreBackend,
} from '../src/index.js';
import {ACCOUNT, TOKEN, block, owns} from './utils/fixtures.js';

/**
 * A store that starts from state somebody else computed, and stays honest about
 * the history it never received.
 *
 * The trap these cases exist for is one sentence long: a snapshot of CURRENT
 * rows carries nothing below the block it was taken at, so a store loaded from
 * it cannot answer an as-of read below that block -- and a freshly-migrated
 * store reports `unbounded`, which would be exactly the confident wrong number
 * this whole seam exists to prevent. So every case here is about a boundary:
 * where reads stop being answerable, where a revert stops being possible, and
 * that both boundaries survive the handle being reopened.
 *
 * The snapshot is a format-2 DOCUMENT (ADR-0095): gzipped, newline-delimited,
 * rows at a floor then the blocks above it. The cases below build real documents
 * through the encoder, so what is installed is what a publisher writes.
 */

const TAKEN_AT = 1_000;

/** Collect a document stream into the bytes a mirror would serve. */
async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

type Options = {
	processor?: string;
	rows?: Mutation[];
	cursor?: CursorWrite;
	declarations?: EntityDeclaration[];
	/** Blocks ABOVE the floor, up to the cut: the history a snapshot may carry. */
	later?: {block: BlockPointer; mutations: Mutation[]}[];
};

/** A no-history (`none`) document at `number`, unless `later` blocks are given. */
function snapshotAt(number: number, options: Options = {}): Promise<Uint8Array> {
	const later = options.later ?? [];
	const cut = later.length > 0 ? later[later.length - 1].block : block(number);
	return bytesOf(
		encodeSnapshot(
			{
				processor: options.processor ?? 'proc-v1',
				savedAt: '2026-08-24T00:00:00.000Z',
				takenAt: cut,
				floor: number,
				cursor: options.cursor ?? {key: 'lastSync', value: `synced-through-${cut.number}`},
			},
			options.declarations ?? [TOKEN, ACCOUNT],
			[{block: block(number), mutations: options.rows ?? [owns('1', '0xalice', 3), owns('2', '0xbob', 1)]}, ...later],
		),
	);
}

/** Gzip some lines by hand: a document the encoder would never write. */
function handWritten(lines: unknown[]): Promise<Uint8Array> {
	const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
	return bytesOf(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')) as ReadableStream<Uint8Array>);
}

/**
 * A document served the way a slow network serves it: a few bytes per pull, and
 * nothing read ahead of the reader. `read()` reports how much has left the source.
 */
function trickled(bytes: Uint8Array, chunk = 64) {
	let offset = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (offset >= bytes.length) return controller.close();
				controller.enqueue(bytes.slice(offset, offset + chunk));
				offset += chunk;
			},
		},
		{highWaterMark: 0},
	);
	return {stream, read: () => Math.min(offset, bytes.length)};
}

async function bootstrapped(inner?: StateStoreBackend, at = TAKEN_AT) {
	const store = await openSnapshotAware(inner ?? new MemoryStateStore([TOKEN, ACCOUNT]));
	await store.migrate();
	await store.bootstrap(await snapshotAt(at), {processor: 'proc-v1'});
	return store;
}

async function fresh() {
	const store = await openSnapshotAware(new MemoryStateStore([TOKEN, ACCOUNT]));
	await store.migrate();
	return store;
}

/** Many rows of values that do not compress away, so the document spans many chunks. */
function manyRows(count: number, salt: string): Mutation[] {
	return Array.from({length: count}, (_, index) =>
		owns(String(index), `0x${salt}${Math.random().toString(16).slice(2)}${index.toString(16)}`, index),
	);
}

describe('installing a snapshot', () => {
	it('lands the rows and the cursor that belongs to them as ONE unit', async () => {
		const store = await bootstrapped();

		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice', transferCount: 3});
		expect(await store.getCurrent('token', {id: '2'})).toMatchObject({owner: '0xbob'});
		expect(await store.readCursor('lastSync')).toBe(`synced-through-${TAKEN_AT}`);
	});

	it('refuses a snapshot computed by a different processor, naming both versions', async () => {
		const store = await fresh();

		const refusal = await store
			.bootstrap(await snapshotAt(TAKEN_AT, {processor: 'proc-v2'}), {processor: 'proc-v1'})
			.catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(SnapshotProcessorMismatchError);
		expect((refusal as SnapshotProcessorMismatchError).message).toContain('proc-v1');
		expect((refusal as SnapshotProcessorMismatchError).message).toContain('proc-v2');
		// and nothing landed: a refused snapshot leaves an empty store empty
		expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
		expect(store.capabilities.retention).toEqual({kind: 'unbounded'});
	});

	it('refuses a format it does not know rather than reading the fields it recognises', async () => {
		const store = await fresh();
		const document = await handWritten([
			{format: 99, processor: 'proc-v1', savedAt: '', takenAt: block(TAKEN_AT), floor: TAKEN_AT},
		]);

		const refusal = await store.bootstrap(document).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(SnapshotFormatError);
		expect((refusal as SnapshotFormatError).found).toBe(99);
	});

	it('refuses a FORMAT-1 document, which was never published and is not read beside format 2', async () => {
		const formatOne = {
			format: 1,
			processor: 'proc-v1',
			savedAt: '2026-08-24T00:00:00.000Z',
			takenAt: block(TAKEN_AT),
			rows: [owns('1', '0xalice', 3)],
		};

		// as it was served (plain JSON, read as an already-inflated body whose head is format 1) and gzipped
		// (the same head, after the inflate)
		await expect((await fresh()).bootstrap(new TextEncoder().encode(JSON.stringify(formatOne)))).rejects.toBeInstanceOf(
			SnapshotFormatError,
		);
		await expect((await fresh()).bootstrap(await handWritten([formatOne]))).rejects.toBeInstanceOf(SnapshotFormatError);
	});

	it('refuses a floor carrying a delete, because the floor is the rows that are LIVE', async () => {
		const store = await fresh();
		const document = await handWritten([
			{format: 2, processor: 'proc-v1', savedAt: '', takenAt: block(TAKEN_AT), floor: TAKEN_AT},
			{
				declare: 'token',
				id: ['id'],
				fields: [
					['owner', 'text'],
					['transferCount', 'integer'],
				],
			},
			{block: block(TAKEN_AT)},
			{entity: 'token'},
			{delete: ['1']},
		]);

		await expect(store.bootstrap(document)).rejects.toThrow(/delete/);
		// the floor is read in full before anything is written, so nothing was
		expect((await openSnapshotAware(store)).snapshotOrigin).toBeUndefined();
	});

	it('and the encoder refuses to write one', async () => {
		await expect(snapshotAt(TAKEN_AT, {rows: [{type: 'delete', entity: 'token', id: {id: '1'}}]})).rejects.toThrow(
			/delete/,
		);
	});

	it('refuses rows written in a layout this store does not declare, writing nothing', async () => {
		const store = await fresh();
		const elsewhere: EntityDeclaration = {name: 'token', id: ['id'], fields: {owner: 'text', colour: 'text'}};
		const document = await snapshotAt(TAKEN_AT, {
			declarations: [elsewhere],
			rows: [{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xalice', colour: 'red'}}],
		});

		await expect(store.bootstrap(document)).rejects.toThrow(/colour/);
		expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
		expect(store.snapshotOrigin).toBeUndefined();
	});

	it('refuses a document that stops short of the cut its head names', async () => {
		const store = await fresh();
		const document = await handWritten([
			{format: 2, processor: 'proc-v1', savedAt: '', takenAt: block(TAKEN_AT + 5), floor: TAKEN_AT},
			{
				declare: 'token',
				id: ['id'],
				fields: [
					['owner', 'text'],
					['transferCount', 'integer'],
				],
			},
			{block: block(TAKEN_AT)},
			{entity: 'token'},
			['1', '0xalice', 3],
		]);

		await expect(store.bootstrap(document)).rejects.toThrow(/cut/);
		// and the cursor, which rides the LAST block, never landed
		expect(await store.readCursor('lastSync')).toBeUndefined();
	});
});

describe('the document, streamed', () => {
	it('installs from a document many chunks long, fed a few bytes at a time', async () => {
		const rows = manyRows(2_000, 'a');
		const bytes = await snapshotAt(TAKEN_AT, {rows});
		expect(bytes.length).toBeGreaterThan(64 * 100);
		const source = trickled(bytes);
		const store = await fresh();

		await store.bootstrap(source.stream, {processor: 'proc-v1'});

		expect(source.read()).toBe(bytes.length);
		for (const row of [rows[0], rows[999], rows[1_999]] as Extract<Mutation, {type: 'upsert'}>[]) {
			expect(await store.getCurrent('token', row.id)).toMatchObject(row.values);
		}
		expect(await store.readCursor('lastSync')).toBe(`synced-through-${TAKEN_AT}`);
	});

	it('applies a block before the rest of the document has been read, and holds one block at a time', async () => {
		// three blocks, each large: if the install buffered the document, the first
		// `applyBlock` would only come once every byte had left the source. Large
		// enough that the platform's own inflate buffering (tens of KB) is a small
		// part of it.
		const later = [
			{block: block(TAKEN_AT + 1), mutations: manyRows(30_000, 'b')},
			{block: block(TAKEN_AT + 2), mutations: manyRows(30_000, 'c')},
		];
		const bytes = await snapshotAt(TAKEN_AT, {rows: manyRows(30_000, 'a'), later});
		const source = trickled(bytes, 1024);
		const inner = new MemoryStateStore([TOKEN, ACCOUNT]);
		const applied: {block: number; mutations: number; readSoFar: number; cursor: boolean}[] = [];
		const apply = inner.applyBlock.bind(inner);
		inner.applyBlock = async (at, mutations, cursor) => {
			applied.push({block: at.number, mutations: mutations?.length ?? 0, readSoFar: source.read(), cursor: !!cursor});
			return apply(at, mutations, cursor);
		};
		const store = await openSnapshotAware(inner);

		await store.bootstrap(source.stream, {processor: 'proc-v1'});

		expect(applied.map(({block, mutations, cursor}) => ({block, mutations, cursor}))).toEqual([
			{block: TAKEN_AT, mutations: 30_000, cursor: false},
			{block: TAKEN_AT + 1, mutations: 30_000, cursor: false},
			// the cursor rides the LAST block, the one the head's `takenAt` names
			{block: TAKEN_AT + 2, mutations: 30_000, cursor: true},
		]);
		// the floor was applied with (roughly) a third of the document read, plus
		// whatever the platform's inflate buffers ahead, which is bounded (below)
		expect(applied[0].readSoFar).toBeLessThan((bytes.length * 2) / 3);
		expect(applied[1].readSoFar).toBeLessThan(bytes.length);
	});

	it('reads only the head when that is all a caller asks for, and cancels the rest', async () => {
		const bytes = await snapshotAt(TAKEN_AT, {rows: manyRows(100_000, 'd')});
		const source = trickled(bytes, 1024);

		const reader = await readSnapshot(source.stream);
		await reader.cancel();

		expect(reader.head).toMatchObject({format: 2, processor: 'proc-v1', floor: TAKEN_AT});
		// a constant, not a fraction: the inflate stage reads a bounded way ahead
		// (Node's stream adapters buffer on the order of 100 KB), and a document many
		// times that size is still read no further than that
		expect(bytes.length).toBeGreaterThan(1_000_000);
		expect(source.read()).toBeLessThan(256 * 1024);
	});

	it('carries a `blob` field as bytes, through a column JSON has no type for', async () => {
		const SEALED: EntityDeclaration = {name: 'sealed', id: ['id'], fields: {payload: 'blob', note: 'text'}};
		const payload = new Uint8Array([0, 1, 127, 128, 255]);
		const bytes = await snapshotAt(TAKEN_AT, {
			declarations: [SEALED],
			rows: [{type: 'upsert', entity: 'sealed', id: {id: 'x'}, values: {payload, note: null}}],
		});

		const reader = await readSnapshot(bytes);
		const blocks = [];
		for await (const read of reader.blocks()) blocks.push(read);

		expect(blocks).toHaveLength(1);
		expect(blocks[0].mutations).toEqual([
			{type: 'upsert', entity: 'sealed', id: {id: 'x'}, values: {payload, note: null}},
		]);
	});
});

/** The document as a runtime hands it over when the host served it with `Content-Encoding: gzip`. */
function inflated(bytes: Uint8Array): Promise<Uint8Array> {
	return bytesOf(
		new Blob([bytes as Uint8Array<ArrayBuffer>])
			.stream()
			.pipeThrough(new DecompressionStream('gzip')) as ReadableStream<Uint8Array>,
	);
}

/** One more gzip layer over bytes that are already gzipped. */
function gzippedAgain(bytes: Uint8Array): Promise<Uint8Array> {
	return bytesOf(
		new Blob([bytes as Uint8Array<ArrayBuffer>])
			.stream()
			.pipeThrough(new CompressionStream('gzip')) as ReadableStream<Uint8Array>,
	);
}

/** A source that records whether it was CANCELLED, which is what releasing a download is. */
function cancellable(bytes: Uint8Array, chunk = 1024) {
	const source = trickled(bytes, chunk);
	let cancelled = false;
	const reader = source.stream.getReader();
	const stream = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				const {done, value} = await reader.read();
				if (done) controller.close();
				else controller.enqueue(value);
			},
			async cancel(reason) {
				cancelled = true;
				await reader.cancel(reason);
			},
		},
		{highWaterMark: 0},
	);
	return {stream, read: source.read, cancelled: () => cancelled};
}

describe('a document served opaque or already inflated (`Content-Encoding: gzip`)', () => {
	const later = [
		{block: block(TAKEN_AT + 1), mutations: [owns('1', '0xcarol', 4)]},
		{block: block(TAKEN_AT + 2), mutations: [{type: 'delete', entity: 'token', id: {id: '2'}} as Mutation]},
	];

	async function installed(document: ReadableStream<Uint8Array> | Uint8Array) {
		const store = await fresh();
		await store.bootstrap(document, {processor: 'proc-v1'});
		return {
			rows: [
				await store.getCurrent('token', {id: '1'}),
				await store.getCurrent('token', {id: '2'}),
				await store.getAsOf('token', {id: '2'}, TAKEN_AT + 1),
			],
			cursor: await store.readCursor('lastSync'),
			origin: store.snapshotOrigin,
		};
	}

	it('lands on identical rows and the same resume position either way', async () => {
		const opaque = await snapshotAt(TAKEN_AT, {later});
		const plain = await inflated(opaque);
		// what arrives already inflated is the ndjson text, whose first byte is `{`
		expect(plain[0]).toBe('{'.charCodeAt(0));

		const fromOpaque = await installed(opaque);
		const fromPlain = await installed(plain);

		expect(fromOpaque.rows[0]).toMatchObject({owner: '0xcarol', transferCount: 4});
		expect(fromOpaque.rows[1]).toBeUndefined();
		expect(fromOpaque.cursor).toBe(`synced-through-${TAKEN_AT + 2}`);
		// the history floor is the document's first block
		expect(fromOpaque.origin).toBe(TAKEN_AT);
		expect(fromPlain).toEqual(fromOpaque);
	});

	it('installs either way when the body arrives ONE byte at a time, so the sniff never assumes a chunk holds two', async () => {
		const opaque = await snapshotAt(TAKEN_AT, {later});
		const plain = await inflated(opaque);

		const reference = await installed(opaque);
		expect(await installed(trickled(opaque, 1).stream)).toEqual(reference);
		expect(await installed(trickled(plain, 1).stream)).toEqual(reference);
	});

	it('refuses a body gzipped TWICE, because exactly one layer is peeled', async () => {
		const twice = await gzippedAgain(await snapshotAt(TAKEN_AT));

		await expect((await fresh()).bootstrap(twice)).rejects.toBeInstanceOf(SnapshotFormatError);
		await expect(readSnapshot(trickled(twice, 1).stream)).rejects.toBeInstanceOf(SnapshotFormatError);
	});

	it('streams an already-inflated body too, reading only its head when that is all a caller asks for', async () => {
		const plain = await inflated(await snapshotAt(TAKEN_AT, {rows: manyRows(40_000, 'e')}));
		const source = trickled(plain, 1024);

		const reader = await readSnapshot(source.stream);
		await reader.cancel();

		expect(reader.head).toMatchObject({format: 2, processor: 'proc-v1', floor: TAKEN_AT});
		expect(plain.length).toBeGreaterThan(1_000_000);
		// nothing reads ahead of the line reader here, so the head is a chunk or two
		expect(source.read()).toBeLessThan(8 * 1024);
	});

	for (const form of ['opaque', 'already inflated'] as const) {
		it(`cancels the UNDERLYING download when a reader is cancelled after its head (${form})`, async () => {
			const opaque = await snapshotAt(TAKEN_AT, {rows: manyRows(20_000, 'f')});
			const source = cancellable(form === 'opaque' ? opaque : await inflated(opaque));

			const reader = await readSnapshot(source.stream);
			expect(source.cancelled()).toBe(false);
			await reader.cancel();

			// through the inflate stage the cancel reaches the source on the pipe's
			// next turn rather than before `cancel()` resolves, so this waits for it
			// (bounded); what it must never be is lost at the peek.
			await vi.waitFor(() => expect(source.cancelled()).toBe(true), {timeout: 1_000});
		});
	}
});

describe('a snapshot that carries history above its floor', () => {
	it('replays it, reports the FLOOR as its history floor, and answers as of every block in between', async () => {
		const later = [
			{block: block(TAKEN_AT + 3), mutations: [owns('1', '0xcarol', 4)]},
			{block: block(TAKEN_AT + 7), mutations: [{type: 'delete', entity: 'token', id: {id: '2'}} as Mutation]},
		];
		const store = await fresh();

		await store.bootstrap(await snapshotAt(TAKEN_AT, {later}), {processor: 'proc-v1'});

		expect(store.snapshotOrigin).toBe(TAKEN_AT);
		expect(store.capabilities.retention).toEqual({kind: 'window', blocks: 7});
		expect(await store.getAsOf('token', {id: '1'}, TAKEN_AT)).toMatchObject({owner: '0xalice'});
		expect(await store.getAsOf('token', {id: '1'}, TAKEN_AT + 3)).toMatchObject({owner: '0xcarol'});
		expect(await store.getAsOf('token', {id: '2'}, TAKEN_AT + 6)).toMatchObject({owner: '0xbob'});
		expect(await store.getCurrent('token', {id: '2'})).toBeUndefined();
		expect(await store.readCursor('lastSync')).toBe(`synced-through-${TAKEN_AT + 7}`);
		await expect(store.getAsOf('token', {id: '1'}, TAKEN_AT - 1)).rejects.toBeInstanceOf(BlockNotRetainedError);
		await expect(store.revertTo(TAKEN_AT - 1)).rejects.toBeInstanceOf(RevertBeyondSnapshotError);
	});

	it('replaces an install that was cut short part-way, on a handle reopened over it, rather than building on it', async () => {
		const later = [
			{block: block(TAKEN_AT + 3), mutations: [owns('1', '0xcarol', 4)]},
			{block: block(TAKEN_AT + 5), mutations: [owns('3', '0xdave', 1)]},
			{block: block(TAKEN_AT + 7), mutations: [{type: 'delete', entity: 'token', id: {id: '2'}} as Mutation]},
		];
		const whole = await snapshotAt(TAKEN_AT, {later});
		// the same document, stopping where its LAST block would begin
		const text = await new Response(
			new Blob([whole as Uint8Array<ArrayBuffer>])
				.stream()
				.pipeThrough(new DecompressionStream('gzip')) as ReadableStream<Uint8Array>,
		).text();
		const lines = text.split('\n').filter((line) => line.length > 0);
		const stopped = await handWritten(
			lines
				.slice(
					0,
					lines.findLastIndex((line) => line.startsWith('{"block":')),
				)
				.map((line) => JSON.parse(line)),
		);
		const inner = new MemoryStateStore([TOKEN, ACCOUNT]);
		await expect((await openSnapshotAware(inner)).bootstrap(stopped)).rejects.toThrow(/cut/);
		// the floor and the block above it landed (the one after that is only applied once
		// the next block's opening line proves it complete), and no cursor
		expect(await inner.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xcarol'});
		expect(await inner.readCursor('lastSync')).toBeUndefined();

		const store = await openSnapshotAware(inner);
		await store.bootstrap(whole, {processor: 'proc-v1'});

		expect(store.snapshotOrigin).toBe(TAKEN_AT);
		expect(await store.getAsOf('token', {id: '1'}, TAKEN_AT)).toMatchObject({owner: '0xalice'});
		expect(await store.getCurrent('token', {id: '2'})).toBeUndefined();
		expect(await store.readCursor('lastSync')).toBe(`synced-through-${TAKEN_AT + 7}`);
	});
});

describe('a snapshot installed over a store that computed its own state', () => {
	it('leaves NO cursor when the download is cut short, never the old one over the new rows', async () => {
		// a revert leaves cursors alone, so without clearing it the store would claim
		// to have synced to its old tip over rows that are the snapshot's floor, and
		// the next boot would index on from there instead of installing again.
		const inner = new MemoryStateStore([TOKEN, ACCOUNT]);
		await inner.applyBlock(block(TAKEN_AT - 100), [owns('9', '0xzed', 1)], {key: 'lastSync', value: 'self-at-900'});
		const stopped = await handWritten([
			{
				format: 2,
				processor: 'proc-v1',
				savedAt: '',
				takenAt: block(TAKEN_AT + 5),
				floor: TAKEN_AT,
				cursor: {key: 'lastSync', value: 'snap'},
			},
			{
				declare: 'token',
				id: ['id'],
				fields: [
					['owner', 'text'],
					['transferCount', 'integer'],
				],
			},
			{block: block(TAKEN_AT)},
			{entity: 'token'},
			['1', '0xalice', 3],
			// the document stops inside the block above the floor, short of the cut
			{block: block(TAKEN_AT + 3)},
			{entity: 'token'},
			['1', '0xcarol', 4],
		]);

		await expect((await openSnapshotAware(inner)).bootstrap(stopped)).rejects.toThrow(/cut/);

		// the floor landed over a wiped store, and no cursor says it is complete
		expect(await inner.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
		expect(await inner.readCursor('lastSync')).toBeUndefined();
		expect(await inner.getCurrent('token', {id: '9'})).toBeUndefined();
		expect((await openSnapshotAware(inner)).snapshotOrigin).toBe(TAKEN_AT);
	});
});

describe('the retention a bootstrapped store reports', () => {
	it('is floored at the snapshot block, never the `unbounded` a fresh store would claim', async () => {
		const fresh = new MemoryStateStore([TOKEN, ACCOUNT]);
		expect(fresh.capabilities.retention).toEqual({kind: 'unbounded'});

		const store = await bootstrapped(fresh);

		// a window of zero blocks behind a tip that IS the snapshot block: the store
		// has exactly one block of history and says so.
		expect(store.capabilities.retention).toEqual({kind: 'window', blocks: 0});
		expect(store.capabilities.asOf).toBe(true);
	});

	it('widens as the store indexes past the snapshot, because that history it DID compute', async () => {
		const store = await bootstrapped();
		await store.applyBlock(block(TAKEN_AT + 5), [owns('1', '0xcarol', 4)]);

		expect(store.capabilities.retention).toEqual({kind: 'window', blocks: 5});
		expect(await store.getAsOf('token', {id: '1'}, TAKEN_AT)).toMatchObject({owner: '0xalice'});
		expect(await store.getAsOf('token', {id: '1'}, TAKEN_AT + 5)).toMatchObject({owner: '0xcarol'});
	});

	it('never claims more than the store underneath it was configured to keep', async () => {
		const windowed = new MemoryStateStore([TOKEN, ACCOUNT], {retention: {blocks: 64}, finalityDepth: 64});
		const store = await bootstrapped(windowed);
		await store.applyBlock(block(TAKEN_AT + 100), [owns('1', '0xcarol', 4)]);

		// 100 blocks of snapshot-derived history, but the store was told to keep 64:
		// the report is the tighter of the two, because both bound the same answer.
		expect(store.capabilities.retention).toEqual({kind: 'window', blocks: 64});
	});

	it('leaves a store that answers no historical read exactly as it found it', async () => {
		const revertOnly = new MemoryStateStore([TOKEN, ACCOUNT], {retention: 'revert-only'});
		const store = await bootstrapped(revertOnly);

		expect(store.capabilities.retention).toEqual({kind: 'revert-only'});
		expect(store.capabilities.asOf).toBe(false);
		await expect(store.getAsOf('token', {id: '1'}, TAKEN_AT)).rejects.toBeInstanceOf(BlockNotRetainedError);
	});
});

describe('reads below the floor', () => {
	it('are refused with the typed refusal, naming what was asked and what is kept', async () => {
		const store = await bootstrapped();

		const refusal = await store.getAsOf('token', {id: '1'}, TAKEN_AT - 1).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(BlockNotRetainedError);
		expect((refusal as BlockNotRetainedError).requested).toBe(TAKEN_AT - 1);
		expect((refusal as BlockNotRetainedError).retained).toEqual({from: TAKEN_AT, to: TAKEN_AT});
	});

	it('are refused for a listing too, not only for a point read', async () => {
		const store = await bootstrapped();

		await expect(store.listAsOf('token', {id: '1'}, TAKEN_AT - 1, 10)).rejects.toBeInstanceOf(BlockNotRetainedError);
		expect((await store.listAsOf('token', {id: '1'}, TAKEN_AT, 10)).rows).toHaveLength(1);
	});

	it('are answered at the floor itself, which is the block the rows are the state AS OF', async () => {
		const store = await bootstrapped();
		expect(await store.getAsOf('token', {id: '2'}, TAKEN_AT)).toMatchObject({owner: '0xbob'});
	});
});

describe('the floor survives the handle', () => {
	it('is recovered by a second handle over the same storage, rather than reverting to `unbounded`', async () => {
		const inner = new MemoryStateStore([TOKEN, ACCOUNT]);
		await bootstrapped(inner);

		// what a reload does: the storage is still there, the handle is new, and the
		// snapshot origin is read back out of it rather than remembered in a closure.
		const reopened = await openSnapshotAware(inner);

		expect(reopened.snapshotOrigin).toBe(TAKEN_AT);
		expect(reopened.capabilities.retention).toEqual({kind: 'window', blocks: 0});
		await expect(reopened.getAsOf('token', {id: '1'}, TAKEN_AT - 1)).rejects.toBeInstanceOf(BlockNotRetainedError);
	});

	it('is absent on a store nobody bootstrapped, which then passes straight through', async () => {
		const inner = new MemoryStateStore([TOKEN, ACCOUNT]);
		const store = await openSnapshotAware(inner);
		await store.migrate();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);

		expect(store.snapshotOrigin).toBeUndefined();
		expect(store.capabilities).toEqual(inner.capabilities);
		expect(await store.getAsOf('token', {id: '1'}, 10)).toMatchObject({owner: '0xalice'});
	});
});

describe('a reorg that reaches below the snapshot', () => {
	it('is refused loudly, naming the block asked for and the floor', async () => {
		const store = await bootstrapped();
		await store.applyBlock(block(TAKEN_AT + 1), [owns('1', '0xcarol', 4)]);

		const refusal = await store.revertTo(TAKEN_AT - 1).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(RevertBeyondSnapshotError);
		expect((refusal as RevertBeyondSnapshotError).keepUpTo).toBe(TAKEN_AT - 1);
		expect((refusal as RevertBeyondSnapshotError).snapshotOrigin).toBe(TAKEN_AT);
	});

	it('changes nothing, so a host that catches it still holds the state it had', async () => {
		const store = await bootstrapped();
		await store.applyBlock(block(TAKEN_AT + 1), [owns('1', '0xcarol', 4)]);

		await expect(store.revertTo(TAKEN_AT - 1)).rejects.toBeInstanceOf(RevertBeyondSnapshotError);

		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xcarol'});
		expect(store.snapshotOrigin).toBe(TAKEN_AT);
	});

	it('is allowed down to the snapshot block itself, which is a block the store holds', async () => {
		const store = await bootstrapped();
		await store.applyBlock(block(TAKEN_AT + 1), [owns('1', '0xcarol', 4)]);

		await store.revertTo(TAKEN_AT);

		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
	});

	it('is not what a WIPE is: `revertTo(-1)` empties the store and drops the floor with it', async () => {
		// `EntityEventProcessor.reset()` is this call, and it must keep working: the
		// rows are gone, so there is no snapshot-derived history left to be honest
		// about, and the store goes back to claiming what it was configured to keep.
		const store = await bootstrapped();

		await store.revertTo(-1);

		expect(store.snapshotOrigin).toBeUndefined();
		expect(store.capabilities.retention).toEqual({kind: 'unbounded'});
		expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
		expect(await store.readCursor('snapshotOrigin')).toBeUndefined();
	});
});
