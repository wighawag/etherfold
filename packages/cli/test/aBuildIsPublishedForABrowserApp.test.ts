import {createClient} from '@libsql/client';
import {
	createSegmentedStream,
	IndexerGeneration,
	installStreamSeed,
	parseStreamSeed,
	pinnedStreamSeedContentHash,
	resolveStreamConfig,
	streamDigestOf,
	streamDigestOfSourceHashes,
	type Abi,
	type StoredSegment,
	type StreamCursorRecord,
	type StreamSegmentPort,
} from '@etherfold/core';
import {
	EntityEventProcessor,
	openForWriting,
	openSnapshotAware,
	readSnapshot,
	type EntityProcessor,
} from '@etherfold/processor-entities';
import {PUBLICATION_INDEX_NAME, readStreamCoverage, type PublicationIndex} from '@etherfold/server';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {loadProcessorArtifact, resolveSource} from '@etherfold/utils';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {
	canonicalGenerationIn,
	nodePublicationFiles,
	prepareIndexing,
	publish,
	publishMain,
	type IndexingDependencies,
	type PublicationFiles,
} from '../src/index.js';
import {createProgram} from '../src/program.js';
import type {Options} from '../src/types.js';
import {ALICE, BOB, CAROL, fakeChain, START_BLOCK, transfer, ZERO, type RawLog} from './utils/chain.js';
import {canonicalStoreIn} from './utils/reads.js';

// ---------------------------------------------------------------------------------------------------
// `etherfold publish`: A BUILD DATABASE, WRITTEN OUT AS WHAT A BROWSER APP STARTS FROM (ADR-0095)
// ---------------------------------------------------------------------------------------------------
// A real committed bundle folds a fixture chain into a real libSQL database through
// `build`, and `publish` writes that database's canonical generation into a temp
// directory. What is asserted is what an APP depends on:
//
//  - the body installs into a fresh store and answers every read as the database
//    does AS OF `tip - finality`;
//  - a consumer that installs it and indexes forward over the same chain neither
//    skips a block nor applies one twice -- asserted on a COUNTER every log
//    increments, both where the cut falls on a block carrying logs and where it
//    does not;
//  - the layout never forgets: a republication replaces only its own generation's
//    entry, a different generation adds one, and no file is ever deleted;
//  - the index is renamed into place LAST, and nothing is written outside `--out`;
//  - every refusal writes nothing, exits non-zero and says why;
//  - with `--seed`, the stream seed installs through core's `installStreamSeed`
//    (the install a browser tab runs) under the hash it PRINTED, and re-folding it
//    with the same processor reaches the snapshot's state; without it, no seed is
//    written and another stream's seed entry is kept.
// ---------------------------------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL('./fixtures/processor-bundle/', import.meta.url));
const BUNDLE = join(FIXTURES, 'nfts.bundle.js');
/** The same file with one handler line changed: a different processor, a different generation. */
const EDITED_BUNDLE = join(FIXTURES, 'nfts-edited.bundle.js');

const FINALITY = 12;
const TIP = START_BLOCK + 100;
/** The cut `publish` takes over a database folded to `TIP`. */
const CUT = TIP - FINALITY;
const TOKEN = (id: number) => id.toString().padStart(78, '0');

const ENV = {MAX_BLOCKS_PER_FETCH: '20', STREAM_FINALITY: String(FINALITY)};

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

/** A temp directory holding nothing, the parent of `--out`, so "written elsewhere" is checkable. */
function aWorkspace(): {root: string; out: string} {
	const root = mkdtempSync(join(tmpdir(), 'etherfold-publish-'));
	directories.push(root);
	return {root, out: join(root, 'published')};
}

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/** Transfers around the cut: below it, possibly ON it, and inside the reorg window above it. */
function logsAround(cutCarriesLogs: boolean): RawLog[] {
	return [
		transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
		transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
		transfer(START_BLOCK + 40, '0xa40', ZERO, CAROL, 2n),
		...(cutCarriesLogs
			? [transfer(CUT, '0xacut', BOB, CAROL, 1n), transfer(CUT, '0xacut', CAROL, ALICE, 2n, 1)]
			: [transfer(CUT - 3, '0xabelow', BOB, CAROL, 1n)]),
		transfer(CUT + 2, '0xaabove', CAROL, BOB, 1n),
		transfer(TIP - 1, '0xatip', ZERO, BOB, 3n),
	];
}

/** FOLD a chain into `db` with `etherfold build`, as a deployment configured with `bundle` does. */
async function aBuild(
	db: RemoteSQL,
	chain: ReturnType<typeof fakeChain>,
	bundle = BUNDLE,
	extra: Options = {},
): Promise<void> {
	const deps: IndexingDependencies = {provider: chain.provider, createDB: () => db, sleep: async () => {}, env: ENV};
	const options: Options = {
		processor: bundle,
		nodeUrl: 'http://localhost:0',
		store: 'sqlite',
		db: ':memory:',
		...extra,
	};
	const prepared = await prepareIndexing('build', options, deps);
	expect((await prepared.index()).stoppedBecause).toBe('stopped');
}

