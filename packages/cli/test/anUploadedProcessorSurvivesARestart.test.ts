import {generationDigestOf} from '@etherfold/core';
import {GENERATION_TABLE} from '@etherfold/server';
import {processorArtifactIdentity} from '@etherfold/utils';
import {createClient} from '@libsql/client';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {declareEntities} from '@etherfold/state-store';
import {
	build,
	canonicalGenerationIn,
	heldGenerationsIn,
	index,
	node,
	run,
	type RunningIndexer,
	type RunningReceiver,
} from '../src/index.js';
import type {StartGuardDependencies} from '../src/startGuard.js';
import type {Options} from '../src/types.js';
import {uploadMain} from '../src/uploadCommand.js';
import {ALICE, BOB, CAROL, fakeChain, SOURCE, START_BLOCK, transfer, ZERO} from './utils/chain.js';
import {canonicalStoreIn} from './utils/reads.js';

// ---------------------------------------------------------------------------------------------------
// AN UPLOADED PROCESSOR SURVIVES A RESTART, including one still catching up
// ---------------------------------------------------------------------------------------------------
// Story 10 of `a-processor-artifact-is-pushed-to-a-running-deployment`: an upload is a
// DEPLOYMENT and not a session. Asserted END TO END against a real `etherfold node` and
// the real `etherfold upload`, over the committed REAL bundles
// (`fixtures/processor-bundle/`), in the shape
// `anUpgradingRestartKeepsTheIncumbentFolding.test.ts` stands up: a node is STOPPED and
// run again over the same database, and the restarted process has never been handed the
// uploaded bytes -- the only copy is on the registry row.
//
// The uploads used to go to a `run` started with nothing configured; since ADR-0094 that
// is `node`, and the cases moved to it. The `run -p` starts below are now `run` over a
// database a `node` wrote (ADR-0094's one database opened by both commands).
//
//  - an upload that is CANONICAL is instantiated from its stored bytes and goes on
//    folding (ADR-0092, ADR-0093);
//  - an upload that was still CATCHING UP (the `successor`) is instantiated too,
//    catches up, and is promoted under `on-catch-up` with nobody asking; the
//    incumbent's fold then stops (ADR-0092's amendment of 2026-09-26);
//  - a `run` started with a `--processor` over that database folds toward EXACTLY what
//    it names (ADR-0094): a different processor registers as the successor, the pending
//    successor itself changes nothing, and the CANONICAL processor DISCARDS a different
//    pending successor. A START may not SILENTLY delete a pending successor, by replacing
//    or by discarding it: interactive asks, non-interactive is refused unless
//    `--override` (ADR-0084's and ADR-0093's amendments). That holds for EVERY start
//    with a configured processor -- `run`, a re-run `build` and an `index` receiver --
//    because all three open the same container over the same slots;
//  - an upload (on `node`) still replaces a pending successor without a question.
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

/** The entity both fixture bundles write, as a reader of the artifact has to name it. */
const NFT = declareEntities([{name: 'nft', id: ['tokenID'], fields: {owner: 'text'}}]);
/** The one token the transfers below move, padded exactly as the handlers pad it. */
const TOKEN = {tokenID: '1'.padStart(78, '0')};
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
let receiving: RunningReceiver | undefined;

