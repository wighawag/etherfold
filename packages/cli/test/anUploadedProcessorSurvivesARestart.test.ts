import {GENERATION_TABLE} from '@etherfold/server';
import {processorArtifactIdentity} from '@etherfold/utils';
import {createClient} from '@libsql/client';
import {copyFile, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {run, type RunningIndexer} from '../src/index.js';
import type {StartGuardDependencies} from '../src/startGuard.js';
import type {Options} from '../src/types.js';
import {uploadMain} from '../src/uploadCommand.js';
import {ALICE, BOB, CAROL, fakeChain, START_BLOCK, transfer, ZERO} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// AN UPLOADED PROCESSOR SURVIVES A RESTART, including one still catching up
// ---------------------------------------------------------------------------------------------------
// Story 10 of `a-processor-artifact-is-pushed-to-a-running-deployment`: an upload is a
// DEPLOYMENT and not a session. Asserted END TO END against a real `run` and the real
// `etherfold upload`, over the committed REAL bundles (`fixtures/processor-bundle/`),
// in the shape `anUpgradingRestartKeepsTheIncumbentFolding.test.ts` stands up: a node
// is STOPPED and run again over the same database, and the restarted process has
// never been handed the uploaded bytes -- the only copy is on the registry row.
//
//  - an upload that is CANONICAL is instantiated from its stored bytes and goes on
//    folding (ADR-0092, ADR-0093);
//  - an upload that was still CATCHING UP (the `successor`) is instantiated too,
//    catches up, and is promoted under `on-catch-up` with nobody asking; the
//    incumbent's fold then stops (ADR-0092's amendment of 2026-09-26);
//  - a restart with a `--processor` is an arrival like any other, and a START may not
//    SILENTLY replace a different pending successor: interactive asks, non-interactive
//    is refused unless `--override` (ADR-0084's and ADR-0093's amendments);
//  - a re-read and an upload still replace a pending successor without a question.
//
// The bundles: `nfts.bundle.js` credits a token to its recipient, `nfts-edited.bundle.js`
// to its sender, so which fold answered is readable from the answer. A THIRD processor
// on the same contracts is the edited bundle's bytes plus a trailing comment: a
// different identity, the same stream.
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
/** What the chain does while the node is down: BOB hands the token to CAROL. */
const LATER = [...LOGS, transfer(START_BLOCK + 70, '0xa70', BOB, CAROL, 1n)];
const LATER_TIP = START_BLOCK + 100;
/** ...and after the promotion: CAROL hands it back to ALICE. */
const LATEST = [...LATER, transfer(START_BLOCK + 120, '0xa120', CAROL, ALICE, 1n)];
const LATEST_TIP = START_BLOCK + 150;

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

const bytesOf = async (path: string): Promise<Uint8Array> => new Uint8Array(await readFile(path));

/** A THIRD processor on the same contracts: the edited bundle's bytes, plus a comment that changes its hash. */
async function aThirdBundle(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-upload-survives-'));
	scratch.push(dir);
	const path = join(dir, 'third.bundle.js');
	await writeFile(path, `${await readFile(EDITED_BUNDLE, 'utf-8')}\n// a third build\n`, 'utf-8');
	return path;
}

/** A path a CONFIGURED node is pointed at, whose bytes a test may replace. */
async function aProcessorPath(from: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-upload-survives-'));
	scratch.push(dir);
	const path = join(dir, 'processor.bundle.js');
	await copyFile(from, path);
	return path;
}

/** NOTHING CONFIGURED: no processor and no source (ADR-0093). */
const NOTHING: Options = {nodeUrl: 'http://localhost:0', store: 'sqlite', db: ':memory:', port: '0', indexer: INDEXER};

/**
 * THE LOOP'S WAIT, which a test can PARK: while parked, the drive loop stops at its
 * next wait and neither fetches nor rebuilds, until the process is stopped. It is how
 * an upload is left CATCHING UP when the process stops, deterministically.
 */
function aParkableWait() {
	const state = {parked: false, parkedNow: false};
	const sleep = async (_ms: number, signal?: AbortSignal): Promise<void> => {
		if (!state.parked) {
			await new Promise((resolve) => setTimeout(resolve, 1));
			return;
		}
		state.parkedNow = true;
		await new Promise<void>((resolve) => {
			if (signal?.aborted) return resolve();
			signal?.addEventListener('abort', () => resolve(), {once: true});
		});
	};
	return {state, sleep};
}

/** START a `run` over `db`, which may already hold generations: a restart, when it does. */
async function aRunOver(
	db: RemoteSQL,
	chain: ReturnType<typeof fakeChain>,
	options: Options = NOTHING,
	extra: {sleep?: ReturnType<typeof aParkableWait>['sleep']; startGuard?: StartGuardDependencies} = {},
): Promise<RunningIndexer> {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	running = await run(
		{...NOTHING, ...options},
		{
			provider: chain.provider,
			createDB: () => db,
			sleep:
				extra.sleep ??
				(async () => {
					await new Promise((resolve) => setTimeout(resolve, 1));
				}),
			handleSignals: false,
			log: () => {},
			env: {MAX_BLOCKS_PER_FETCH: '20'},
			// never the terminal: a suite has nobody to answer, unless a case says it does
			startGuard: extra.startGuard ?? {interactive: false},
		},
	);
	return running;
}

async function stop(): Promise<void> {
	await running?.stop().catch(() => undefined);
	running = undefined;
}

/** `etherfold upload`, as `cli.ts` runs it, with its exit code and its output captured. */
async function uploadWith(indexer: RunningIndexer, bundle: string): Promise<{code?: number; out: string; err: string}> {
	const out: string[] = [];
	const err: string[] = [];
	let code: number | undefined;
	await uploadMain(
		{bundle, to: indexer.url, indexer: INDEXER},
		{
			env: {ADMIN_TOKEN},
			log: (...args) => out.push(args.map(String).join(' ')),
			error: (...args) => err.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')),
			exit: (value) => {
				code = value;
			},
		},
	);
	return {...(code === undefined ? {} : {code}), out: out.join('\n'), err: err.join('\n')};
}

type Listing = {
	slots?: Record<string, {digest: string} | undefined>;
	generations: {digest: string; stream: string; processor: string; canonical: boolean}[];
};

async function listingOf(indexer: RunningIndexer): Promise<Listing> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
	});
	expect(res.status).toBe(200);
	return (await res.json()) as Listing;
}

