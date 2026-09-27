import {createClient} from '@libsql/client';
import {
	BlockNotRetainedError,
	openForWriting,
	openSnapshotAware,
	RevertBeyondSnapshotError,
	SnapshotFormatError,
	SnapshotProcessorMismatchError,
	type NormalizedEntity,
} from '@etherfold/state-store';
import {produceStateSnapshot, VersionedStateStore, type SnapshotHistory} from '@etherfold/state-store-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {beforeAll, describe, expect, it} from 'vitest';
import {
	EntityEventProcessor,
	localPosition,
	openAndBootstrap,
	serializeLastSync,
	SYNC_CURSOR_KEY,
	type EntityProcessor,
} from '../src/index.js';
import {BACKENDS} from './utils/backends.js';
import {finality, lastSync, SOURCE, transfer, type TestABI} from './utils/fixtures.js';

/**
 * A STATE SNAPSHOT ROUND-TRIPS FROM A BUILD DATABASE (ADR-0095).
 *
 * A real libSQL database, folded by a real entity processor into a generation's
 * own table namespace (ADR-0053), is read out as a format-2 document AS OF a
 * block by the SQLite backend's producer, and installed into a FRESH store of
 * every backend through the boot path an app writes. The installed store must
 * then answer every read exactly as the source database answers the same read
 * AS OF that block -- a token deleted before it included, which must be ABSENT
 * rather than carried as a row -- and report that block as its floor.
 *
 * This is the store seam end to end: nothing here hand-writes a row the fold did
 * not produce, and nothing enumerates the state through the seam (which cannot,
 * ADR-0021): the rows come from the backend's own as-of read.
 */

const BURN = '0x000000000000000000000000000000000000dEaD';
const MINT = '0x0000000000000000000000000000000000000000';
const IDENTITY = 'sha256:round-trip-processor';
const NAMESPACE = 'gen1';

/**
 * A fold that DELETES, which the shared fixture does not: a transfer to `BURN`
 * removes the token and its holding. `holding` has a composite key, so a listing
 * by PREFIX has something to answer, and `token.mark` is a `blob`, the one column
 * whose JSON form is not its value.
 */
const burning: EntityProcessor<TestABI> = {
	entities: [
		{name: 'token', id: ['id'], fields: {owner: 'text', transferCount: 'integer', mark: 'blob'}},
		{name: 'holding', id: ['owner', 'id'], fields: {since: 'integer'}},
		{name: 'counter', id: ['name'], fields: {value: 'integer'}},
	],
	async onTransfer(state, event) {
		const id = event.args.id.toString();
		const token = await state.get<{transferCount: number}>('token', {id});
		if (event.args.from !== MINT) state.delete('holding', {owner: event.args.from, id});
		if (event.args.to === BURN) {
			state.delete('token', {id});
		} else {
			state.set(
				'token',
				{id},
				{
					owner: event.args.to,
					transferCount: (token?.transferCount ?? 0) + 1,
					mark: new Uint8Array([Number(event.args.id), event.blockNumber & 0xff]),
				},
			);
			state.set('holding', {owner: event.args.to, id}, {since: event.blockNumber});
		}
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
};

/** The chain, in the order the fold sees it. Token 2 is burned BELOW the cut; 1 is burned above it. */
const EVENTS = [
	transfer(10, '0xa10', {from: MINT, to: '0xalice', id: 1n}),
	transfer(10, '0xa10', {from: MINT, to: '0xbob', id: 2n}),
	transfer(11, '0xa11', {from: MINT, to: '0xcarol', id: 3n}),
	transfer(11, '0xa11', {from: '0xalice', to: '0xbob', id: 1n}),
	transfer(13, '0xa13', {from: '0xbob', to: BURN, id: 2n}),
	transfer(20, '0xa20', {from: '0xcarol', to: '0xdave', id: 3n}),
	transfer(22, '0xa22', {from: '0xbob', to: BURN, id: 1n}),
];

/** Where the snapshot is CUT: a height that carries no logs of ours. */
const CUT = 15;
/** The highest recorded block at or below it, which is the snapshot's pointer and its floor. */
const POINTER = 13;
const TIP = 22;

/** Every id the chain ever touched, per entity: the ledger a read-for-read comparison walks. */
const LEDGER: Record<string, Record<string, string>[]> = {
	token: [{id: '1'}, {id: '2'}, {id: '3'}],
	holding: [
		{owner: '0xalice', id: '1'},
		{owner: '0xbob', id: '1'},
		{owner: '0xbob', id: '2'},
		{owner: '0xcarol', id: '3'},
		{owner: '0xdave', id: '3'},
	],
	counter: [{name: 'transfers'}],
};

/** A build database: one generation, folded to the tip by the real runtime. */
async function aBuildDatabase(): Promise<VersionedStateStore> {
	const db = new RemoteLibSQL(createClient({url: ':memory:'}));
	const writer = await openForWriting(new VersionedStateStore(db, burning.entities, {tableNamespace: NAMESPACE}));
	const runtime = new EntityEventProcessor(writer, burning);
	await runtime.load(SOURCE, {finality});
	await runtime.process(EVENTS, lastSync({lastToBlock: TIP, latestBlock: TIP}));
	// the READ side of the same generation, as a publisher opens it: a store over the
	// database and the namespace, which reads and never claims.
	return new VersionedStateStore(db, burning.entities, {tableNamespace: NAMESPACE});
}

let source: VersionedStateStore;
let document: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
	source = await aBuildDatabase();
	const produced = await produceStateSnapshot(source, {
		at: CUT,
		processor: IDENTITY,
		cursor: {
			key: SYNC_CURSOR_KEY,
			value: serializeLastSync(lastSync({lastFromBlock: CUT - 5, lastToBlock: CUT, latestBlock: TIP})),
		},
	});
	document = new Uint8Array(await new Response(produced.document).arrayBuffer());
});