afterEach(async () => {
	await running?.stop().catch(() => undefined);
	running = undefined;
	await receiving?.stop().catch(() => undefined);
	receiving = undefined;
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

/** A `node`: the chain, the store and the database, and no processor and no source (ADR-0094). */
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

type StartExtras = {sleep?: ReturnType<typeof aParkableWait>['sleep']; startGuard?: StartGuardDependencies};

/** START a `node` over `db`, which may already hold generations: a restart, when it does. */
async function aNodeOver(
	db: RemoteSQL,
	chain: ReturnType<typeof fakeChain>,
	options: Options = NOTHING,
	extra: StartExtras = {},
): Promise<RunningIndexer> {
	return aStartOf(node, db, chain, options, extra);
}

/** START a configured `run` over `db`, which may hold what a `node` wrote there (ADR-0094). */
async function aRunOver(
	db: RemoteSQL,
	chain: ReturnType<typeof fakeChain>,
	options: Options & {processor: string},
	extra: StartExtras = {},
): Promise<RunningIndexer> {
	return aStartOf(run, db, chain, options, extra);
}

async function aStartOf(
	start: typeof run,
	db: RemoteSQL,
	chain: ReturnType<typeof fakeChain>,
	options: Options,
	extra: StartExtras,
): Promise<RunningIndexer> {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	running = await start(
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
 * A `node`, whose first upload folded to the tip and became canonical, and whose SECOND upload was still catching up when it stopped:
 * `successor` names it, with its bytes stored, and it has folded nothing.
 */
async function aNodeStoppedMidUpgrade(): Promise<{db: RemoteSQL; incumbent: string; successor: string}> {
	const db = oneDatabase();
	const wait = aParkableWait();
	const first = await aNodeOver(db, fakeChain().serve(LOGS, TIP), NOTHING, {sleep: wait.sleep});
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

/**
 * A `node` whose first upload is canonical and whose SECOND upload CAUGHT UP beside it under `manual` and was
 * not promoted: `successor` names it, with its bytes stored and its own state tables written, so its deletion is
 * something the rows can show.
 */
async function aNodeWithACaughtUpPendingSuccessor(): Promise<{
	db: RemoteSQL;
	incumbent: string;
	successor: {digest: string; id: {stream: string; processor: string}};
}> {
	const db = oneDatabase();
	const first = await aNodeOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, promotion: 'manual'});
	expect((await uploadWith(first, BUNDLE)).code).toBe(0);
	const incumbent = (await digestOf(first, BUNDLE)) as string;
	await waitFor('the first upload folded to the tip', async () => (await positionOf(first, incumbent)) === TIP);
	expect((await uploadWith(first, EDITED_BUNDLE)).code).toBe(0);
	const digest = (await digestOf(first, EDITED_BUNDLE)) as string;
	await waitFor('the second upload caught up', async () => (await positionOf(first, digest)) === TIP);
	const listing = await listingOf(first);
	expect(listing.slots?.canonical?.digest).toBe(incumbent);
	expect(listing.slots?.successor?.digest).toBe(digest);
	const id = await identityOf(first, digest);
	await stop();
	return {db, incumbent, successor: {digest, id}};
}

/** The tables a generation's own namespace still has (ADR-0053: its state IS its namespace). */
async function namespaceTables(db: RemoteSQL, id: {stream: string; processor: string}): Promise<string[]> {
	const namespace = generationDigestOf(id);
	const rows = await db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
		.all<{name: string}>();
	return rows.results.map((row) => row.name).filter((table) => table.includes(namespace));
}

// ---------------------------------------------------------------------------------------------------

describe('an upload that is CANONICAL survives a restart of the `node`', () => {
	it('is instantiated from its stored bytes, and its cursor advances', async () => {
		const db = oneDatabase();
		const first = await aNodeOver(db, fakeChain().serve(LOGS, TIP));
		const sent = await uploadWith(first, BUNDLE);
		expect(sent.code, sent.err).toBe(0);
		const uploaded = (await digestOf(first, BUNDLE)) as string;
		await waitFor('the upload folded to the tip', async () => (await positionOf(first, uploaded)) === TIP);
		await stop();

		// the chain moves on while nothing runs, and the node comes back, configured with no code
		const restarted = await aNodeOver(db, fakeChain().serve(LATER, LATER_TIP));

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
		const restarted = await aNodeOver(db, fakeChain().serve(LATER, LATER_TIP), {...NOTHING, promotion: 'manual'});

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

		const restarted = await aNodeOver(db, chain);

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
		const again = await aNodeOver(db, fakeChain().serve(LATEST, LATEST_TIP));
		expect(foldedHere(again)).toEqual([(await identityOf(again, successor)).processor]);
		expect((await listingOf(again)).slots?.predecessor?.digest).toBe(incumbent);
	});
});

describe('a `run` with `--processor` over a database a `node` wrote folds toward exactly what it names', () => {
	it('registers a DIFFERENT processor as the successor, where nothing is pending', async () => {
		const db = oneDatabase();
		const first = await aNodeOver(db, fakeChain().serve(LOGS, TIP));
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

	it('changes nothing when it names the canonical processor with nothing pending, and asks nothing', async () => {
		const db = oneDatabase();
		const first = await aNodeOver(db, fakeChain().serve(LOGS, TIP));
		expect((await uploadWith(first, BUNDLE)).code).toBe(0);
		const uploaded = (await digestOf(first, BUNDLE)) as string;
		await stop();
		const asked: string[] = [];

		const restarted = await aRunOver(
			db,
			fakeChain().serve(LOGS, TIP),
			{...NOTHING, processor: BUNDLE},
			{startGuard: {interactive: true, confirm: async (question) => (asked.push(question), false)}},
		);

		expect(asked).toEqual([]);
		const listing = await listingOf(restarted);
		expect(listing.slots?.canonical?.digest).toBe(uploaded);
		expect(listing.slots?.successor).toBeUndefined();
		expect(listing.generations.map((entry) => entry.digest)).toEqual([uploaded]);
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

describe('a `run` naming the CANONICAL processor DISCARDS a different pending successor that arrived by upload (ADR-0094)', () => {
	it('is REFUSED by name when nobody can be asked, with nothing deleted', async () => {
		const {db, incumbent, successor} = await aNodeWithACaughtUpPendingSuccessor();

		await expect(aRunOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, processor: BUNDLE})).rejects.toThrow(
			new RegExp(
				`CANONICAL[\\s\\S]*DISCARD[\\s\\S]*${successor.digest}[\\s\\S]*REFUSED[\\s\\S]*--override to let this start discard it`,
			),
		);
		running = undefined;

		// the registry is exactly as it was: the upload is still pending, state and bytes and all
		expect(await namespaceTables(db, successor.id)).not.toEqual([]);
		const after = await aNodeOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, promotion: 'manual'});
		const listing = await listingOf(after);
		expect(listing.slots?.canonical?.digest).toBe(incumbent);
		expect(listing.slots?.successor?.digest).toBe(successor.digest);
		expect(listing.generations.map((entry) => entry.digest).sort()).toEqual([incumbent, successor.digest].sort());
		expect(await bundleStoredFor(db, successor.id.processor)).toBe(true);
	});

	it('discards it -- row, state and bytes -- under `--override`, never builds it, and the canonical generation keeps folding', async () => {
		const {db, incumbent, successor} = await aNodeWithACaughtUpPendingSuccessor();
		expect(await namespaceTables(db, successor.id)).not.toEqual([]);

		// `on-catch-up`, the default: the caught-up upload WOULD have been promoted, had it been left pending
		const restarted = await aRunOver(db, fakeChain().serve(LATER, LATER_TIP), {
			...NOTHING,
			processor: BUNDLE,
			override: true,
		});

		const listing = await listingOf(restarted);
		expect(listing.slots?.canonical?.digest).toBe(incumbent);
		expect(listing.slots?.successor).toBeUndefined();
		expect(listing.generations.map((entry) => entry.digest)).toEqual([incumbent]);
		expect(await bundleStoredFor(db, successor.id.processor)).toBe(false);
		expect(await namespaceTables(db, successor.id)).toEqual([]);
		// the discarded upload was never built into a fold: it went before `foldTheSuccessor`
		expect(foldedHere(restarted)).toEqual([processorArtifactIdentity(await bytesOf(BUNDLE))]);
		await waitFor(
			'the canonical generation folded on',
			async () => (await positionOf(restarted, incumbent)) === LATER_TIP,
		);
		expect((await listingOf(restarted)).slots?.canonical?.digest).toBe(incumbent);
	});

	it('ASKS when it can, naming both generations, and a no leaves everything as it was', async () => {
		const {db, incumbent, successor} = await aNodeWithACaughtUpPendingSuccessor();
		const asked: string[] = [];

		await expect(
			aRunOver(
				db,
				fakeChain().serve(LOGS, TIP),
				{...NOTHING, processor: BUNDLE},
				{startGuard: {interactive: true, confirm: async (question) => (asked.push(question), false)}},
			),
		).rejects.toThrow(/Declined/);
		running = undefined;

		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain(successor.digest);
		expect(asked[0]).toContain(incumbent);
		expect(asked[0]).toMatch(/DISCARD[\s\S]*Discard it\? \[y\/N\] $/);
		expect(asked[0]).not.toMatch(/REPLACES/);

		const after = await aNodeOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, promotion: 'manual'});
		expect((await listingOf(after)).slots?.successor?.digest).toBe(successor.digest);
		expect(await bundleStoredFor(db, successor.id.processor)).toBe(true);
	});

	it('and a yes discards it', async () => {
		const {db, incumbent, successor} = await aNodeWithACaughtUpPendingSuccessor();

		const restarted = await aRunOver(
			db,
			fakeChain().serve(LOGS, TIP),
			{...NOTHING, processor: BUNDLE},
			{startGuard: {interactive: true, confirm: async () => true}},
		);

		const listing = await listingOf(restarted);
		expect(listing.slots?.canonical?.digest).toBe(incumbent);
		expect(listing.slots?.successor).toBeUndefined();
		expect(listing.generations.map((entry) => entry.digest)).toEqual([incumbent]);
		expect(await bundleStoredFor(db, successor.id.processor)).toBe(false);
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
		const after = await aNodeOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, promotion: 'manual'});
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

		const after = await aNodeOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, promotion: 'manual'});
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

describe('the deliberate arrival on a RUNNING node still replaces a pending successor without a question', () => {
	it('an upload to a `node` replaces it, and nobody is asked', async () => {
		const db = oneDatabase();
		const indexer = await aNodeOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, promotion: 'manual'});
		expect((await uploadWith(indexer, BUNDLE)).code).toBe(0);

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
		const listing = await listingOf(indexer);
		expect(listing.slots?.successor?.digest).toBe(thirdDigest);
		expect(listing.generations.map((entry) => entry.digest)).not.toContain(edited);
	});
});

describe('a re-run `build` and an `index` receiver are STARTS too, guarded the same way, and discard the same way', () => {
	/** `etherfold build` over `db`: a one-shot to the tip, never the terminal. */
	async function aBuildOver(db: RemoteSQL, processor: string, extra: Options = {}): Promise<void> {
		await build(
			{nodeUrl: 'http://localhost:0', store: 'sqlite', db: ':memory:', indexer: INDEXER, processor, ...extra},
			{
				provider: fakeChain().serve(LOGS, TIP).provider,
				createDB: () => db,
				env: {MAX_BLOCKS_PER_FETCH: '20'},
				startGuard: {interactive: false},
			},
		);
	}

	/** `etherfold index` over `db`, on an explicit source, never the terminal. */
	async function anIndexOver(db: RemoteSQL, processor: string, extra: Options = {}): Promise<RunningReceiver> {
		process.env.ADMIN_TOKEN = ADMIN_TOKEN;
		receiving = await index(
			{store: 'sqlite', db: ':memory:', port: '0', processor, ...extra},
			{
				createDB: () => db,
				handleSignals: false,
				log: () => {},
				env: {INDEXING_SOURCE: JSON.stringify(SOURCE), INGEST_TOKEN: 'a-shared-secret', INDEXER_NAME: INDEXER},
				rebuildIntervalSeconds: 0,
				pruneIntervalSeconds: 0,
				startGuard: {interactive: false},
			},
		);
		return receiving;
	}

	/** Read the registry back through a `node`, which changes nothing in it. */
	async function whatTheRegistryHolds(
		db: RemoteSQL,
	): Promise<{listing: Listing; storedFor: (bundle: string) => Promise<boolean>}> {
		const after = await aNodeOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, promotion: 'manual'});
		const listing = await listingOf(after);
		return {
			listing,
			storedFor: async (bundle) => bundleStoredFor(db, processorArtifactIdentity(await bytesOf(bundle))),
		};
	}

	for (const [command, start] of [
		['build', (db: RemoteSQL, processor: string, extra?: Options) => aBuildOver(db, processor, extra)],
		[
			'index',
			async (db: RemoteSQL, processor: string, extra?: Options) => {
				await anIndexOver(db, processor, extra);
				await receiving?.stop();
				receiving = undefined;
			},
		],
	] as const) {
		it(`\`${command}\` is REFUSED by name when nobody can be asked, with the registry, slots and bytes unchanged`, async () => {
			const {db, incumbent, successor} = await aNodeStoppedMidUpgrade();
			const third = await aThirdBundle();

			await expect(start(db, third)).rejects.toThrow(new RegExp(`${successor}[\\s\\S]*REFUSED[\\s\\S]*--override`));
			receiving = undefined;

			const {listing, storedFor} = await whatTheRegistryHolds(db);
			expect(listing.slots?.canonical?.digest).toBe(incumbent);
			expect(listing.slots?.successor?.digest).toBe(successor);
			expect(listing.generations.map((entry) => entry.digest).sort()).toEqual([incumbent, successor].sort());
			expect(await storedFor(EDITED_BUNDLE)).toBe(true);
			expect(await storedFor(third)).toBe(false);
		});

		it(`\`${command}\` replaces it -- row, state and bytes -- under \`--override\``, async () => {
			const {db, successor} = await aNodeStoppedMidUpgrade();
			const third = await aThirdBundle();

			await start(db, third, {override: true});

			const {listing, storedFor} = await whatTheRegistryHolds(db);
			expect(listing.generations.map((entry) => entry.digest)).not.toContain(successor);
			expect(await storedFor(EDITED_BUNDLE)).toBe(false);
			expect(await storedFor(third)).toBe(true);
		});

		it(`\`${command}\` naming the CANONICAL processor is REFUSED by name when nobody can be asked, with nothing deleted`, async () => {
			const {db, incumbent, successor} = await aNodeWithACaughtUpPendingSuccessor();

			await expect(start(db, BUNDLE)).rejects.toThrow(
				new RegExp(`CANONICAL[\\s\\S]*DISCARD[\\s\\S]*${successor.digest}[\\s\\S]*REFUSED[\\s\\S]*--override`),
			);
			receiving = undefined;

			expect(await namespaceTables(db, successor.id)).not.toEqual([]);
			const {listing, storedFor} = await whatTheRegistryHolds(db);
			expect(listing.slots?.canonical?.digest).toBe(incumbent);
			expect(listing.slots?.successor?.digest).toBe(successor.digest);
			expect(await storedFor(EDITED_BUNDLE)).toBe(true);
		});

		it(`\`${command}\` naming the CANONICAL processor DISCARDS it -- row, state and bytes -- under \`--override\``, async () => {
			const {db, incumbent, successor} = await aNodeWithACaughtUpPendingSuccessor();

			await start(db, BUNDLE, {override: true});

			expect(await namespaceTables(db, successor.id)).toEqual([]);
			const {listing, storedFor} = await whatTheRegistryHolds(db);
			expect(listing.slots?.canonical?.digest).toBe(incumbent);
			expect(listing.slots?.successor).toBeUndefined();
			expect(listing.generations.map((entry) => entry.digest)).toEqual([incumbent]);
			expect(await storedFor(EDITED_BUNDLE)).toBe(false);
		});
	}

	it('a re-run `build -p v1 --override` over a database with a pending, caught-up `v2` publishes an artifact serving `v1`', async () => {
		const {db, successor} = await aNodeWithACaughtUpPendingSuccessor();
		const v1 = processorArtifactIdentity(await bytesOf(BUNDLE));

		await aBuildOver(db, BUNDLE, {override: true});

		// read back after the process exited, through the pointer, as a reader of the artifact resolves it
		expect((await canonicalGenerationIn(db, {indexer: INDEXER}))?.processor).toBe(v1);
		expect((await heldGenerationsIn(db))[0]?.generations.map((record) => record.processor)).toEqual([v1]);
		expect(await namespaceTables(db, successor.id)).toEqual([]);
		// `nfts.bundle.js` credits the RECIPIENT of the last transfer (BOB); the discarded
		// `nfts-edited.bundle.js` would have credited its SENDER (ALICE)
		const store = await canonicalStoreIn(db, NFT, {indexer: INDEXER});
		expect((await store.getCurrent<{owner: string}>('nft', TOKEN))?.owner).toBe(BOB.toLowerCase());
	});
});