/** A filesystem that RECORDS every operation, in order, and otherwise is the real disk. */
function recording(): {files: PublicationFiles; operations: [string, ...string[]][]} {
	const operations: [string, ...string[]][] = [];
	return {
		operations,
		files: {
			readText: (path) => (operations.push(['readText', path]), nodePublicationFiles.readText(path)),
			exists: (path) => (operations.push(['exists', path]), nodePublicationFiles.exists(path)),
			mkdir: (path) => (operations.push(['mkdir', path]), nodePublicationFiles.mkdir(path)),
			write: (path, bytes) => (operations.push(['write', path]), nodePublicationFiles.write(path, bytes)),
			rename: (from, to) => (operations.push(['rename', from, to]), nodePublicationFiles.rename(from, to)),
		},
	};
}

const publishing = (db: RemoteSQL, out: string, files?: PublicationFiles, extra: Options = {}) =>
	publish({db: ':memory:', out, ...extra}, {createDB: () => db, env: ENV, ...(files ? {files} : {})});

function theIndexIn(out: string): PublicationIndex {
	return JSON.parse(readFileSync(join(out, PUBLICATION_INDEX_NAME), 'utf-8')) as PublicationIndex;
}

/** What a client runs: the bundle's own processor, its identity, and the source it carries. */
async function theApp(bundle = BUNDLE) {
	const outcome = await loadProcessorArtifact<Abi, unknown, EntityProcessor<Abi>>(new Uint8Array(readFileSync(bundle)));
	if (outcome.status !== 'instantiated') throw new Error(`the fixture bundle was refused: ${outcome.why}`);
	return outcome;
}

/** A fresh tab's store, with the published body installed into it. */
async function aClientFrom(out: string, body: string, app: Awaited<ReturnType<typeof theApp>>) {
	const store = await openSnapshotAware(
		await openForWriting(new VersionedStateStore(oneDatabase(), app.processor.entities)),
	);
	await store.bootstrap(new Uint8Array(readFileSync(join(out, body))), {processor: app.identity});
	return store;
}

/** A row's DOMAIN values: the version bookkeeping columns are each store's own. */
function valuesOf(row: Record<string, unknown> | undefined) {
	return row && Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('_')));
}

async function everyRead(read: (entity: string, id: Record<string, string>) => Promise<any>) {
	return {
		token1: valuesOf(await read('nft', {tokenID: TOKEN(1)})),
		token2: valuesOf(await read('nft', {tokenID: TOKEN(2)})),
		token3: valuesOf(await read('nft', {tokenID: TOKEN(3)})),
		counter: valuesOf(await read('counter', {name: 'transfers'})),
	};
}

