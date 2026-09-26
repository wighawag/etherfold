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
import {ALICE, BOB, CAROL, fakeChain, nftProcessor, START_BLOCK, transfer, ZERO} from './utils/chain.js';
import {canonicalStoreIn} from './utils/reads.js';

// ---------------------------------------------------------------------------------------------------
// AN UPGRADING RESTART KEEPS THE INCUMBENT FOLDING while the successor catches up
// ---------------------------------------------------------------------------------------------------
// ADR-0092's upgrade window, asserted END TO END in the shape
// `aRestartFinishesTheUpgrade.test.ts` stands up: a deployment folds under one
// bundle, is STOPPED, and is run again over the same database with an edited one.
// The restarted process was never handed the original bundle; the only copy of
// the incumbent's code is on its registry row.
//
// Before this, the incumbent answered every read during the catch-up from a state
// nothing advanced, because nothing in the process could fold it: the upgrade
// window was a window of stale answers. Now the canonical generation (and only
// it) is instantiated from its stored bundle at open, and folds until the pointer
// leaves it. So the claims are:
//
//   it MOVES     the chain moves on during the upgrade, and the incumbent's
//                cursor and answers move with it, by ITS OWN handler;
//   it FINISHES  the successor is still promoted when it catches up, and the
//                incumbent stops being folded once the pointer has left it.
//
// The bundles are the committed pair (`fixtures/processor-bundle/`), which differ
// in ONE handler line: `nfts.bundle.js` credits a token to its recipient,
// `nfts-edited.bundle.js` to its sender -- which is what tells "the incumbent
// folded it" from "some fold advanced something".
// ---------------------------------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL('./fixtures/processor-bundle/', import.meta.url));
/** The incumbent's code: credits `to`. */
const BUNDLE = join(FIXTURES, 'nfts.bundle.js');
/** The upgrade: credits `from`. */
const EDITED_BUNDLE = join(FIXTURES, 'nfts-edited.bundle.js');

const INDEXER = 'nfts';
const ADMIN_TOKEN = 'the-operators-own-secret';

const TOKEN = 1n;
const TOKEN_KEY = TOKEN.toString().padStart(78, '0');

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, TOKEN),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, TOKEN),
];
const TIP = START_BLOCK + 50;
/** What the chain does DURING the upgrade: BOB hands the token to CAROL. */
const LATER = [...LOGS, transfer(START_BLOCK + 70, '0xa70', BOB, CAROL, TOKEN)];
const LATER_TIP = START_BLOCK + 100;
/** ...and after it: CAROL hands it back to ALICE. */
const LATEST = [...LATER, transfer(START_BLOCK + 120, '0xa120', CAROL, ALICE, TOKEN)];
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

/** ONE path a deployment is pointed at, whose bytes a redeploy replaces. */
async function aProcessorPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-upgrade-window-'));
	scratch.push(dir);
	const path = join(dir, 'processor.bundle.js');
	await copyFile(BUNDLE, path);
	return path;
}

function optionsFor(processor: string, extra?: Partial<Options>): Options {
	return {
		processor,
		nodeUrl: 'http://localhost:0',
		store: 'sqlite',
		db: ':memory:',
		port: '0',
		indexer: INDEXER,
		...extra,
	};
}

/** START a deployment over a database that may already hold generations: a restart, when it does. */
async function aRunOver(
	db: RemoteSQL,
	processorPath: string,
	chain: ReturnType<typeof fakeChain>,
	extra?: Partial<Options>,
): Promise<RunningIndexer> {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	running = await run(optionsFor(processorPath, extra), {
		provider: chain.provider,
		createDB: () => db,
		sleep: async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
		},
		handleSignals: false,
		log: () => {},
		env: {MAX_BLOCKS_PER_FETCH: '20'},
	});
	return running;
}

async function stop(): Promise<void> {
	await running?.stop().catch(() => undefined);
	running = undefined;
}

type Listing = {generations: {digest: string; canonical: boolean; stream: string; processor: string}[]};

async function listingOf(indexer: RunningIndexer): Promise<Listing> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
	});
	expect(res.status).toBe(200);
	return (await res.json()) as Listing;
}

async function canonicalOf(indexer: RunningIndexer): Promise<string | undefined> {
	return (await listingOf(indexer)).generations.find((entry) => entry.canonical)?.digest;
}