// ---------------------------------------------------------------------------------------------------
// AN ARRIVAL OF THE PREDECESSOR RE-ARMS IT AS SUCCESSOR (ADR-0094)
// ---------------------------------------------------------------------------------------------------
// Sending the previous version to a `node` (`etherfold upload`), or starting `run` with
// it again (`-p`), is a ROLLBACK through the same catch-up-and-promote path every deploy
// takes: the generation `predecessor` names MOVES into `successor`, catches up from where
// its own state stood, and is promoted by the policy; what it replaced becomes
// `predecessor`, and nothing folds that one.
// ---------------------------------------------------------------------------------------------------

/** MOVE THE POINTER because an operator asked: the verb `manual` waits for. */
async function promote(indexer: RunningIndexer, digest: string): Promise<number> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		method: 'POST',
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json'},
		body: JSON.stringify(await identityOf(indexer, digest)),
	});
	return res.status;
}

/**
 * A `node` whose first upload (`nfts.bundle.js`) folded to the tip and whose SECOND
 * (`nfts-edited.bundle.js`) caught up and was PROMOTED over it, so `predecessor` names the
 * first. Stopped.
 */
async function aNodeUpgradedByUpload(): Promise<{db: RemoteSQL; v1: string; v2: string}> {
	const db = oneDatabase();
	const first = await aNodeOver(db, fakeChain().serve(LOGS, TIP));
	expect((await uploadWith(first, BUNDLE)).code).toBe(0);
	const v1 = (await digestOf(first, BUNDLE)) as string;
	await waitFor('the first upload folded to the tip', async () => (await positionOf(first, v1)) === TIP);
	expect((await uploadWith(first, EDITED_BUNDLE)).code).toBe(0);
	const v2 = (await digestOf(first, EDITED_BUNDLE)) as string;
	await waitFor('the second upload was promoted', async () => (await listingOf(first)).slots?.canonical?.digest === v2);
	expect((await listingOf(first)).slots?.predecessor?.digest).toBe(v1);
	await stop();
	return {db, v1, v2};
}