describe('`etherfold publish` over a build database', () => {
	it('writes an index and a body that installs AS OF tip - finality', async () => {
		const db = oneDatabase();
		await aBuild(db, fakeChain().serve(logsAround(false), TIP));
		const {out} = aWorkspace();

		const written = await publishing(db, out);

		const index = theIndexIn(out);
		const [entry, ...others] = Object.values(index.snapshots);
		expect(others).toEqual([]);
		expect(index.format).toBe(1);
		const canonical = (await canonicalGenerationIn(db))!;
		expect(entry).toMatchObject({stream: canonical.stream, processor: canonical.processor, cut: CUT});
		expect(existsSync(join(out, entry!.body))).toBe(true);
		expect(written.produced.cut).toBe(CUT);

		const app = await theApp();
		const client = await aClientFrom(out, entry!.body, app);
		const source = await canonicalStoreIn(db, app.processor.entities);
		expect(await everyRead((entity, id) => client.getCurrent(entity, id))).toEqual(
			await everyRead((entity, id) => source.getAsOf(entity, id, CUT)),
		);
		// the rows at the cut are not the rows at the tip: the window above it is left to the chain
		expect((await everyRead((entity, id) => client.getCurrent(entity, id))).counter).toEqual({
			name: 'transfers',
			value: 4,
		});
		// the cut carried no logs, so the rows point at the highest recorded block below it
		expect(entry!.takenAt.number).toBe(CUT - 3);
		expect((await readSnapshot(readFileSync(join(out, entry!.body)))).head.takenAt.number).toBe(CUT - 3);
	});

	for (const cutCarriesLogs of [true, false]) {
		it(`leaves a consumer that indexes forward with no block skipped and none applied twice (the cut ${
			cutCarriesLogs ? 'carries logs' : 'carries none'
		})`, async () => {
			const logs = logsAround(cutCarriesLogs);
			const db = oneDatabase();
			await aBuild(db, fakeChain().serve(logs, TIP));
			const {out} = aWorkspace();
			const written = await publishing(db, out);
			const body = written.bodies[0]!.name;

			// the chain has moved on by the time a tab opens
			const later = [...logs, transfer(TIP + 30, '0xalater', BOB, ALICE, 3n)];
			const chain = fakeChain().serve(later, TIP + 50);
			const app = await theApp();
			const client = await aClientFrom(out, body, app);
			const source = await resolveSource(app.processorModule, chain.provider);
			const tab = new IndexerGeneration<Abi, unknown>(
				chain.provider,
				new EntityEventProcessor(await openForWriting(client), app.processor, {finalityDepth: FINALITY}) as never,
				source,
				{stream: {finality: FINALITY}},
				{processorIdentity: app.identity},
			);
			let lastSync = await tab.load();
			// it RESUMED from the snapshot rather than discarding it and starting over
			expect(lastSync.lastToBlock).toBe(CUT);
			for (let guard = 0; lastSync.lastToBlock < TIP + 50 && guard < 20; guard++) {
				lastSync = await tab.indexMore();
			}
			expect(lastSync.lastToBlock).toBe(TIP + 50);

			// it read nothing below the cut: the window reaches back to the cut and no further
			expect(Math.min(...chain.logRanges.map((range) => range.from))).toBe(CUT);
			// every log applied exactly once: the counter is the number of logs on the chain
			const reads = await everyRead((entity, id) => client.getCurrent(entity, id));
			expect(reads.counter).toEqual({name: 'transfers', value: later.length});

			// ...and it is the state a full fold of the same chain reaches
			const whole = oneDatabase();
			await aBuild(whole, fakeChain().serve(later, TIP + 50));
			const reference = await canonicalStoreIn(whole, app.processor.entities);
			expect(reads).toEqual(await everyRead((entity, id) => reference.getCurrent(entity, id)));
		});
	}

	it('writes the index LAST, by a rename, and nothing outside --out', async () => {
		const db = oneDatabase();
		await aBuild(db, fakeChain().serve(logsAround(true), TIP));
		const {root, out} = aWorkspace();
		const {files, operations} = recording();

		const written = await publishing(db, out, files);

		const last = operations.at(-1)!;
		expect(last[0]).toBe('rename');
		expect(last[2]).toBe(join(out, PUBLICATION_INDEX_NAME));
		// the body landed (written beside its name, renamed into it) BEFORE the index was touched
		const bodyPath = join(out, written.bodies[0]!.name);
		const bodyLanded = operations.findIndex((op) => op[0] === 'rename' && op[2] === bodyPath);
		const indexWritten = operations.findIndex((op) => op[0] === 'write' && op[1]!.startsWith(`${last[2]}.`));
		expect(bodyLanded).toBeGreaterThanOrEqual(0);
		expect(bodyLanded).toBeLessThan(indexWritten);
		// every write, rename and mkdir is inside --out, and nothing else appeared beside it
		for (const [op, ...paths] of operations) {
			if (op === 'readText' || op === 'exists') continue;
			for (const path of paths) expect(path === out || path.startsWith(`${out}/`), `${op} ${path}`).toBe(true);
		}
		expect(readdirSync(root)).toEqual(['published']);
		expect(readdirSync(out).sort()).toEqual([written.bodies[0]!.name, PUBLICATION_INDEX_NAME].sort());
	});

	it('republishing the same generation replaces its entry and leaves the first body in place', async () => {
		const db = oneDatabase();
		const chain = fakeChain().serve(logsAround(false), TIP);
		await aBuild(db, chain);
		const {out} = aWorkspace();
		const first = await publishing(db, out);

		// the chain moves on and the same processor folds further
		chain.serve([...logsAround(false), transfer(TIP + 20, '0xamore', BOB, ALICE, 1n)], TIP + 40);
		await aBuild(db, chain);
		const second = await publishing(db, out);

		const [key] = Object.keys(first.produced.entries.snapshots);
		expect(Object.keys(theIndexIn(out).snapshots)).toEqual([key]);
		expect(theIndexIn(out).snapshots[key!]!.body).toBe(second.bodies[0]!.name);
		expect(second.bodies[0]!.name).not.toBe(first.bodies[0]!.name);
		expect(existsSync(join(out, first.bodies[0]!.name))).toBe(true);
	});

	it('publishing the same bytes again leaves the body as it was', async () => {
		const db = oneDatabase();
		await aBuild(db, fakeChain().serve(logsAround(false), TIP));
		const {out} = aWorkspace();
		const at = '2026-09-27T00:00:00.000Z';
		const deps = {createDB: () => db, env: ENV, savedAt: at};

		const first = await publish({db: ':memory:', out}, deps);
		const again = await publish({db: ':memory:', out}, deps);

		expect(again.bodies).toEqual([{...first.bodies[0], written: false}]);
	});

	it('never deletes anything an earlier publication wrote, over three publications and two generations', async () => {
		const db = oneDatabase();
		const chain = fakeChain().serve(logsAround(false), TIP);
		const {out} = aWorkspace();

		await aBuild(db, chain);
		const one = await publishing(db, out);
		chain.serve([...logsAround(false), transfer(TIP + 20, '0xamore', BOB, ALICE, 1n)], TIP + 40);
		await aBuild(db, chain);
		const two = await publishing(db, out);
		// a DIFFERENT generation: the promoted successor a re-run build with changed bytes settles on
		await aBuild(db, chain, EDITED_BUNDLE);
		const three = await publishing(db, out, undefined, {processor: EDITED_BUNDLE});

		const index = theIndexIn(out);
		const oneKey = Object.keys(one.produced.entries.snapshots)[0]!;
		const threeKey = Object.keys(three.produced.entries.snapshots)[0]!;
		expect(threeKey).not.toBe(oneKey);
		expect(Object.keys(index.snapshots).sort()).toEqual([oneKey, threeKey].sort());
		// the old generation's entry is its LAST publication, for an old build of the app to find
		expect(index.snapshots[oneKey]!.body).toBe(two.bodies[0]!.name);
		expect(index.snapshots[threeKey]!.processor).toBe((await theApp(EDITED_BUNDLE)).identity);
		for (const written of [one, two, three]) {
			expect(existsSync(join(out, written.bodies[0]!.name))).toBe(true);
		}
		expect(readdirSync(out).sort()).toEqual(
			[...[one, two, three].map((written) => written.bodies[0]!.name), PUBLICATION_INDEX_NAME].sort(),
		);
	});

	// A bundle's identity is its BYTES (ADR-0086), dependencies included, so an
	// etherfold upgrade alone can move it, and every publication then stops being
	// found by the rebuilt app. The report is where an author sees that it happened.
	it('says when the processor is not among those the publication held, naming them, and only then', async () => {
		const db = oneDatabase();
		const chain = fakeChain().serve(logsAround(false), TIP);
		const {out} = aWorkspace();
		const isTheMoveLine = (line: string) => line.startsWith('new processor: ');

		await aBuild(db, chain);
		const first = await publishedAndPrinted(db, out);
		const again = await publishedAndPrinted(db, out);
		await aBuild(db, chain, EDITED_BUNDLE);
		const moved = await publishedAndPrinted(db, out, {processor: EDITED_BUNDLE});

		// an empty directory is not a move, and neither is republishing the same processor
		expect(first.some(isTheMoveLine)).toBe(false);
		expect(again.some(isTheMoveLine)).toBe(false);
		const previous = (await theApp()).identity;
		const edited = (await theApp(EDITED_BUNDLE)).identity;
		const line = moved.find(isTheMoveLine);
		expect(line).toContain(edited);
		expect(line).toContain('etherfold upgrade');
		expect(moved).toContain(`  held: ${previous}`);
	});

	it("does not call a processor new because the directory holds another stream's snapshots", async () => {
		const {out} = aWorkspace();
		const db = oneDatabase();
		await aBuild(db, fakeChain().serve(logsAround(false), TIP));
		const first = await publishing(db, out);
		const [key, entry] = Object.entries(first.produced.entries.snapshots)[0]!;
		// the SAME processor's snapshot becomes another stream's, published by another indexer
		const index = theIndexIn(out);
		const foreign = {
			...index,
			snapshots: {[`${key}-elsewhere`]: {...entry, stream: 'another-stream', processor: 'another-processor'}},
		};
		rmSync(join(out, PUBLICATION_INDEX_NAME));
		writeFileSync(join(out, PUBLICATION_INDEX_NAME), JSON.stringify(foreign));

		const lines = await publishedAndPrinted(db, out);
		expect(lines.some((line) => line.startsWith('new processor: '))).toBe(false);
	});
});

