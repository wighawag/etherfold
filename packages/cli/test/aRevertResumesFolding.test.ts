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
// A REVERT RESUMES FOLDING, because the generation reverted to is instantiated from its stored bundle
// ---------------------------------------------------------------------------------------------------
// ADR-0092's headline, asserted END TO END and deliberately not at a seam: an
// operator upgrades a Node deployment, the new processor turns out to be wrong,
// they revert -- and the deployment goes on INDEXING. Before this, the pointer
// moved back, the old state answered reads, and nothing ever advanced it again,
// because a process redeployed with the new processor holds no engine for the
// generation it has just reverted to.
//
// So the shape is the one a real operator is in, and every step of it matters:
//
//   UPGRADE     a deployment folds under one bundle, and is redeployed under an
//               edited one; the successor catches up and is promoted;
//   RESTART     the process that performs the revert was built with the NEW
//               bundle ALONE -- the old code is not in it anywhere, only on the
//               generation's registry row;
//   REVERT      the operator moves the pointer back through the authenticated
//               admin route (ADR-0057);
//   ADVANCE     the chain moves on, and the reverted-to generation FOLDS it, with
//               its OWN handler -- which is what tells "it resumed" from "some fold
//               advanced something".
//
// Asserting that bytes were LOADED would prove the loader and nothing about the
// recovery, which is why the claims below are about a cursor that moves past
// where the reverted-to generation stood and about a row only its code writes.
//
// The bundles are the committed pair (`fixtures/processor-bundle/`), which differ
// in ONE handler line: `nfts.bundle.js` credits a token to its recipient,
// `nfts-edited.bundle.js` to its sender. Real bytes, built once, so what is
// instantiated from the registry row is exactly what a deployment ships.
// ---------------------------------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL('./fixtures/processor-bundle/', import.meta.url));
/** The code the operator reverts TO: credits `to`. */
const BUNDLE = join(FIXTURES, 'nfts.bundle.js');
/** The code the operator reverts AWAY from: credits `from`. */
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
/** What the chain does AFTER the revert: BOB hands the token to CAROL. */
const LATER = [...LOGS, transfer(START_BLOCK + 70, '0xa70', BOB, CAROL, TOKEN)];
const LATER_TIP = START_BLOCK + 100;

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
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-revert-'));
	scratch.push(dir);
	const path = join(dir, 'processor.bundle.js');
	await copyFile(BUNDLE, path);
	return path;
}

function optionsFor(processor: string): Options {
	return {
		processor,
		nodeUrl: 'http://localhost:0',
		store: 'sqlite',
		db: ':memory:',
		port: '0',
		indexer: INDEXER,
	};
}

/** START a deployment over a database that may already hold generations: a restart, when it does. */
async function aRunOver(db: RemoteSQL, processorPath: string, chain: ReturnType<typeof fakeChain>) {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	running = await run(optionsFor(processorPath), {
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

/** THE REVERT, as an operator performs it: the authenticated admin route (ADR-0057). */
async function pointAt(indexer: RunningIndexer, digest: string): Promise<{status: number; body: any}> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		method: 'POST',
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json'},
		body: JSON.stringify(await identityOf(indexer, digest)),
	});
	return {status: res.status, body: await res.json()};
}

/** How far ONE generation has folded, read from its own namespace with no engine involved. */
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
 * UPGRADE, then RESTART with only the new code: a deployment that folded under
 * `nfts.bundle.js`, was redeployed under `nfts-edited.bundle.js`, and has promoted
 * the successor. The process returned was never handed the original bundle.
 */
async function anUpgradeOnTheNewCodeAlone(): Promise<{
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
	const indexer = await aRunOver(db, path, chain);
	const successor = (await listingOf(indexer)).generations
		.map((entry) => entry.digest)
		.find((one) => one !== incumbent);
	expect(successor, 'the redeploy registered no successor').toBeDefined();
	await waitFor('the successor was promoted', async () => (await canonicalOf(indexer)) === successor);
	return {db, chain, indexer, incumbent, successor: successor as string};
}

// ---------------------------------------------------------------------------------------------------