/** A `run -p v1` that `run -p v2` restarted and promoted over, so `predecessor` names `v1`. Stopped. */
async function aRunUpgradedByRestart(): Promise<{db: RemoteSQL; v1: string; v2: string}> {
	const db = oneDatabase();
	const first = await aRunOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, processor: BUNDLE});
	const v1 = (await digestOf(first, BUNDLE)) as string;
	await waitFor('v1 folded to the tip', async () => (await positionOf(first, v1)) === TIP);
	await stop();
	const second = await aRunOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, processor: EDITED_BUNDLE});
	const v2 = (await digestOf(second, EDITED_BUNDLE)) as string;
	await waitFor('v2 was promoted', async () => (await listingOf(second)).slots?.canonical?.digest === v2);
	expect((await listingOf(second)).slots?.predecessor?.digest).toBe(v1);
	await stop();
	return {db, v1, v2};
}

/** What a rollback onto `v1` leaves: `v1` canonical, `v2` the predecessor, nothing pending, and only `v1` folded. */
async function expectRolledBack(indexer: RunningIndexer, v1: string, v2: string): Promise<void> {
	const listing = await listingOf(indexer);
	expect(listing.slots?.canonical?.digest).toBe(v1);
	expect(listing.slots?.predecessor?.digest).toBe(v2);
	expect(listing.slots?.successor).toBeUndefined();
	expect(listing.generations.map((entry) => entry.digest).sort()).toEqual([v1, v2].sort());
	// NO ENGINE runs for the generation `predecessor` names
	expect(foldedHere(indexer)).toEqual([(await identityOf(indexer, v1)).processor]);
}