describe('`etherfold publish --history`', () => {
	/** The first block the build recorded: the transfer at `START_BLOCK + 10`. */
	const FIRST = START_BLOCK + 10;

	for (const {history, floor} of [
		{history: undefined, floor: CUT - 3},
		// CUT - 30 carries no logs: the floor is the highest recorded block below it
		{history: '30', floor: START_BLOCK + 40},
		{history: 'all', floor: FIRST},
	]) {
		it(`(${history ?? 'not given, so none'}) writes a body whose floor is ${floor - START_BLOCK} past the start, answering as of every block above it as the database does`, async () => {
			const db = oneDatabase();
			await aBuild(db, fakeChain().serve(logsAround(false), TIP));
			const {out} = aWorkspace();

			const written = await publishing(db, out, undefined, history === undefined ? {} : {history});

			const entry = Object.values(theIndexIn(out).snapshots)[0]!;
			expect(entry.floor).toBe(floor);
			expect(written.produced.head.floor).toBe(floor);
			const app = await theApp();
			const client = await aClientFrom(out, entry.body, app);
			const source = await canonicalStoreIn(db, app.processor.entities);
			expect(client.snapshotOrigin).toBe(floor);
			for (const at of [floor, floor + 1, START_BLOCK + 20, START_BLOCK + 40, CUT - 3, CUT].filter((b) => b >= floor)) {
				expect(await everyRead((entity, id) => client.getAsOf(entity, id, at)), `as of ${at}`).toEqual(
					await everyRead((entity, id) => source.getAsOf(entity, id, at)),
				);
			}
			await expect(client.getAsOf('counter', {name: 'transfers'}, floor - 1)).rejects.toThrow();
		});
	}

	it('says in its report what history it published', async () => {
		const db = oneDatabase();
		await aBuild(db, fakeChain().serve(logsAround(false), TIP));
		const {out} = aWorkspace();
		const lines: unknown[] = [];

		await publishMain(
			{db: ':memory:', out, history: 'all'},
			{createDB: () => db, env: ENV, exit: () => {}, log: (...args) => lines.push(...args)},
		);

		expect(lines).toContain(`history: all (floor ${FIRST})`);
	});

	it('refuses a depth reaching below what the database retains, naming both blocks, and writes nothing', async () => {
		const db = oneDatabase();
		// `--retention 20`: the build prunes versions closed at or below (its tip - 20)
		await aBuild(db, fakeChain().serve(logsAround(false), TIP), BUNDLE, {retention: '20'});
		const {out} = aWorkspace();
		const errors: unknown[] = [];
		let code: number | undefined;

		await publishMain(
			{db: ':memory:', out, history: '30'},
			{createDB: () => db, env: ENV, exit: (value) => (code = value), error: (...args) => errors.push(...args)},
		);

		expect(code).toBe(1);
		const message = errors.join(' ');
		// the depth reaches CUT - 30, and the build pruned at its last recorded block (TIP - 1) - 20
		expect(message).toContain(`block ${CUT - 30}`);
		expect(message).toContain(`block ${TIP - 1 - 20}`);
		expect(existsSync(out)).toBe(false);

		// within what it retains, the same database publishes: CUT - 5 is above the prune
		// floor, and nothing changed between it and the recorded block the floor points at
		const written = await publishing(db, out, undefined, {history: '5'});
		expect(written.produced.head.floor).toBe(START_BLOCK + 40);
	});

	it('refuses a history that is not `all`, `none` or a whole number of blocks, by name', async () => {
		const {out} = aWorkspace();

		for (const history of ['-5', 'some', '1.5', '10 blocks']) {
			await expect(publish({db: ':memory:', out, history}, {env: {}})).rejects.toThrow(/--history .* is not a history/);
		}
	});

	it('is refused by every command that publishes nothing, and by `build` without --publish', async () => {
		await expect(
			prepareIndexing(
				'run',
				{processor: BUNDLE, nodeUrl: 'http://x', store: 'sqlite', db: ':memory:', history: 'all'},
				{env: {}},
			),
		).rejects.toThrow(/--history is not accepted by `etherfold run`/);
		await expect(
			prepareIndexing(
				'build',
				{processor: BUNDLE, nodeUrl: 'http://x', store: 'sqlite', db: ':memory:', history: 'all'},
				{env: {}},
			),
		).rejects.toThrow(/--history is only accepted by `etherfold build` together with --publish <dir>/);
	});
});