/** A mirror serving the document as a static host would. */
function mirror() {
	const url = 'https://mirror.example/state.ndjson.gz';
	const fetch = (async () => new Response(document)) as unknown as typeof globalThis.fetch;
	return {url, fetch};
}

/** A stored row reduced to its declared columns, blobs as hex: the part two backends can agree on. */
function declared(entity: NormalizedEntity, row: unknown): Record<string, unknown> | undefined {
	if (!row) return undefined;
	const stored = row as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const column of entity.id) out[column] = String(stored[column]);
	for (const [field, type] of Object.entries(entity.fields)) {
		const value = stored[field] ?? null;
		out[field] = type === 'blob' && value !== null ? hex(value) : value;
	}
	return out;
}

function hex(value: unknown): string {
	const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : (value as Uint8Array);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function declarationOf(name: string): NormalizedEntity {
	return source.declarations.get(name) as NormalizedEntity;
}

describe('the build database the snapshot is taken from', () => {
	it('deleted token 2 BELOW the cut, so a round trip that carried it as a row would be wrong', async () => {
		expect(await source.getAsOf('token', {id: '2'}, 12)).toMatchObject({owner: '0xbob'});
		expect(await source.getAsOf('token', {id: '2'}, CUT)).toBeUndefined();
		// and moved on ABOVE it, so a snapshot of the tip would be wrong too
		expect(await source.getCurrent('token', {id: '3'})).toMatchObject({owner: '0xdave'});
	});

	it('is read at a block that carries no logs through the highest recorded block below it', async () => {
		const {head} = await produceStateSnapshot(source, {at: CUT, processor: IDENTITY});
		expect(head.takenAt.number).toBe(POINTER);
		expect(head.floor).toBe(POINTER);
	});
});

describe.each(BACKENDS)('installed into a fresh $name store', (backend) => {
	async function installed() {
		const {fetch, url} = mirror();
		const {store, outcome} = await openAndBootstrap(await backend.open(burning.entities), url, {
			processor: IDENTITY,
			fetch,
		});
		expect(outcome).toEqual({status: 'bootstrapped', at: POINTER, from: url});
		return store;
	}

	it('answers every read exactly as the source answers it AS OF the snapshot block', async () => {
		const store = await installed();

		for (const entity of source.declarations.values()) {
			for (const id of LEDGER[entity.name]) {
				const expected = declared(entity, await source.getAsOf(entity.name, id, CUT));
				expect(declared(entity, await store.getCurrent(entity.name, id))).toEqual(expected);
				if (store.capabilities.asOf) {
					expect(declared(entity, await store.getAsOf(entity.name, id, POINTER))).toEqual(expected);
				}
			}
		}
		// the burned token is ABSENT, not a row
		expect(await store.getCurrent('token', {id: '2'})).toBeUndefined();

		// a LISTING by prefix answers as the source's listing as of the block
		const holding = declarationOf('holding');
		for (const owner of ['0xalice', '0xbob', '0xcarol', '0xdave']) {
			const expected = (await source.listAsOf('holding', {owner}, CUT, 10)).rows.map((row) => declared(holding, row));
			const got = (await store.listCurrent('holding', {owner}, 10)).rows.map((row) => declared(holding, row));
			expect(got).toEqual(expected);
		}
	});

	it('resumes from the cursor the snapshot carried, at the cut', async () => {
		const store = await installed();
		expect(await localPosition(store)).toBe(CUT);
	});

	it('reports the snapshot block as its floor and refuses a revert under it (ADR-0028)', async () => {
		const store = await installed();

		expect(store.snapshotOrigin).toBe(POINTER);
		await expect(store.revertTo(POINTER - 1)).rejects.toBeInstanceOf(RevertBeyondSnapshotError);
		if (store.capabilities.asOf) {
			await expect(store.getAsOf('token', {id: '1'}, POINTER - 1)).rejects.toBeInstanceOf(BlockNotRetainedError);
		}
	});

	it('refuses the snapshot, by name, for another processor', async () => {
		const {fetch, url} = mirror();
		const {outcome} = await openAndBootstrap(await backend.open(burning.entities), url, {
			processor: 'sha256:another-fold',
			fetch,
		});
		expect(outcome).toEqual({status: 'not-bootstrapped', reason: 'processor-mismatch'});

		const store = await openSnapshotAware(await backend.open(burning.entities));
		const refusal = await store
			.bootstrap(document, {processor: 'sha256:another-fold'})
			.catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(SnapshotProcessorMismatchError);
		expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
	});
});

/**
 * THE HISTORY OPTION (ADR-0095): the same database, published with its floor
 * below the cut, installs into every backend by replaying the blocks between.
 */
describe('a snapshot that carries the history it was asked for', () => {
	/** A cut above every recorded block but the tip's: its pointer is block 20. */
	const HISTORY_CUT = 21;
	const HISTORIES: readonly {history: SnapshotHistory; floor: number}[] = [
		{history: 'none', floor: 20},
		// 21 - 9 = 12 carries no logs: the floor points at 11, the highest recorded block below it
		{history: 9, floor: 11},
		{history: 'all', floor: 10},
	];

	async function publishedWith(history: SnapshotHistory): Promise<Uint8Array<ArrayBuffer>> {
		const produced = await produceStateSnapshot(source, {
			at: HISTORY_CUT,
			processor: IDENTITY,
			history,
			cursor: {
				key: SYNC_CURSOR_KEY,
				value: serializeLastSync(
					lastSync({lastFromBlock: HISTORY_CUT - 5, lastToBlock: HISTORY_CUT, latestBlock: TIP}),
				),
			},
		});
		return new Uint8Array(await new Response(produced.document).arrayBuffer());
	}

	/** Every read of every ledger id at the tip: what a store that keeps only the tip can be compared on. */
	async function tipOf(store: {getCurrent(entity: string, id: Record<string, string>): Promise<unknown>}) {
		const out: Record<string, unknown> = {};
		for (const entity of source.declarations.values()) {
			for (const id of LEDGER[entity.name]) {
				out[`${entity.name} ${JSON.stringify(id)}`] = declared(entity, await store.getCurrent(entity.name, id));
			}
		}
		return out;
	}

	async function sourceAsOf(at: number) {
		return tipOf({getCurrent: (entity, id) => source.getAsOf(entity, id, at)});
	}

	describe.each(BACKENDS)('installed into a fresh $name store', (backend) => {
		for (const {history, floor} of HISTORIES) {
			it(`(history ${history}) answers as of every block from the floor to the cut as the source does`, async () => {
				const store = await openSnapshotAware(await backend.open(burning.entities));
				await store.bootstrap(await publishedWith(history), {processor: IDENTITY});

				expect(store.snapshotOrigin).toBe(floor);
				expect(await localPosition(store)).toBe(HISTORY_CUT);
				// the live state is the source's as of the cut, on every backend, the tip-only one included
				expect(await tipOf(store)).toEqual(await sourceAsOf(HISTORY_CUT));
				if (!store.capabilities.asOf) return;
				for (let at = floor; at <= HISTORY_CUT; at++) {
					expect(await tipOf({getCurrent: (entity, id) => store.getAsOf(entity, id, at)}), `as of ${at}`).toEqual(
						await sourceAsOf(at),
					);
				}
				await expect(store.getAsOf('token', {id: '1'}, floor - 1)).rejects.toBeInstanceOf(BlockNotRetainedError);
			});
		}

		it('reverts to a block inside its history, re-applies the same blocks to the same state, and refuses under it', async () => {
			const store = await openSnapshotAware(await backend.open(burning.entities));
			await store.bootstrap(await publishedWith('all'), {processor: IDENTITY});
			const before = await tipOf(store);

			await store.revertTo(11);
			expect(await tipOf(store)).toEqual(await sourceAsOf(11));
			for (const at of [13, 20]) {
				const mutations = [];
				for await (const mutation of source.changesAt(at)) mutations.push(mutation);
				await store.applyBlock((await source.getBlock(at))!, mutations);
			}

			expect(await tipOf(store)).toEqual(before);
			await expect(store.revertTo(9)).rejects.toBeInstanceOf(RevertBeyondSnapshotError);
		});

		it('installs completely on the next boot after a download that failed part-way through the history', async () => {
			const bytes = await publishedWith('all');
			const url = 'https://mirror.example/history.ndjson.gz';
			// the download stops where the LAST block (the one the cursor rides) would have
			// begun: every block before it has been inflated and applied by then. Cut on a
			// line boundary so the failure is the same one whatever the platform's inflate
			// buffers, which a byte-level cut would not be.
			const lines = (await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text())
				.split('\n')
				.filter((line) => line.length > 0);
			const lastBlock = lines.findLastIndex((line) => line.startsWith('{"block":'));
			const stopped = new Uint8Array(
				await new Response(
					new Blob([lines.slice(0, lastBlock).join('\n') + '\n']).stream().pipeThrough(new CompressionStream('gzip')),
				).arrayBuffer(),
			);
			const cutShort = (async () => new Response(stopped)) as unknown as typeof globalThis.fetch;
			const first = await backend.open(burning.entities);
			await expect(openAndBootstrap(first, url, {processor: IDENTITY, fetch: cutShort})).rejects.toThrow();
			// the interrupted install left its floor and blocks above it, but no cursor
			expect(await first.getCurrent('counter', {name: 'transfers'})).toBeDefined();
			expect(await localPosition(first)).toBeUndefined();

			const fetch = (async () => new Response(bytes)) as unknown as typeof globalThis.fetch;
			const {store, outcome} = await openAndBootstrap(await backend.reopen(first, burning.entities), url, {
				processor: IDENTITY,
				fetch,
			});

			expect(outcome).toEqual({status: 'bootstrapped', at: 20, from: url});
			expect(store.snapshotOrigin).toBe(10);
			expect(await tipOf(store)).toEqual(await sourceAsOf(HISTORY_CUT));
			expect(await localPosition(store)).toBe(HISTORY_CUT);
		});
	});
});

describe('the SQLite store it is installed into', () => {
	it('holds, table for table, exactly the rows the source holds as of the block', async () => {
		const target = new VersionedStateStore(new RemoteLibSQL(createClient({url: ':memory:'})), burning.entities);
		const aware = await openSnapshotAware(await openForWriting(target));
		await aware.bootstrap(document, {processor: IDENTITY});

		for (const entity of source.declarations.values()) {
			const asText = (row: unknown) => JSON.stringify(declared(entity, row));
			const expected = (await source.queryAsOf(entity.name, CUT)).map(asText).sort();
			const got = (await target.queryCurrent(entity.name)).map(asText).sort();
			expect(got).toEqual(expected);
			expect(got.length).toBeGreaterThan(0);
		}
	});
});

describe('a document this build cannot read', () => {
	const formatOne = {
		format: 1,
		processor: IDENTITY,
		savedAt: '2026-09-26T00:00:00.000Z',
		takenAt: {number: POINTER, hash: '0xa13', timestamp: 0},
		rows: [{type: 'upsert', entity: 'counter', id: {name: 'transfers'}, values: {value: 5}}],
	};

	it('is refused as `unreadable-format` when it is format 1, and never installed', async () => {
		const fetch = (async () => new Response(JSON.stringify(formatOne))) as unknown as typeof globalThis.fetch;

		const {store, outcome} = await openAndBootstrap(await BACKENDS[0].open(burning.entities), 'https://m.example/s', {
			processor: IDENTITY,
			fetch,
		});

		expect(outcome).toEqual({status: 'not-bootstrapped', reason: 'unreadable-format'});
		expect(await store.getCurrent('counter', {name: 'transfers'})).toBeUndefined();
		await expect(store.bootstrap(new TextEncoder().encode(JSON.stringify(formatOne)))).rejects.toBeInstanceOf(
			SnapshotFormatError,
		);
	});

	it('is refused as `unreadable-format` when a separately published head is format 1', async () => {
		const {rows: _rows, ...head} = formatOne;
		const fetch = (async () => new Response(JSON.stringify(head))) as unknown as typeof globalThis.fetch;

		const {outcome} = await openAndBootstrap(
			await BACKENDS[0].open(burning.entities),
			{url: 'https://m.example/body', head: 'https://m.example/head.json'},
			{processor: IDENTITY, fetch},
		);

		expect(outcome).toEqual({status: 'not-bootstrapped', reason: 'unreadable-format'});
	});
});