async function digestOf(indexer: RunningIndexer, bundle: string): Promise<string | undefined> {
	const identity = processorArtifactIdentity(await bytesOf(bundle));
	return (await listingOf(indexer)).generations.find((entry) => entry.processor === identity)?.digest;
}

async function identityOf(indexer: RunningIndexer, digest: string): Promise<{stream: string; processor: string}> {
	const target = (await listingOf(indexer)).generations.find((entry) => entry.digest === digest);
	if (!target) throw new Error(`this deployment holds no generation ${digest}`);
	return {stream: target.stream, processor: target.processor};
}

/** How far one generation has folded, read from its own namespace with no engine, as the trigger reads it. */
async function positionOf(indexer: RunningIndexer, digest: string): Promise<number | undefined> {
	return indexer.container.registry.readStateCursor(await identityOf(indexer, digest));
}

/** Which generations THIS PROCESS folds, by processor identity. */
function foldedHere(indexer: RunningIndexer): string[] {
	return indexer.container.held().map((fold) => fold.record.processor);
}

async function waitFor(what: string, done: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		if (await done()) return;
		if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Whether the registry row for a processor identity still carries its stored bytes, read straight from the table. */
async function bundleStoredFor(db: RemoteSQL, processor: string): Promise<boolean> {
	const rows = (await db
		.prepare(`SELECT bundle FROM ${GENERATION_TABLE} WHERE indexer = ?1 AND processor = ?2`)
		.bind(INDEXER, processor)
		.all()) as unknown as {results?: {bundle: unknown}[]} | {bundle: unknown}[];
	const list = Array.isArray(rows) ? rows : (rows.results ?? []);
	return list.some((row) => row.bundle !== null && row.bundle !== undefined);
}

/**
 * A node started with NOTHING configured, whose first upload folded to the tip and
 * became canonical, and whose SECOND upload was still catching up when it stopped:
 * `successor` names it, with its bytes stored, and it has folded nothing.
 */
async function aNodeStoppedMidUpgrade(): Promise<{db: RemoteSQL; incumbent: string; successor: string}> {
	const db = oneDatabase();
	const wait = aParkableWait();
	const first = await aRunOver(db, fakeChain().serve(LOGS, TIP), NOTHING, {sleep: wait.sleep});
	expect((await uploadWith(first, BUNDLE)).code).toBe(0);
	const incumbent = (await digestOf(first, BUNDLE)) as string;
	await waitFor('the first upload folded to the tip', async () => (await positionOf(first, incumbent)) === TIP);

	// PARK the loop, so what arrives next is registered and then left exactly where it is
	wait.state.parked = true;
	await waitFor('the drive loop parked', async () => wait.state.parkedNow);
	const sent = await uploadWith(first, EDITED_BUNDLE);
	expect(sent.code, sent.err).toBe(0);
	expect(sent.out).toMatch(/\bregistered\b/);
	const successor = (await digestOf(first, EDITED_BUNDLE)) as string;
	const listing = await listingOf(first);
	expect(listing.slots?.canonical?.digest).toBe(incumbent);
	expect(listing.slots?.successor?.digest).toBe(successor);
	expect(await positionOf(first, successor)).toBeUndefined();
	await stop();
	return {db, incumbent, successor};
}

// ---------------------------------------------------------------------------------------------------

describe('an upload that is CANONICAL survives a restart with nothing configured', () => {
	it('is instantiated from its stored bytes, and its cursor advances', async () => {
		const db = oneDatabase();
		const first = await aRunOver(db, fakeChain().serve(LOGS, TIP));
		const sent = await uploadWith(first, BUNDLE);
		expect(sent.code, sent.err).toBe(0);
		const uploaded = (await digestOf(first, BUNDLE)) as string;
		await waitFor('the upload folded to the tip', async () => (await positionOf(first, uploaded)) === TIP);
		await stop();

		// the chain moves on while nothing runs, and the node comes back with NOTHING configured
		const restarted = await aRunOver(db, fakeChain().serve(LATER, LATER_TIP));

		expect((await listingOf(restarted)).slots?.canonical?.digest).toBe(uploaded);
		expect(foldedHere(restarted)).toEqual([processorArtifactIdentity(await bytesOf(BUNDLE))]);
		await waitFor('the uploaded generation folded past where it stood', async () => {
			const now = await positionOf(restarted, uploaded);
			return now !== undefined && now > TIP;
		});
	});
});

describe('an upload still CATCHING UP survives a restart, and the upgrade finishes', () => {
	it('folds BOTH the canonical generation and the successor from their stored bytes', async () => {
		const {db, incumbent, successor} = await aNodeStoppedMidUpgrade();

		// `manual`, so what is held can be read without racing the promotion
		const restarted = await aRunOver(db, fakeChain().serve(LATER, LATER_TIP), {...NOTHING, promotion: 'manual'});

		expect(foldedHere(restarted).sort()).toEqual(
			[(await identityOf(restarted, incumbent)).processor, (await identityOf(restarted, successor)).processor].sort(),
		);
		await waitFor('the successor caught the incumbent up', async () => {
			const behind = await positionOf(restarted, successor);
			const ahead = await positionOf(restarted, incumbent);
			return behind !== undefined && ahead !== undefined && ahead > TIP && behind >= ahead;
		});
		// `manual` means only when asked
		expect((await listingOf(restarted)).slots?.canonical?.digest).toBe(incumbent);
	});

	it('promotes it under `on-catch-up` with nobody asking, and the incumbent then stops folding', async () => {
		const {db, incumbent, successor} = await aNodeStoppedMidUpgrade();
		const chain = fakeChain().serve(LATER, LATER_TIP);

		const restarted = await aRunOver(db, chain);

		await waitFor(
			'the successor was promoted',
			async () => (await listingOf(restarted)).slots?.canonical?.digest === successor,
		);
		// the incumbent FOLDED in this process -- it went past where the previous one left it
		// -- and was then let go: only the promoted successor is folded here
		const incumbentStood = await positionOf(restarted, incumbent);
		expect(incumbentStood).toBe(LATER_TIP);
		expect(foldedHere(restarted)).toEqual([(await identityOf(restarted, successor)).processor]);
		expect((await listingOf(restarted)).slots?.predecessor?.digest).toBe(incumbent);

		chain.serve(LATEST, LATEST_TIP);
		await waitFor('the promoted successor folded the latest block', async () => {
			const now = await positionOf(restarted, successor);
			return now !== undefined && now > LATER_TIP;
		});
		expect(await positionOf(restarted, incumbent)).toBe(incumbentStood);

		// ...and a restart after it does NOT instantiate the predecessor: nobody reads it
		await stop();
		const again = await aRunOver(db, fakeChain().serve(LATEST, LATEST_TIP));
		expect(foldedHere(again)).toEqual([(await identityOf(again, successor)).processor]);
		expect((await listingOf(again)).slots?.predecessor?.digest).toBe(incumbent);
	});
});

describe('a restart with `--processor` is an arrival like any other', () => {
	it('registers a DIFFERENT processor as the successor, where nothing is pending', async () => {
		const db = oneDatabase();
		const first = await aRunOver(db, fakeChain().serve(LOGS, TIP));
		expect((await uploadWith(first, BUNDLE)).code).toBe(0);
		const uploaded = (await digestOf(first, BUNDLE)) as string;
		await stop();

		const restarted = await aRunOver(db, fakeChain().serve(LOGS, TIP), {
			...NOTHING,
			processor: EDITED_BUNDLE,
			promotion: 'manual',
		});

		const listing = await listingOf(restarted);
		expect(listing.slots?.canonical?.digest).toBe(uploaded);
		expect(listing.slots?.successor?.digest).toBe(await digestOf(restarted, EDITED_BUNDLE));
	});

	it('changes NOTHING when it names the canonical processor: the pending upload stays, and folds', async () => {
		const {db, incumbent, successor} = await aNodeStoppedMidUpgrade();
		const asked: string[] = [];

		const restarted = await aRunOver(
			db,
			fakeChain().serve(LOGS, TIP),
			{...NOTHING, processor: BUNDLE, promotion: 'manual'},
			{
				startGuard: {
					interactive: true,
					confirm: async (question) => {
						asked.push(question);
						return false;
					},
				},
			},
		);

		expect(asked).toEqual([]);
		const listing = await listingOf(restarted);
		expect(listing.slots?.canonical?.digest).toBe(incumbent);
		expect(listing.slots?.successor?.digest).toBe(successor);
		expect(foldedHere(restarted)).toContain((await identityOf(restarted, successor)).processor);
	});

	it('changes nothing when it names the pending successor itself, and asks nothing', async () => {
		const {db, successor} = await aNodeStoppedMidUpgrade();

		const restarted = await aRunOver(db, fakeChain().serve(LOGS, TIP), {
			...NOTHING,
			processor: EDITED_BUNDLE,
			promotion: 'manual',
		});

		expect((await listingOf(restarted)).slots?.successor?.digest).toBe(successor);
	});
});

describe('a START may not SILENTLY replace a different pending successor that arrived by upload', () => {
	it('is REFUSED by name when nobody can be asked, with nothing registered or deleted', async () => {
		const {db, incumbent, successor} = await aNodeStoppedMidUpgrade();
		const third = await aThirdBundle();

		await expect(aRunOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, processor: third})).rejects.toThrow(
			new RegExp(`${successor}[\\s\\S]*REFUSED[\\s\\S]*--override`),
		);
		running = undefined;

		// the registry is exactly as it was: the upload is still pending, bytes and all
		const after = await aRunOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, promotion: 'manual'});
		const listing = await listingOf(after);
		expect(listing.slots?.canonical?.digest).toBe(incumbent);
		expect(listing.slots?.successor?.digest).toBe(successor);
		expect(listing.generations.map((entry) => entry.digest).sort()).toEqual([incumbent, successor].sort());
		expect(await bundleStoredFor(db, (await identityOf(after, successor)).processor)).toBe(true);
	});

	it('replaces it -- row, state and bytes -- under `--override`', async () => {
		const {db, incumbent, successor} = await aNodeStoppedMidUpgrade();
		const third = await aThirdBundle();
		const replacedProcessor = processorArtifactIdentity(await bytesOf(EDITED_BUNDLE));

		const restarted = await aRunOver(db, fakeChain().serve(LOGS, TIP), {
			...NOTHING,
			processor: third,
			override: true,
			promotion: 'manual',
		});

		const listing = await listingOf(restarted);
		expect(listing.slots?.canonical?.digest).toBe(incumbent);
		expect(listing.slots?.successor?.digest).toBe(await digestOf(restarted, third));
		expect(listing.generations.map((entry) => entry.digest)).not.toContain(successor);
		expect(await bundleStoredFor(db, replacedProcessor)).toBe(false);
		// the replaced upload was never built into a fold: `add` replaced it before the
		// pending successor was instantiated
		expect(foldedHere(restarted)).not.toContain(replacedProcessor);
	});

	it('ASKS when it can, naming both generations, and a no leaves everything as it was', async () => {
		const {db, successor} = await aNodeStoppedMidUpgrade();
		const third = await aThirdBundle();
		const asked: string[] = [];

		await expect(
			aRunOver(
				db,
				fakeChain().serve(LOGS, TIP),
				{...NOTHING, processor: third},
				{
					startGuard: {
						interactive: true,
						confirm: async (question) => {
							asked.push(question);
							return false;
						},
					},
				},
			),
		).rejects.toThrow(/Declined/);
		running = undefined;

		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain(successor);
		expect(asked[0]).toContain(processorArtifactIdentity(await bytesOf(third)));

		const after = await aRunOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, promotion: 'manual'});
		expect((await listingOf(after)).slots?.successor?.digest).toBe(successor);
	});

	it('and a yes replaces it', async () => {
		const {db, successor} = await aNodeStoppedMidUpgrade();
		const third = await aThirdBundle();

		const restarted = await aRunOver(
			db,
			fakeChain().serve(LOGS, TIP),
			{...NOTHING, processor: third, promotion: 'manual'},
			{startGuard: {interactive: true, confirm: async () => true}},
		);

		const listing = await listingOf(restarted);
		expect(listing.slots?.successor?.digest).toBe(await digestOf(restarted, third));
		expect(listing.generations.map((entry) => entry.digest)).not.toContain(successor);
	});
});