describe('`etherfold publish` refuses, writing nothing', () => {
	async function refused(db: RemoteSQL, out: string, extra: Options = {}): Promise<string> {
		const errors: unknown[] = [];
		let code: number | undefined;
		await publishMain(
			{db: ':memory:', out, ...extra},
			{
				createDB: () => db,
				env: ENV,
				exit: (value) => (code = value),
				log: () => {},
				error: (...args) => errors.push(...args),
			},
		);
		expect(code).toBe(1);
		expect(existsSync(out)).toBe(false);
		return errors.join(' ');
	}

	it('a database whose canonical generation is another processor than -p, naming both', async () => {
		const db = oneDatabase();
		await aBuild(db, fakeChain().serve(logsAround(false), TIP));
		const {out} = aWorkspace();

		const message = await refused(db, out, {processor: EDITED_BUNDLE});

		expect(message).toContain((await theApp(BUNDLE)).identity);
		expect(message).toContain((await theApp(EDITED_BUNDLE)).identity);
	});

	it('a database with no canonical generation', async () => {
		const db = oneDatabase();
		const {applySchema} = await import('@etherfold/server');
		await applySchema(db);
		const {out} = aWorkspace();

		expect(await refused(db, out)).toMatch(/no generation answers reads/);
	});

	it('a database whose canonical generation has folded nothing up to the cut', async () => {
		const db = oneDatabase();
		// every log inside the reorg window: nothing is recorded at or below the cut
		await aBuild(db, fakeChain().serve([transfer(TIP - 3, '0xalate', ZERO, ALICE, 1n)], TIP));
		const {out} = aWorkspace();

		expect(await refused(db, out)).toMatch(/folded nothing up to the cut/);
	});

	it('a publication with no --out, naming the flag', async () => {
		const db = oneDatabase();
		const {out} = aWorkspace();
		const errors: unknown[] = [];
		let code: number | undefined;

		await publishMain(
			{db: ':memory:'},
			{createDB: () => db, env: ENV, exit: (value) => (code = value), error: (...args) => errors.push(...args)},
		);

		expect(code).toBe(1);
		expect(errors.join(' ')).toMatch(/--out is required by `etherfold publish`/);
		expect(existsSync(out)).toBe(false);
	});

	it('a directory holding an index it cannot read, leaving that index as it was', async () => {
		const db = oneDatabase();
		await aBuild(db, fakeChain().serve(logsAround(false), TIP));
		const {out} = aWorkspace();
		await nodePublicationFiles.mkdir(out);
		await nodePublicationFiles.write(join(out, PUBLICATION_INDEX_NAME), '{"format": 99}');

		await expect(publishing(db, out)).rejects.toThrow(/forget every entry/);

		expect(readdirSync(out)).toEqual([PUBLICATION_INDEX_NAME]);
		expect(readFileSync(join(out, PUBLICATION_INDEX_NAME), 'utf-8')).toBe('{"format": 99}');
	});
});

