import {createClient} from '@libsql/client';
import {IndexerGeneration, type Abi} from '@etherfold/core';
import {
	EntityEventProcessor,
	openForWriting,
	openSnapshotAware,
	readSnapshot,
	type EntityProcessor,
} from '@etherfold/processor-entities';
import {PUBLICATION_INDEX_NAME, type PublicationIndex} from '@etherfold/server';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {loadProcessorArtifact, resolveSource} from '@etherfold/utils';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
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
//  - every refusal writes nothing, exits non-zero and says why.
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
async function aBuild(db: RemoteSQL, chain: ReturnType<typeof fakeChain>, bundle = BUNDLE): Promise<void> {
	const deps: IndexingDependencies = {provider: chain.provider, createDB: () => db, sleep: async () => {}, env: ENV};
	const options: Options = {processor: bundle, nodeUrl: 'http://localhost:0', store: 'sqlite', db: ':memory:'};
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

describe('the command line', () => {
	it('parses `publish --db --out -p` into the handler, and refuses a flag it does not own by name', async () => {
		const received: Options[] = [];
		const program = createProgram({env: {}, publish: (options) => void received.push(options)});
		program.exitOverride();

		await program.parseAsync(['node', 'etherfold', 'publish', '--db', 'file:x.db', '--out', './site', '-p', 'b.js']);

		expect(received[0]).toMatchObject({db: 'file:x.db', out: './site', processor: 'b.js'});
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
