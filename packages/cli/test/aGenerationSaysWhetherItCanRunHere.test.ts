import {createClient} from '@libsql/client';
import {copyFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {run, type RunningIndexer} from '../src/index.js';
import type {Options} from '../src/types.js';
import {fakeChain, START_BLOCK, transfer, ZERO, ALICE, BOB} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// A GENERATION SAYS WHETHER IT CAN RUN HERE, so an operator can tell before reverting
// ---------------------------------------------------------------------------------------------------
// ADR-0092's visibility half, asserted over a real deployment, a real database and
// the committed pair of real bundles (`fixtures/processor-bundle/`). The listing an
// operator reads before a revert (`GET /{indexer}/admin/canonical-generation`)
// says, for each generation, whether it can fold HERE:
//
//   held          this process folds it;
//   instantiable  the bundle stored on its row can be instantiated when it has to
//                 fold -- which is what a revert onto it will do;
//   frozen        neither, with the reason.
//
// Story 8 ("this generation is frozen because its code is gone") is REACHABLE, and
// the last describe is the evidence: a restart whose canonical generation's stored
// code cannot be built STARTS, serves that generation, and never advances it
// (`an-upgrading-restart-keeps-the-incumbent-folding` decided not to refuse to
// start). Before this, the only thing that said why was a log line.
//
// The container's half, including a filter change's generation and a host with no
// way to instantiate bytes, is `packages/core/test/aGenerationSaysWhetherItCanRunHere.test.ts`.
// ---------------------------------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL('./fixtures/processor-bundle/', import.meta.url));
const BUNDLE = join(FIXTURES, 'nfts.bundle.js');
const EDITED_BUNDLE = join(FIXTURES, 'nfts-edited.bundle.js');

const INDEXER = 'nfts';
const ADMIN_TOKEN = 'the-operators-own-secret';

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
];
const TIP = START_BLOCK + 50;

const scratch: string[] = [];
let running: RunningIndexer | undefined;

afterEach(async () => {
	await running?.stop().catch(() => undefined);
	running = undefined;
	for (const dir of scratch.splice(0)) {
		await rm(dir, {recursive: true, force: true}).catch(() => undefined);
	}
	delete process.env.ADMIN_TOKEN;
});

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

async function aProcessorPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-can-run-here-'));
	scratch.push(dir);
	const path = join(dir, 'processor.bundle.js');
	await copyFile(BUNDLE, path);
	return path;
}

async function aRunOver(
	db: RemoteSQL,
	processorPath: string,
	chain: ReturnType<typeof fakeChain>,
	extra?: Partial<Options>,
): Promise<RunningIndexer> {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	running = await run(
		{
			processor: processorPath,
			nodeUrl: 'http://localhost:0',
			store: 'sqlite',
			db: ':memory:',
			port: '0',
			indexer: INDEXER,
			...extra,
		},
		{
			provider: chain.provider,
			createDB: () => db,
			sleep: async () => {
				await new Promise((resolve) => setTimeout(resolve, 1));
			},
			handleSignals: false,
			log: () => {},
			env: {MAX_BLOCKS_PER_FETCH: '20'},
		},
	);
	return running;
}

async function stop(): Promise<void> {
	await running?.stop().catch(() => undefined);
	running = undefined;
}

type Listed = {
	digest: string;
	canonical: boolean;
	stream: string;
	processor: string;
	slot?: string;
	folding?: string;
	frozen?: {reason: string; message: string};
};

async function listingOf(indexer: RunningIndexer): Promise<{generations: Listed[]; slots: unknown}> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
	});
	expect(res.status).toBe(200);
	return (await res.json()) as {generations: Listed[]; slots: unknown};
}

async function entryFor(indexer: RunningIndexer, digest: string): Promise<Listed> {
	const entry = (await listingOf(indexer)).generations.find((one) => one.digest === digest);
	if (!entry) throw new Error(`this deployment lists no generation ${digest}`);
	return entry;
}

async function canonicalOf(indexer: RunningIndexer): Promise<string | undefined> {
	return (await listingOf(indexer)).generations.find((entry) => entry.canonical)?.digest;
}