/**
 * A tab's stream keeper, in memory: `createSegmentedStream`, the keeper the browser
 * builds its IndexedDB one from, over a map. Its address arithmetic is the browser's
 * own and is not what is asserted here; what is, is what the install and the load
 * read and write through the keeper seam.
 */
function aTabsStreamKeeper() {
	const rows = new Map<string, unknown>();
	const port: StreamSegmentPort<Abi> = {
		async readCursor() {
			return rows.get('cursor') as StreamCursorRecord<Abi> | undefined;
		},
		async readSegments() {
			const stored: StoredSegment[] = [];
			for (const [key, value] of rows) if (key !== 'cursor') stored.push({ordinal: Number(key), value});
			return stored.sort((a, b) => a.ordinal - b.ordinal);
		},
		async commitSegmentWithCursor(_source, allocate) {
			const commit = allocate(rows.get('cursor') as StreamCursorRecord<Abi> | undefined);
			if (!commit) return;
			rows.set(String(commit.ordinal), commit.segment);
			rows.set('cursor', commit.cursor);
		},
		async writeCursorOnly(_source, next) {
			const record = next(rows.get('cursor') as StreamCursorRecord<Abi> | undefined);
			if (record) rows.set('cursor', record);
		},
		async clearSubtree() {
			const removed = rows.size;
			rows.clear();
			return removed;
		},
	};
	return createSegmentedStream<Abi>(port);
}

/** A host serving `--out` as a static directory, the `.gz` as opaque bytes. */
function servingTheDirectory(out: string): typeof globalThis.fetch {
	return (async (location: string | URL | Request) => {
		const name = String(location).split('/').at(-1)!;
		return existsSync(join(out, name))
			? new Response(new Uint8Array(readFileSync(join(out, name))), {status: 200})
			: new Response('not found', {status: 404});
	}) as typeof globalThis.fetch;
}

/** Publish through the PROCESS, keeping what it printed. */
async function publishedAndPrinted(db: RemoteSQL, out: string, extra: Options = {}): Promise<string[]> {
	const lines: string[] = [];
	let code: number | undefined;
	await publishMain(
		{db: ':memory:', out, ...extra},
		{
			createDB: () => db,
			env: ENV,
			exit: (value) => (code = value),
			log: (...args) => lines.push(args.join(' ')),
			error: (...args) => lines.push(args.join(' ')),
		},
	);
	expect(code, lines.join('\n')).toBe(0);
	return lines;
}

/** The seed's `contentHash` line, as a release would copy it out of a CI log. */
function thePrintedSeedHash(lines: string[]): string {
	const at = lines.findIndex((line) => line.startsWith('seed: '));
	expect(at).toBeGreaterThanOrEqual(0);
	const printed = lines.slice(at).find((line) => line.startsWith('  contentHash: '));
	return printed!.slice('  contentHash: '.length);
}