describe('a revert on a deployment built with the new code alone RESUMES folding', () => {
	it('advances the reverted-to generation past where it stood, with ITS OWN code', async () => {
		const {db, chain, indexer, incumbent, successor} = await anUpgradeOnTheNewCodeAlone();
		const incumbentId = await identityOf(indexer, incumbent);
		// the precondition that makes this a recovery and not a formality: nothing in this
		// process was built from the bundle the operator is about to revert to
		expect(foldedHere(indexer)).toEqual([(await identityOf(indexer, successor)).processor]);
		// the edited handler credits the SENDER, which is why the operator is reverting
		expect(await ownerAnswered(db)).toBe(ALICE.toLowerCase());
		const stood = await positionOf(indexer, incumbent);
		expect(stood).toBe(TIP);

		const reverted = await pointAt(indexer, incumbent);
		expect(reverted.status, JSON.stringify(reverted.body)).toBe(200);
		expect(await canonicalOf(indexer)).toBe(incumbent);
		// its own answers came back at once: a revert is still one pointer write
		expect(await ownerAnswered(db)).toBe(BOB.toLowerCase());

		// ...and then the chain moves on
		chain.serve(LATER, LATER_TIP);
		await waitFor('the reverted-to generation advanced past where it stood', async () => {
			const now = await positionOf(indexer, incumbent);
			return now !== undefined && now > (stood as number);
		});

		// it FOLDED the new transfer, and with the handler the operator chose: the
		// original bundle credits the recipient, so CAROL owns the token. The rejected
		// code would have answered BOB.
		expect(await canonicalOf(indexer)).toBe(incumbent);
		expect(await ownerAnswered(db)).toBe(CAROL.toLowerCase());
		const store = await canonicalStoreIn(db, nftProcessor.entities, {indexer: INDEXER});
		expect((await store.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value).toBe(LATER.length);
		expect(foldedHere(indexer)).toContain(incumbentId.processor);
	});

	it('stops folding the generation the operator REJECTED once the pointer leaves it', async () => {
		const {chain, indexer, incumbent, successor} = await anUpgradeOnTheNewCodeAlone();
		const rejectedStood = await positionOf(indexer, successor);

		expect((await pointAt(indexer, incumbent)).status).toBe(200);

		// the inverted state ADR-0092 names -- an engine for the rejected generation and
		// none for the one being served -- is gone: this process folds exactly what it serves
		expect(foldedHere(indexer)).toEqual([(await identityOf(indexer, incumbent)).processor]);

		chain.serve(LATER, LATER_TIP);
		await waitFor('the reverted-to generation reached the new tip', async () => {
			const now = await positionOf(indexer, incumbent);
			return now !== undefined && now > TIP;
		});
		// the rejected one is KEPT (a move forward again is still one write) and does not move
		expect(await positionOf(indexer, successor)).toBe(rejectedStood);
		expect((await listingOf(indexer)).generations.map((entry) => entry.digest).sort()).toEqual(
			[incumbent, successor].sort(),
		);
	});
});

describe('a stored bundle that cannot be instantiated REFUSES the revert, and changes nothing', () => {
	it('answers 409 naming why, leaves the pointer where it was, and the deployment keeps advancing', async () => {
		const {db, chain, indexer, incumbent, successor} = await anUpgradeOnTheNewCodeAlone();
		// the bytes on the reverted-to generation's row no longer build a processor: a
		// module that exports no factory at all
		await db
			.prepare(`UPDATE _generations SET bundle = ?1 WHERE processor = ?2`)
			.bind(new TextEncoder().encode('export const nothing = 1;\n'), (await identityOf(indexer, incumbent)).processor)
			.all();

		const refused = await pointAt(indexer, incumbent);

		expect(refused.status).toBe(409);
		expect(refused.body.error).toBe('generation-cannot-fold');
		expect(refused.body.message).toMatch(/could not be instantiated/);
		// the deployment is exactly as it was: the same generation answers and is folded
		expect(await canonicalOf(indexer)).toBe(successor);
		expect(foldedHere(indexer)).toEqual([(await identityOf(indexer, successor)).processor]);

		chain.serve(LATER, LATER_TIP);
		await waitFor('the generation still answering reads advanced', async () => {
			const now = await positionOf(indexer, successor);
			return now !== undefined && now > TIP;
		});
		expect(await positionOf(indexer, incumbent)).toBe(TIP);
	});
});
