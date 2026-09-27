import {createClient} from '@libsql/client';
import type {Abi} from '@etherfold/core';
import type {EntityProcessor} from '@etherfold/processor-entities';
import {PUBLICATION_INDEX_NAME, type PublicationIndex} from '@etherfold/server';
import {loadProcessorArtifact} from '@etherfold/utils';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {
	build,
	canonicalGenerationIn,
	heldGenerationsIn,
	main,
	prepareIndexing,
	publish,
	resolveCommandConfig,
	type IndexingDependencies,
} from '../src/index.js';
import {createProgram} from '../src/program.js';
import type {Options} from '../src/types.js';
import {ALICE, BOB, CAROL, fakeChain, START_BLOCK, transfer, ZERO, type RawLog} from './utils/chain.js';
import {canonicalStoreIn} from './utils/reads.js';

// ---------------------------------------------------------------------------------------------------
// `etherfold build --publish <dir>`: THE ONE-STEP FORM OF PUBLISHING (ADR-0095)
// ---------------------------------------------------------------------------------------------------
// A real committed bundle folds a fixture chain through `build`, which then publishes
// the database it wrote into a temp directory. What is asserted is what a scheduled
// job depends on:
//
//  - the directory holds exactly what a SEPARATE `etherfold publish` over the same
//    database writes, byte for byte, because both run one implementation;
//  - `--history` and `--seed` reach the publication;
//  - a refused publication exits non-zero with the fold kept, including a build whose
//    own processor did not become canonical (its settle is fail-soft), which is
//    refused naming both identities rather than publishing the previous processor.
// ---------------------------------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL('./fixtures/processor-bundle/', import.meta.url));
const BUNDLE = join(FIXTURES, 'nfts.bundle.js');
/** The same file with one handler line changed: a different processor, a different generation. */
const EDITED_BUNDLE = join(FIXTURES, 'nfts-edited.bundle.js');

const FINALITY = 12;
const TIP = START_BLOCK + 100;
const CUT = TIP - FINALITY;
/** The first block the build records: the transfer at `START_BLOCK + 10`. */
const FIRST = START_BLOCK + 10;
const SAVED_AT = '2026-09-27T00:00:00.000Z';

const ENV = {MAX_BLOCKS_PER_FETCH: '20', STREAM_FINALITY: String(FINALITY)};

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

function aWorkspace(): string {
	const root = mkdtempSync(join(tmpdir(), 'etherfold-build-publish-'));
	directories.push(root);
	return root;
}

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

const LOGS: RawLog[] = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
	transfer(START_BLOCK + 40, '0xa40', ZERO, CAROL, 2n),
	transfer(CUT - 3, '0xabelow', BOB, CAROL, 1n),
	transfer(CUT + 2, '0xaabove', CAROL, BOB, 1n),
	transfer(TIP - 1, '0xatip', ZERO, BOB, 3n),
];

function dependencies(db: RemoteSQL, chain: ReturnType<typeof fakeChain>): IndexingDependencies {
	return {
		provider: chain.provider,
		createDB: () => db,
		sleep: async () => {},
		env: ENV,
		publication: {savedAt: SAVED_AT},
	};
}

const building = (bundle: string, extra: Options = {}): Options => ({
	processor: bundle,
	nodeUrl: 'http://localhost:0',
	store: 'sqlite',
	db: ':memory:',
	...extra,
});

/** `etherfold build`, through `main`, so the EXIT CODE is what is observed. */
async function aBuildExiting(
	db: RemoteSQL,
	chain: ReturnType<typeof fakeChain>,
	options: Options,
): Promise<{code: number | undefined; errors: string}> {
	const errors: unknown[] = [];
	let code: number | undefined;
	await main(options, {
		build: (opts) => build(opts, dependencies(db, chain)),
		exit: (value) => (code = value),
		log: () => {},
		error: (err) => errors.push(err instanceof Error ? err.message : err),
	});
	return {code, errors: errors.join(' ')};
}

/** Every file in a directory, by name, with its bytes. */
function filesIn(directory: string): Record<string, string> {
	return Object.fromEntries(
		readdirSync(directory)
			.sort()
			.map((name) => [name, readFileSync(join(directory, name)).toString('base64')]),
	);
}

function theIndexIn(out: string): PublicationIndex {
	return JSON.parse(readFileSync(join(out, PUBLICATION_INDEX_NAME), 'utf-8')) as PublicationIndex;
}