describe('`etherfold upload` of the PREDECESSOR`s bundle rolls a `node` back onto it', () => {
	it('moves it into `successor`, where it catches up from where it stood, and the next process promotes it', async () => {
		const {db, v1, v2} = await aNodeUpgradedByUpload();
		// the chain moved on while nothing ran, so the restarted canonical `v2` folds past
		// where `v1` stood, and a re-armed `v1` has something to catch up
		const wait = aParkableWait();
		const restarted = await aNodeOver(db, fakeChain().serve(LATER, LATER_TIP), NOTHING, {sleep: wait.sleep});
		await waitFor('v2 folded the later block', async () => (await positionOf(restarted, v2)) === LATER_TIP);
		expect(foldedHere(restarted)).toEqual([(await identityOf(restarted, v2)).processor]);
		expect(await positionOf(restarted, v1)).toBe(TIP);

		// PARKED, so the re-arm is read before the catch-up can promote it
		wait.state.parked = true;
		await waitFor('the drive loop parked', async () => wait.state.parkedNow);
		const sent = await uploadWith(restarted, BUNDLE);

		expect(sent.code, sent.err).toBe(0);
		expect(sent.out).toMatch(/\bregistered\b/);
		expect(sent.out).toContain(v1);
		const armed = await listingOf(restarted);
		expect(armed.slots?.successor?.digest).toBe(v1);
		expect(armed.slots?.predecessor).toBeUndefined();
		expect(armed.slots?.canonical?.digest).toBe(v2);
		await stop();

		// ...and the next process takes it the rest of the way, as it would any successor
		const again = await aNodeOver(db, fakeChain().serve(LATER, LATER_TIP));
		await waitFor('v1 was promoted', async () => (await listingOf(again)).slots?.canonical?.digest === v1);
		expect(await positionOf(again, v1)).toBe(LATER_TIP);
		await expectRolledBack(again, v1, v2);
	});

	it('promotes it in the running process, with nobody asking', async () => {
		const {db, v1, v2} = await aNodeUpgradedByUpload();
		const restarted = await aNodeOver(db, fakeChain().serve(LATER, LATER_TIP));

		expect((await uploadWith(restarted, BUNDLE)).code).toBe(0);

		await waitFor('v1 was promoted', async () => (await listingOf(restarted)).slots?.canonical?.digest === v1);
		await waitFor('v1 caught up', async () => (await positionOf(restarted, v1)) === LATER_TIP);
		await expectRolledBack(restarted, v1, v2);
	});

	it('waits in `successor` under `manual`, folded and caught up, and is promoted only when asked', async () => {
		const {db, v1, v2} = await aNodeUpgradedByUpload();
		const restarted = await aNodeOver(db, fakeChain().serve(LATER, LATER_TIP), {...NOTHING, promotion: 'manual'});

		expect((await uploadWith(restarted, BUNDLE)).code).toBe(0);
		await waitFor('v1 caught up', async () => (await positionOf(restarted, v1)) === LATER_TIP);
		await new Promise((resolve) => setTimeout(resolve, 50));

		const waiting = await listingOf(restarted);
		expect(waiting.slots?.canonical?.digest).toBe(v2);
		expect(waiting.slots?.successor?.digest).toBe(v1);
		expect(waiting.slots?.predecessor).toBeUndefined();
		expect(foldedHere(restarted)).toContain((await identityOf(restarted, v1)).processor);

		expect(await promote(restarted, v1)).toBe(200);
		await expectRolledBack(restarted, v1, v2);
	});
});