describe('`etherfold publish --seed`', () => {
	for (const cutCarriesLogs of [true, false]) {
		it(`writes a seed that installs through the tab's install under the hash it printed, covering exactly up to the cut (the cut ${
			cutCarriesLogs ? 'carries logs' : 'carries none'
		})`, async () => {
			const logs = logsAround(cutCarriesLogs);
			const db = oneDatabase();
			await aBuild(db, fakeChain().serve(logs, TIP));
			const {out} = aWorkspace();

			const lines = await publishedAndPrinted(db, out, {seed: true});
			const printed = thePrintedSeedHash(lines);

			// a pin is exactly what the producer printed, in the one rendering it accepts
			expect(pinnedStreamSeedContentHash(printed)).toBe(printed);
			const canonical = (await canonicalGenerationIn(db))!;
			const entry = theIndexIn(out).seeds![canonical.stream]!;
			expect(entry).toMatchObject({stream: canonical.stream, contentHash: printed, coverage: {toBlock: CUT}});

			const app = await theApp();
			const chain = fakeChain().serve(logs, TIP);
			const source = await resolveSource(app.processorModule, chain.provider);
			const outcome = await installStreamSeed(aTabsStreamKeeper(), [`https://seeds.example/${entry.body}`], {
				source,
				streamConfig: resolveStreamConfig({finality: FINALITY}),
				expectedContentHash: printed,
				fetch: servingTheDirectory(out),
			});

			// identity (digest), coverage, coherence and capture depth all held
			expect(outcome).toMatchObject({
				status: 'installed',
				at: CUT,
				reachesBackTo: entry.coverage.fromBlock,
				events: logs.filter((log) => parseInt(log.blockNumber, 16) <= CUT).length,
			});
		});
	}

	it('re-folded by a tab with the same processor, reaches the state of the snapshot published beside it', async () => {
		const logs = logsAround(true);
		const db = oneDatabase();
		await aBuild(db, fakeChain().serve(logs, TIP));
		const {out} = aWorkspace();
		const written = await publish({db: ':memory:', out, seed: true}, {createDB: () => db, env: ENV});
		const seed = written.produced.seed!;
		const snapshot = written.bodies.find((body) => body.name !== seed.body)!;

		const app = await theApp();
		// the node a tab has: it refuses nothing, and it is asked for no log below the cut
		const chain = fakeChain().serve(logs, TIP);
		const source = await resolveSource(app.processorModule, chain.provider);
		const keeper = aTabsStreamKeeper();
		const installed = await installStreamSeed(keeper, [`./${seed.body}`], {
			source,
			streamConfig: resolveStreamConfig({finality: FINALITY}),
			fetch: servingTheDirectory(out),
		});
		expect(installed).toMatchObject({status: 'installed', at: CUT});

		// a processor-only change re-folds the installed stream: the same processor stands in
		const refolded = await openForWriting(new VersionedStateStore(oneDatabase(), app.processor.entities));
		const tab = new IndexerGeneration<Abi, unknown>(
			chain.provider,
			new EntityEventProcessor(refolded, app.processor, {finalityDepth: FINALITY}) as never,
			source,
			{stream: {finality: FINALITY}, keepStream: keeper},
			{processorIdentity: app.identity},
		);
		const lastSync = await tab.load();

		expect(lastSync.lastToBlock).toBe(CUT);
		expect(chain.logRanges).toEqual([]);
		const fromTheSnapshot = await aClientFrom(out, snapshot.name, app);
		const reads = await everyRead((entity, id) => refolded.getCurrent(entity, id));
		expect(reads).toEqual(await everyRead((entity, id) => fromTheSnapshot.getCurrent(entity, id)));
		// every log up to the cut, once
		expect(reads.counter).toEqual({
			name: 'transfers',
			value: logs.filter((log) => parseInt(log.blockNumber, 16) <= CUT).length,
		});
	});

	it("keys its entry by STREAM: republishing replaces its own and keeps another stream's", async () => {
		const db = oneDatabase();
		const chain = fakeChain().serve(logsAround(false), TIP);
		await aBuild(db, chain);
		const {out} = aWorkspace();
		const other = {
			stream: 'other',
			body: 'seed-other.json.gz',
			contentHash: 'sha256:x',
			coverage: {fromBlock: 1, toBlock: 2},
			events: 0,
			savedAt: 'then',
		};
		await nodePublicationFiles.mkdir(out);
		await nodePublicationFiles.write(
			join(out, PUBLICATION_INDEX_NAME),
			JSON.stringify({format: 1, snapshots: {}, seeds: {other}}),
		);

		const first = await publish({db: ':memory:', out, seed: true}, {createDB: () => db, env: ENV});
		chain.serve([...logsAround(false), transfer(TIP + 20, '0xamore', BOB, ALICE, 1n)], TIP + 40);
		await aBuild(db, chain);
		const second = await publish({db: ':memory:', out, seed: true}, {createDB: () => db, env: ENV});

		const stream = (await canonicalGenerationIn(db))!.stream;
		const seeds = theIndexIn(out).seeds!;
		expect(Object.keys(seeds).sort()).toEqual([stream, 'other'].sort());
		expect(seeds.other).toEqual(other);
		expect(seeds[stream]!.body).toBe(second.produced.seed!.body);
		expect(second.produced.seed!.body).not.toBe(first.produced.seed!.body);
		// and nothing an earlier publication wrote was deleted
		expect(existsSync(join(out, first.produced.seed!.body))).toBe(true);
	});

	it("without --seed writes no seed body and no seed entry for this stream, and keeps another stream's", async () => {
		const db = oneDatabase();
		await aBuild(db, fakeChain().serve(logsAround(false), TIP));
		const {out} = aWorkspace();
		const other = {
			stream: 'other',
			body: 'seed-other.json.gz',
			contentHash: 'sha256:x',
			coverage: {fromBlock: 1, toBlock: 2},
			events: 0,
			savedAt: 'then',
		};
		await nodePublicationFiles.mkdir(out);
		await nodePublicationFiles.write(
			join(out, PUBLICATION_INDEX_NAME),
			JSON.stringify({format: 1, snapshots: {}, seeds: {other}}),
		);

		const lines = await publishedAndPrinted(db, out);

		expect(readdirSync(out).filter((name) => name.startsWith('seed-'))).toEqual([]);
		expect(theIndexIn(out).seeds).toEqual({other});
		expect(lines.some((line) => line.startsWith('seed: '))).toBe(false);
	});

	it('drops a reorg below the cut as its apply/retract pair: the seed carries the final chain and installs under the unchanged coherence check', async () => {
		const db = oneDatabase();
		const before = logsAround(false);
		const chain = fakeChain().serve(before, TIP);
		await aBuild(db, chain);
		// the chain reorgs at CUT + 2, inside the window, and moves on 40 blocks: the
		// block that was replaced is now BELOW the next publication's cut
		const replaced = transfer(CUT + 2, '0xbabove', CAROL, ALICE, 1n);
		const after = [...before.filter((log) => log.blockHash !== '0xaabove'), replaced].sort(
			(a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16),
		);
		chain.serve(after, TIP + 40);
		await aBuild(db, chain);
		// the append-only stream kept the reorg: the replaced block's retraction is stored
		// (and everything the fold rewound above it, re-applied on the same hash)
		const retractions = await db
			.prepare(`SELECT blockHash FROM _emissions WHERE removed = 1`)
			.all<{blockHash: string}>();
		expect(retractions.results.map((row) => row.blockHash)).toContain('0xaabove');
		const {out} = aWorkspace();

		const written = await publish({db: ':memory:', out, seed: true}, {createDB: () => db, env: ENV});
		const seed = parseStreamSeed(gunzipSync(readFileSync(join(out, written.produced.seed!.body))).toString('utf-8'));

		const newCut = TIP + 40 - FINALITY;
		expect(seed.coverage.toBlock).toBe(newCut);
		expect(seed.eventStream.some((event) => event.removed)).toBe(false);
		expect(seed.eventStream.map((event) => event.blockHash)).not.toContain('0xaabove');
		expect(seed.eventStream.map((event) => event.blockHash)).toEqual(
			after.filter((log) => parseInt(log.blockNumber, 16) <= newCut).map((log) => log.blockHash),
		);

		const app = await theApp();
		const source = await resolveSource(app.processorModule, fakeChain().serve(after, TIP + 40).provider);
		const outcome = await installStreamSeed(aTabsStreamKeeper(), [`./${written.produced.seed!.body}`], {
			source,
			streamConfig: resolveStreamConfig({finality: FINALITY}),
			expectedContentHash: written.produced.seed!.contentHash,
			fetch: servingTheDirectory(out),
		});
		expect(outcome).toMatchObject({status: 'installed', at: newCut, events: seed.eventStream.length});
	});

	it("records its stream's full source identity at fold time, and the seed's digest is the canonical generation's stream", async () => {
		const db = oneDatabase();
		await aBuild(db, fakeChain().serve(logsAround(false), TIP));
		const canonical = (await canonicalGenerationIn(db))!;
		const {out} = aWorkspace();

		const written = await publish({db: ':memory:', out, seed: true}, {createDB: () => db, env: ENV});
		const seed = parseStreamSeed(gunzipSync(readFileSync(join(out, written.produced.seed!.body))).toString('utf-8'));

		const app = await theApp();
		const source = await resolveSource(app.processorModule, fakeChain().serve([], TIP).provider);
		// what the fold wrote beside its coverage is the source's FULL hash entries, which
		// digest to the stream the claim is filed under, and not the 32-bit wire context
		const coverage = (await readStreamCoverage(db, {indexer: written.produced.indexer, stream: canonical.stream}))!;
		expect(coverage.source.length).toBeGreaterThan(0);
		expect(coverage.source.every((entry) => entry.streamHash !== undefined)).toBe(true);
		expect(streamDigestOfSourceHashes(coverage.source, seed.streamConfig)).toBe(
			streamDigestOf(source, resolveStreamConfig({finality: FINALITY})),
		);
		expect(seed.context.source).toEqual(coverage.source);
		expect(seed.streamDigest).toBe(canonical.stream);
		expect(streamDigestOfSourceHashes(seed.context.source, seed.streamConfig)).toBe(canonical.stream);
	});

	it('is refused by every command that publishes nothing, and by `build` without --publish', async () => {
		await expect(
			prepareIndexing(
				'run',
				{processor: BUNDLE, nodeUrl: 'http://x', store: 'sqlite', db: ':memory:', seed: true},
				{env: {}},
			),
		).rejects.toThrow(/--seed is not accepted by `etherfold run`/);
		await expect(
			prepareIndexing(
				'build',
				{processor: BUNDLE, nodeUrl: 'http://x', store: 'sqlite', db: ':memory:', seed: true},
				{env: {}},
			),
		).rejects.toThrow(/--seed is only accepted by `etherfold build` together with --publish <dir>/);
	});
});

describe('the command line', () => {
	it('parses `publish --db --out -p` into the handler, and refuses a flag it does not own by name', async () => {
		const received: Options[] = [];
		const program = createProgram({env: {}, publish: (options) => void received.push(options)});
		program.exitOverride();

		await program.parseAsync([
			'node',
			'etherfold',
			'publish',
			'--db',
			'file:x.db',
			'--out',
			'./site',
			'-p',
			'b.js',
			'--history',
			'5000',
			'--seed',
		]);

		expect(received[0]).toMatchObject({
			db: 'file:x.db',
			out: './site',
			processor: 'b.js',
			history: '5000',
			seed: true,
		});
		await expect(publish({db: 'file:x.db', out: './site', nodeUrl: 'http://x'}, {env: {}})).rejects.toThrow(
			/--node-url \(ETH_NODE_URI\) is not accepted by `etherfold publish`/,
		);
	});

	it('refuses a file: database that does not exist rather than creating one', async () => {
		const {root, out} = aWorkspace();
		const missing = join(root, 'nothing-here.db');

		await expect(publish({db: `file:${missing}`, out}, {env: {}})).rejects.toThrow(/names no file/);

		expect(readdirSync(root)).toEqual([]);
	});
});