async function identityOf(bundle: string): Promise<string> {
	const outcome = await loadProcessorArtifact<Abi, unknown, EntityProcessor<Abi>>(new Uint8Array(readFileSync(bundle)));
	return outcome.identity;
}

async function transfersCountedIn(db: RemoteSQL, bundle = BUNDLE): Promise<unknown> {
	const outcome = await loadProcessorArtifact<Abi, unknown, EntityProcessor<Abi>>(new Uint8Array(readFileSync(bundle)));
	if (outcome.status !== 'instantiated') throw new Error(`the fixture bundle was refused: ${outcome.why}`);
	const store = await canonicalStoreIn(db, outcome.processor.entities);
	return (await store.getCurrent('counter', {name: 'transfers'}))?.value;
}

/**
 * A database whose PROMOTION onto `identity` fails: every write of the slot row that
 * would make that processor canonical throws, and everything else goes through. It
 * forces the one state a fail-soft settle leaves behind: a build that folded its own
 * processor to the tip while the pointer still names the previous one.
 */
function refusingThePromotionOf(db: RemoteSQL, identity: string): RemoteSQL {
	const underlying = new Map<SQLPreparedStatement, SQLPreparedStatement>();
	const doomed = new Set<SQLPreparedStatement>();
	const wrap = (statement: SQLPreparedStatement, slotWrite: boolean): SQLPreparedStatement => {
		const wrapper: SQLPreparedStatement = {
			bind(...values: any[]) {
				// the slot row binds (indexer, canonical stream, canonical processor, ...)
				const bound = wrap(statement.bind(...values), slotWrite);
				if (slotWrite && values[2] === identity) doomed.add(bound);
				return bound;
			},
			all() {
				if (doomed.has(wrapper)) throw new Error('forced: the promotion write failed');
				return statement.all();
			},
		};
		underlying.set(wrapper, statement);
		return wrapper;
	};
	return {
		prepare: (sql) => wrap(db.prepare(sql), sql.includes('INSERT INTO _generation_slots')),
		batch: async (list) => {
			if (list.some((statement) => doomed.has(statement))) throw new Error('forced: the promotion write failed');
			return db.batch(list.map((statement) => underlying.get(statement) ?? statement));
		},
	};
}

describe('`etherfold build --publish <dir>`', () => {
	it('leaves exactly what a separate `etherfold publish` over the resulting database writes', async () => {
		const db = oneDatabase();
		const root = aWorkspace();
		const inOneStep = join(root, 'one-step');
		const separately = join(root, 'separately');

		const summary = await build(building(BUNDLE, {publish: inOneStep}), dependencies(db, fakeChain().serve(LOGS, TIP)));
		expect(summary.stoppedBecause).toBe('stopped');
		await publish({db: ':memory:', out: separately}, {createDB: () => db, env: ENV, savedAt: SAVED_AT});

		expect(readdirSync(inOneStep)).toContain(PUBLICATION_INDEX_NAME);
		expect(filesIn(inOneStep)).toEqual(filesIn(separately));
		const canonical = (await canonicalGenerationIn(db))!;
		expect(canonical.processor).toBe(await identityOf(BUNDLE));
		expect(Object.values(theIndexIn(inOneStep).snapshots)).toEqual([
			expect.objectContaining({stream: canonical.stream, processor: canonical.processor, cut: CUT}),
		]);
	});

	it('passes --history and --seed through to the publication', async () => {
		const db = oneDatabase();
		const root = aWorkspace();
		const inOneStep = join(root, 'one-step');
		const separately = join(root, 'separately');

		await build(
			building(BUNDLE, {publish: inOneStep, history: 'all', seed: true}),
			dependencies(db, fakeChain().serve(LOGS, TIP)),
		);
		await publish(
			{db: ':memory:', out: separately, history: 'all', seed: true},
			{createDB: () => db, env: ENV, savedAt: SAVED_AT},
		);

		const canonical = (await canonicalGenerationIn(db))!;
		const index = theIndexIn(inOneStep);
		expect(Object.values(index.snapshots)[0]!.floor).toBe(FIRST);
		expect(index.seeds?.[canonical.stream]).toMatchObject({stream: canonical.stream, coverage: {toBlock: CUT}});
		expect(existsSync(join(inOneStep, index.seeds![canonical.stream]!.body))).toBe(true);
		expect(filesIn(inOneStep)).toEqual(filesIn(separately));
	});

	it('publishes nothing without --publish', async () => {
		const db = oneDatabase();
		const root = aWorkspace();

		await build(building(BUNDLE), dependencies(db, fakeChain().serve(LOGS, TIP)));

		expect(readdirSync(root)).toEqual([]);
	});
});