describe('the deliberate arrivals on a RUNNING node still replace a pending successor without a question', () => {
	it('an upload and a re-read each replace it, and nobody is asked', async () => {
		const db = oneDatabase();
		const path = await aProcessorPath(BUNDLE);
		const asked: string[] = [];
		const indexer = await aRunOver(
			db,
			fakeChain().serve(LOGS, TIP),
			{...NOTHING, processor: path, promotion: 'manual'},
			{
				startGuard: {
					interactive: true,
					confirm: async (question) => {
						asked.push(question);
						return false;
					},
				},
			},
		);

		// an upload takes the empty slot...
		expect((await uploadWith(indexer, EDITED_BUNDLE)).code).toBe(0);
		const edited = (await digestOf(indexer, EDITED_BUNDLE)) as string;
		expect((await listingOf(indexer)).slots?.successor?.digest).toBe(edited);

		// ...a second upload REPLACES it
		const third = await aThirdBundle();
		const uploaded = await uploadWith(indexer, third);
		expect(uploaded.code, uploaded.err).toBe(0);
		expect(uploaded.out).toMatch(/\bregistered\b/);
		const thirdDigest = (await digestOf(indexer, third)) as string;
		let listing = await listingOf(indexer);
		expect(listing.slots?.successor?.digest).toBe(thirdDigest);
		expect(listing.generations.map((entry) => entry.digest)).not.toContain(edited);

		// ...and a RE-READ of the configured path, now holding the edited bundle, replaces that
		await copyFile(EDITED_BUNDLE, path);
		const res = await fetch(`${indexer.url}/${INDEXER}/admin/reconfigure`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
		});
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status, JSON.stringify(body)).toBe(200);
		expect(body).toMatchObject({arrival: 're-read', outcome: 'registered'});
		listing = await listingOf(indexer);
		expect(listing.slots?.successor?.digest).toBe(await digestOf(indexer, EDITED_BUNDLE));
		expect(listing.generations.map((entry) => entry.digest)).not.toContain(thirdDigest);

		expect(asked).toEqual([]);
	});
});