describe('a `run` whose `-p` names the PREDECESSOR re-arms it: a rollback by configuration (ADR-0094)', () => {
	for (const [how, upgraded] of [
		['after a `run -p v2` restart promoted v2', aRunUpgradedByRestart],
		['after an upload to a `node` over the same database promoted v2', aNodeUpgradedByUpload],
	] as const) {
		it(`re-arms v1 and promotes it back, asking nothing, ${how}`, async () => {
			const {db, v1, v2} = await upgraded();
			const asked: string[] = [];

			const restarted = await aRunOver(
				db,
				fakeChain().serve(LATER, LATER_TIP),
				{...NOTHING, processor: BUNDLE},
				{startGuard: {interactive: true, confirm: async (question) => (asked.push(question), false)}},
			);

			// nothing was pending, so there was nothing to ask
			expect(asked).toEqual([]);
			await waitFor('v1 was promoted', async () => (await listingOf(restarted)).slots?.canonical?.digest === v1);
			await waitFor('v1 caught up', async () => (await positionOf(restarted, v1)) === LATER_TIP);
			await expectRolledBack(restarted, v1, v2);
		});
	}

	it('waits in `successor` under `manual`', async () => {
		const {db, v1, v2} = await aRunUpgradedByRestart();

		const restarted = await aRunOver(db, fakeChain().serve(LOGS, TIP), {
			...NOTHING,
			processor: BUNDLE,
			promotion: 'manual',
		});

		const listing = await listingOf(restarted);
		expect(listing.slots?.canonical?.digest).toBe(v2);
		expect(listing.slots?.successor?.digest).toBe(v1);
		expect(listing.slots?.predecessor).toBeUndefined();
	});

	it('is guarded by the start guard where a DIFFERENT generation is pending: refused by name, with nothing changed', async () => {
		const {db, v1, v2} = await aNodeUpgradedByUpload();
		const third = await aThirdBundle();
		const pending = await aNodeOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, promotion: 'manual'});
		expect((await uploadWith(pending, third)).code).toBe(0);
		const v3 = (await digestOf(pending, third)) as string;
		await stop();

		await expect(aRunOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, processor: BUNDLE})).rejects.toThrow(
			new RegExp(`${v3}[\\s\\S]*REFUSED[\\s\\S]*--override to let this start replace it`),
		);
		running = undefined;

		const after = await aNodeOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, promotion: 'manual'});
		const listing = await listingOf(after);
		expect(listing.slots?.canonical?.digest).toBe(v2);
		expect(listing.slots?.successor?.digest).toBe(v3);
		expect(listing.slots?.predecessor?.digest).toBe(v1);
		expect(await bundleStoredFor(db, processorArtifactIdentity(await bytesOf(third)))).toBe(true);
	});

	it('replaces the different pending generation under `--override`, and rolls back onto v1', async () => {
		const {db, v1, v2} = await aNodeUpgradedByUpload();
		const third = await aThirdBundle();
		const pending = await aNodeOver(db, fakeChain().serve(LOGS, TIP), {...NOTHING, promotion: 'manual'});
		expect((await uploadWith(pending, third)).code).toBe(0);
		await stop();

		const restarted = await aRunOver(db, fakeChain().serve(LOGS, TIP), {
			...NOTHING,
			processor: BUNDLE,
			override: true,
		});

		await waitFor('v1 was promoted', async () => (await listingOf(restarted)).slots?.canonical?.digest === v1);
		await expectRolledBack(restarted, v1, v2);
		expect(await bundleStoredFor(db, processorArtifactIdentity(await bytesOf(third)))).toBe(false);
	});
});