async function identityOf(indexer: RunningIndexer, digest: string): Promise<{stream: string; processor: string}> {
	const target = (await listingOf(indexer)).generations.find((entry) => entry.digest === digest);
	if (!target) throw new Error(`this deployment holds no generation ${digest}`);
	return {stream: target.stream, processor: target.processor};
}

/** MOVE THE POINTER because an operator asked, through the authenticated admin route (ADR-0057). */
async function pointAt(indexer: RunningIndexer, digest: string): Promise<number> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		method: 'POST',
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json'},
		body: JSON.stringify(await identityOf(indexer, digest)),
	});
	return res.status;
}

/** How far ONE generation has folded, read from its own namespace, as the promotion trigger reads it. */
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

/** WHO OWNS the token, in whatever generation answers reads -- through the pointer, as a reader asks. */
async function ownerAnswered(db: RemoteSQL): Promise<string | undefined> {
	const store = await canonicalStoreIn(db, nftProcessor.entities, {indexer: INDEXER});
	return (await store.getCurrent<{owner: string}>('nft', {tokenID: TOKEN_KEY}))?.owner;
}

/**
 * A deployment that folded under `nfts.bundle.js` to the tip, STOPPED, and
 * running again over the same database under `nfts-edited.bundle.js` alone.
 */
async function aRestartWithAChangedProcessor(extra?: Partial<Options>): Promise<{
	db: RemoteSQL;
	chain: ReturnType<typeof fakeChain>;
	indexer: RunningIndexer;
	incumbent: string;
	successor: string;
}> {
	const db = oneDatabase();
	const path = await aProcessorPath();
	const first = await aRunOver(db, path, fakeChain().serve(LOGS, TIP));
	await waitFor(
		'the first deployment folded to the tip',
		async () => (await positionOf(first, (await canonicalOf(first))!)) === TIP,
	);
	const incumbent = (await canonicalOf(first)) as string;
	await stop();

	// THE REDEPLOY: new bytes at the same path, and a process that has never seen the old ones
	await copyFile(EDITED_BUNDLE, path);
	const chain = fakeChain().serve(LOGS, TIP);
	const indexer = await aRunOver(db, path, chain, extra);
	const successor = (await listingOf(indexer)).generations
		.map((entry) => entry.digest)
		.find((one) => one !== incumbent);
	expect(successor, 'the restart registered no successor').toBeDefined();
	return {db, chain, indexer, incumbent, successor: successor as string};
}

// ---------------------------------------------------------------------------------------------------