describe('`etherfold build --publish` refused, with the fold kept', () => {
	it('exits non-zero on a publish refusal, writing nothing, and the folded database is intact', async () => {
		const db = oneDatabase();
		const out = join(aWorkspace(), 'published');
		// every log inside the reorg window: nothing is recorded at or below the cut
		const chain = fakeChain().serve([transfer(TIP - 3, '0xalate', ZERO, ALICE, 1n)], TIP);

		const {code, errors} = await aBuildExiting(db, chain, building(BUNDLE, {publish: out}));

		expect(code).toBe(1);
		expect(errors).toMatch(/folded nothing up to the cut/);
		expect(existsSync(out)).toBe(false);
		// the fold is kept: the canonical generation is this build's, holding what it folded
		expect((await canonicalGenerationIn(db))!.processor).toBe(await identityOf(BUNDLE));
		expect(await transfersCountedIn(db)).toBe(1);
	});

	it("refuses, naming both identities, when the build's own processor did not become canonical", async () => {
		const db = oneDatabase();
		const out = join(aWorkspace(), 'published');
		const chain = fakeChain().serve(LOGS, TIP);
		// a first build: the canonical generation is BUNDLE's
		await build(building(BUNDLE), dependencies(db, chain));
		const previous = await identityOf(BUNDLE);
		const own = await identityOf(EDITED_BUNDLE);

		// a re-run with CHANGED bytes, whose settle onto its own successor is forced to fail
		const {code, errors} = await aBuildExiting(
			refusingThePromotionOf(db, own),
			chain,
			building(EDITED_BUNDLE, {publish: out}),
		);

		expect(code).toBe(1);
		expect(errors).toContain(previous);
		expect(errors).toContain(own);
		expect(existsSync(out)).toBe(false);
		// the fold is kept: the previous generation still answers, and this build's successor
		// is held beside it, folded
		const [held] = await heldGenerationsIn(db);
		expect(held!.canonical?.processor).toBe(previous);
		expect(held!.generations.map((generation) => generation.processor)).toContain(own);
		expect(await transfersCountedIn(db)).toBe(LOGS.length);
		// ...and publishing the previous processor, when asked for by name, still works
		await publish({db: ':memory:', out, processor: BUNDLE}, {createDB: () => db, env: ENV});
		expect(Object.values(theIndexIn(out).snapshots)[0]!.processor).toBe(previous);
	});
});

describe('the command line', () => {
	it('parses `build --publish --history --seed` into the handler', async () => {
		const received: Options[] = [];
		const program = createProgram({env: {}, build: (options) => void received.push(options)});
		program.exitOverride();

		await program.parseAsync([
			'node',
			'etherfold',
			'build',
			'-p',
			'b.js',
			'--publish',
			'./site',
			'--history',
			'5000',
			'--seed',
		]);

		expect(received[0]).toMatchObject({processor: 'b.js', publish: './site', history: '5000', seed: true});
	});

	it('resolves --publish into the build configuration, with --history and --seed', () => {
		const config = resolveCommandConfig('build', building(BUNDLE, {publish: './site', history: '30', seed: true}), {});
		expect(config.publish).toEqual({out: './site', history: 30, seed: true});
		expect(resolveCommandConfig('build', building(BUNDLE), {}).publish).toBeUndefined();
	});

	it('refuses --history and --seed on `build` without --publish, naming it', async () => {
		for (const extra of [{history: 'all'}, {seed: true}] as Options[]) {
			await expect(prepareIndexing('build', building(BUNDLE, extra), {env: {}})).rejects.toThrow(
				/only accepted by `etherfold build` together with --publish <dir>/,
			);
		}
	});

	it('refuses --publish on every other command, and --out on `build`, each naming where it lives', () => {
		expect(() => resolveCommandConfig('publish', {db: ':memory:', out: './o', publish: './site'}, {})).toThrow(
			/--publish is not accepted by `etherfold publish`.*--out/s,
		);
		expect(() =>
			resolveCommandConfig(
				'run',
				{processor: BUNDLE, nodeUrl: 'http://x', store: 'sqlite', db: ':memory:', publish: './s'},
				{},
			),
		).toThrow(/--publish is not accepted by `etherfold run`.*`etherfold build`/s);
		expect(() => resolveCommandConfig('build', building(BUNDLE, {out: './site'}), {})).toThrow(
			/--out is not accepted by `etherfold build`.*--publish <dir>/s,
		);
	});
});