async function waitFor(what: string, done: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		if (await done()) return;
		if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/**
 * A deployment that folded under `nfts.bundle.js` to the tip and STOPPED, with a
 * hook to damage what is stored before it runs again under `nfts-edited.bundle.js`
 * alone.
 */
async function aRestartWithAChangedProcessor(
	options: {beforeRestart?: (db: RemoteSQL, incumbent: Listed) => Promise<void>; extra?: Partial<Options>} = {},
): Promise<{db: RemoteSQL; indexer: RunningIndexer; incumbent: string; successor: string}> {
	const db = oneDatabase();
	const path = await aProcessorPath();
	const first = await aRunOver(db, path, fakeChain().serve(LOGS, TIP));
	await waitFor('the first deployment folded to the tip', async () => {
		const canonical = (await listingOf(first)).generations.find((entry) => entry.canonical);
		return !!canonical && (await first.container.registry.readStateCursor(canonical)) === TIP;
	});
	const incumbent = (await listingOf(first)).generations.find((entry) => entry.canonical) as Listed;
	await stop();
	await options.beforeRestart?.(db, incumbent);

	await copyFile(EDITED_BUNDLE, path);
	const indexer = await aRunOver(db, path, fakeChain().serve(LOGS, TIP), options.extra);
	const successor = (await listingOf(indexer)).generations
		.map((entry) => entry.digest)
		.find((one) => one !== incumbent.digest);
	expect(successor, 'the restart registered no successor').toBeDefined();
	return {db, indexer, incumbent: incumbent.digest, successor: successor as string};
}

/** POINT AT a generation through the authenticated admin route (ADR-0057). */
async function pointAt(indexer: RunningIndexer, digest: string): Promise<number> {
	const {stream, processor} = await entryFor(indexer, digest);
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		method: 'POST',
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json'},
		body: JSON.stringify({stream, processor}),
	});
	return res.status;
}

// ---------------------------------------------------------------------------------------------------

describe('before a revert, the listing says whether the generation reverted to can fold here', () => {
	it('says HELD for what this process folds and INSTANTIABLE for the stored generation this build lacks', async () => {
		const {indexer, incumbent, successor} = await aRestartWithAChangedProcessor();
		await waitFor('the successor was promoted', async () => (await canonicalOf(indexer)) === successor);

		expect(await entryFor(indexer, successor)).toMatchObject({canonical: true, folding: 'held'});
		const target = await entryFor(indexer, incumbent);
		expect(target).toMatchObject({canonical: false, slot: 'predecessor', folding: 'instantiable'});
		expect(target.frozen).toBeUndefined();
		// ...and saying so built nothing: only the new code runs in this process
		expect(indexer.container.held().map((fold) => fold.record.processor)).toEqual([
			(await entryFor(indexer, successor)).processor,
		]);

		// the claim is kept: the revert instantiates it, and the listing follows the pointer
		expect(await pointAt(indexer, incumbent)).toBe(200);
		expect(await entryFor(indexer, incumbent)).toMatchObject({canonical: true, folding: 'held'});
		expect(await entryFor(indexer, successor)).toMatchObject({canonical: false, folding: 'instantiable'});
	});
});

describe('a canonical generation whose code cannot run here is REPORTED, not merely stalled (story 8)', () => {
	it('names the stored code that could not be built, on a deployment that started and serves it', async () => {
		const {indexer, incumbent, successor} = await aRestartWithAChangedProcessor({
			// the bytes on the incumbent's row no longer build a processor
			beforeRestart: async (db, stored) => {
				await db
					.prepare(`UPDATE _generations SET bundle = ?1 WHERE processor = ?2`)
					.bind(new TextEncoder().encode('export const nothing = 1;\n'), stored.processor)
					.all();
			},
			// `manual`, so the pointer stays on the stalled generation for as long as the assertion needs
			extra: {promotion: 'manual'},
		});

		// the deployment is up and answers from the incumbent, which nothing here folds
		expect(await canonicalOf(indexer)).toBe(incumbent);
		const stalled = await entryFor(indexer, incumbent);
		expect(stalled).toMatchObject({canonical: true, folding: 'frozen', frozen: {reason: 'instantiation-failed'}});
		expect(stalled.frozen?.message).toMatch(/could not turn the stored bytes into a fold/);
		expect(await entryFor(indexer, successor)).toMatchObject({folding: 'held'});
	});

	it('says its code is GONE where no bundle is stored on its row at all', async () => {
		const {indexer, incumbent} = await aRestartWithAChangedProcessor({
			beforeRestart: async (db, stored) => {
				await db.prepare(`UPDATE _generations SET bundle = NULL WHERE processor = ?1`).bind(stored.processor).all();
			},
			extra: {promotion: 'manual'},
		});

		expect(await canonicalOf(indexer)).toBe(incumbent);
		expect(await entryFor(indexer, incumbent)).toMatchObject({
			canonical: true,
			folding: 'frozen',
			frozen: {reason: 'no-bundle', message: expect.stringMatching(/its code is gone/)},
		});
	});
});