describe('during an upgrading restart the incumbent goes on FOLDING', () => {
	it('advances the incumbent, with its own code, while the successor catches up beside it', async () => {
		// `manual`, so the pointer stays on the incumbent for as long as the assertion needs:
		// what is asserted is that the generation answering reads is not frozen, however
		// long the upgrade window lasts
		const {db, chain, indexer, incumbent, successor} = await aRestartWithAChangedProcessor({promotion: 'manual'});
		const incumbentId = await identityOf(indexer, incumbent);
		// the incumbent is folded here, though this process was built with the edited bundle alone
		expect(foldedHere(indexer).sort()).toEqual(
			[incumbentId.processor, (await identityOf(indexer, successor)).processor].sort(),
		);
		expect(await positionOf(indexer, incumbent)).toBe(TIP);
		expect(await ownerAnswered(db)).toBe(BOB.toLowerCase());

		// the chain moves on DURING the upgrade
		chain.serve(LATER, LATER_TIP);
		await waitFor('the incumbent advanced past where it stood', async () => {
			const now = await positionOf(indexer, incumbent);
			return now !== undefined && now > TIP;
		});

		// the reads it answers moved, by the INCUMBENT's handler: it credits the recipient,
		// so CAROL owns the token; the edited code would have answered BOB
		expect(await canonicalOf(indexer)).toBe(incumbent);
		await waitFor(
			'the incumbent answered the new transfer',
			async () => (await ownerAnswered(db)) === CAROL.toLowerCase(),
		);

		// `manual` still means only when asked, and asking finishes the upgrade: the
		// incumbent is no longer folded once the pointer has left it
		await waitFor('the successor caught the incumbent up', async () => {
			const behind = await positionOf(indexer, successor);
			const ahead = await positionOf(indexer, incumbent);
			return behind !== undefined && ahead !== undefined && behind >= ahead;
		});
		expect(await pointAt(indexer, successor)).toBe(200);
		expect(foldedHere(indexer)).toEqual([(await identityOf(indexer, successor)).processor]);
	});

	it('reports the HELD incumbent on `/status` exactly as before, and names it canonical and held beside it', async () => {
		// The no-regression half of `status-says-when-the-canonical-generation-is-frozen`:
		// here the canonical generation IS folded, so everything `/status` said before is
		// said the same way, and the added `canonical` report agrees with it.
		const {indexer, incumbent, successor} = await aRestartWithAChangedProcessor({promotion: 'manual'});
		await waitFor('the incumbent reported where it stands', async () => (await positionOf(indexer, incumbent)) === TIP);

		const status = (await (await fetch(`${indexer.url}/status`)).json()) as {
			cursor: {
				reported: boolean;
				value?: {lastToBlock: number};
				generations?: Record<string, unknown>[];
				canonical?: Record<string, unknown>;
			};
		};
		const {cursor} = status;
		// the per-generation list keeps ADR-0047's meaning: one entry per fold HELD, and
		// each entry carries exactly the four keys it always did
		expect(cursor.generations?.map((entry) => entry.generation).sort()).toEqual([incumbent, successor].sort());
		for (const entry of cursor.generations ?? []) {
			expect(Object.keys(entry).filter((key) => key !== 'value')).toEqual(['generation', 'canonical', 'follows']);
		}
		const held = cursor.generations?.find((entry) => entry.generation === incumbent);
		expect(held).toMatchObject({canonical: true, follows: true});
		// the top-level value is the canonical fold's, as it was
		expect(cursor.reported).toBe(true);
		expect(cursor.value).toEqual(held?.value);
		// ...and the canonical report says the same thing in the admin listing's words
		expect(cursor.canonical).toEqual({generation: incumbent, folding: 'held', value: held?.value});
	});
});

describe('the upgrade still FINISHES, against an incumbent that moves', () => {
	it('promotes the successor with nobody asking, and then stops folding the incumbent', async () => {
		const {db, chain, indexer, incumbent, successor} = await aRestartWithAChangedProcessor();

		// the chain moves while the successor is catching up, so the cursor it has to
		// reach is a moving one
		chain.serve(LATER, LATER_TIP);
		await waitFor('the successor was promoted', async () => (await canonicalOf(indexer)) === successor);
		expect(foldedHere(indexer)).toEqual([(await identityOf(indexer, successor)).processor]);
		const incumbentStood = await positionOf(indexer, incumbent);

		// ...and after it, only the generation the pointer names advances. The incumbent is
		// KEPT, so a revert is still one write away.
		chain.serve(LATEST, LATEST_TIP);
		await waitFor('the promoted successor answered the latest transfer', async () => {
			const now = await positionOf(indexer, successor);
			return now !== undefined && now >= LATEST_TIP - 20;
		});
		// the edited handler credits the SENDER of the latest transfer
		await waitFor(
			'the successor folded the latest transfer',
			async () => (await ownerAnswered(db)) === CAROL.toLowerCase(),
		);
		expect(await positionOf(indexer, incumbent)).toBe(incumbentStood);
		expect((await listingOf(indexer)).generations.map((entry) => entry.digest).sort()).toEqual(
			[incumbent, successor].sort(),
		);
	});
});

describe('a restart that already holds the canonical fold is UNCHANGED', () => {
	it('folds exactly the generation it was built with, and nothing is instantiated beside it', async () => {
		const db = oneDatabase();
		const path = await aProcessorPath();
		const first = await aRunOver(db, path, fakeChain().serve(LOGS, TIP));
		await waitFor(
			'the first deployment folded to the tip',
			async () => (await positionOf(first, (await canonicalOf(first))!)) === TIP,
		);
		const incumbent = (await canonicalOf(first)) as string;
		await stop();

		const chain = fakeChain().serve(LOGS, TIP);
		const restarted = await aRunOver(db, path, chain);

		expect(await canonicalOf(restarted)).toBe(incumbent);
		expect(foldedHere(restarted)).toEqual([(await identityOf(restarted, incumbent)).processor]);
		chain.serve(LATER, LATER_TIP);
		await waitFor('the restarted deployment advanced', async () => (await ownerAnswered(db)) === CAROL.toLowerCase());
	});
});
