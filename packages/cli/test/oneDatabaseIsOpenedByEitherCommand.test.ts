import {generationDigestOf} from '@etherfold/core';
import {UPLOAD_CONTENT_TYPE} from '@etherfold/server';
import {processorArtifactIdentity} from '@etherfold/utils';
import {createClient} from '@libsql/client';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {node, run, type RunningIndexer} from '../src/index.js';
import type {Options} from '../src/types.js';
import {abi, ALICE, BOB, CAROL, fakeChain, START_BLOCK, transfer, ZERO} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// ONE DATABASE IS OPENED BY EITHER COMMAND (ADR-0094, story 9)
// ---------------------------------------------------------------------------------------------------
// `run` is CONFIGURED and `node` RECEIVES, and nothing records in a database which of
// the two wrote it: each may open what the other left, and what happens is DEFINED by
// each command's one source of truth rather than by a mode stored on disk.
//
//  - `run` over a database a `node` wrote is an ordinary CONFIGURED start, under the
//    rules every configured start has: it folds toward exactly what `-p` names (a
//    different processor registers as the successor, and the canonical processor DISCARDS
//    a different pending one, behind the start guard). Those rules are asserted in
//    `anUploadedProcessorSurvivesARestart.test.ts`, not here.
//  - `node` over a database a `run` wrote instantiates the canonical generation from its
//    STORED bundle, over the contracts THAT BUNDLE carries (ADR-0093). Where `run` had
//    been given a source the bundle does not carry, that generation is on a stream the
//    `node` cannot name: it is served FROZEN with the reason, and the node waits for the
//    next upload. Measured before it was asserted: the stored bundle instantiates, its
//    source digests to a different stream, and the container reports the generation
//    `frozen` with `stream-not-fetched`.
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
/** What the chain does while one command has stopped and the other has not yet started. */
const LATER = [...LOGS, transfer(START_BLOCK + 70, '0xa70', BOB, CAROL, 1n)];
const LATER_TIP = START_BLOCK + 100;

/** A contract the committed bundles do NOT carry, for a `run` configured with a source of its own. */
const ELSEWHERE = '0x00000000000000000000000000000000000000ee';

let running: RunningIndexer | undefined;

afterEach(async () => {
	await running?.stop().catch(() => undefined);
	running = undefined;
	delete process.env.ADMIN_TOKEN;
});

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

const BASE: Options = {nodeUrl: 'http://localhost:0', store: 'sqlite', db: ':memory:', port: '0', indexer: INDEXER};

async function aStartOf(
	start: typeof run,
	db: RemoteSQL,
	chain: ReturnType<typeof fakeChain>,
	options: Options,
	env: Record<string, string> = {},
): Promise<RunningIndexer> {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	running = await start(
		{...BASE, ...options},
		{
			provider: chain.provider,
			createDB: () => db,
			sleep: async () => {
				await new Promise((resolve) => setTimeout(resolve, 1));
			},
			handleSignals: false,
			log: () => {},
			env: {MAX_BLOCKS_PER_FETCH: '20', ...env},
			startGuard: {interactive: false},
		},
	);
	return running;
}

async function stop(): Promise<void> {
	await running?.stop().catch(() => undefined);
	running = undefined;
}

const bytesOf = async (path: string): Promise<Uint8Array> => new Uint8Array(await readFile(path));

async function upload(indexer: RunningIndexer, bundle: string): Promise<{status: number; body: Record<string, any>}> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/upload`, {
		method: 'POST',
		headers: {'Content-Type': UPLOAD_CONTENT_TYPE, Authorization: `Bearer ${ADMIN_TOKEN}`},
		body: new Uint8Array(await bytesOf(bundle)),
	});
	return {status: res.status, body: (await res.json()) as Record<string, any>};
}

type Listing = {
	slots?: Record<string, {digest: string} | undefined>;
	generations: {digest: string; stream: string; processor: string; canonical: boolean; folding?: string}[];
};

async function listingOf(indexer: RunningIndexer): Promise<Listing> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
	});
	expect(res.status).toBe(200);
	return (await res.json()) as Listing;
}

async function statusOf(indexer: RunningIndexer): Promise<Record<string, any>> {
	return (await (await fetch(`${indexer.url}/status`)).json()) as Record<string, any>;
}

async function feedOf(indexer: RunningIndexer): Promise<{status: number; body: Record<string, any>}> {
	const res = await fetch(`${indexer.url}/${INDEXER}/feed`);
	return {status: res.status, body: (await res.json()) as Record<string, any>};
}

/** How far the canonical generation has folded, read from its own namespace with no engine. */
async function canonicalPositionOn(indexer: RunningIndexer): Promise<number | undefined> {
	const canonical = (await listingOf(indexer)).generations.find((entry) => entry.canonical);
	if (!canonical) return undefined;
	return indexer.container.registry.readStateCursor({stream: canonical.stream, processor: canonical.processor});
}

async function waitFor(what: string, done: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		if (await done()) return;
		if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// ---------------------------------------------------------------------------------------------------

describe('`run` over a database a `node` wrote is an ordinary configured start', () => {
	it('naming the uploaded processor, folds on from where the node left it, registering nothing', async () => {
		const db = oneDatabase();
		const written = await aStartOf(node, db, fakeChain().serve(LOGS, TIP), {});
		expect((await upload(written, BUNDLE)).status).toBe(200);
		await waitFor('the node folded its upload to the tip', async () => (await canonicalPositionOn(written)) === TIP);
		const uploaded = (await listingOf(written)).slots?.canonical?.digest;
		await stop();

		const configured = await aStartOf(run, db, fakeChain().serve(LATER, LATER_TIP), {processor: BUNDLE});

		// the processor its configuration names IS the canonical generation the node registered:
		// the same bytes, the same identity, so one generation and no second one
		const listing = await listingOf(configured);
		expect(listing.generations.map((entry) => entry.digest)).toEqual([uploaded]);
		expect(generationDigestOf(configured.container.generation)).toBe(uploaded);
		await waitFor(
			'the configured start folded past where the node stood',
			async () => (await canonicalPositionOn(configured)) === LATER_TIP,
		);
		expect((await feedOf(configured)).body.entries).toHaveLength(LATER.length);
		// ...and it is a CONFIGURED process: it receives no code
		expect((await upload(configured, EDITED_BUNDLE)).status).toBe(501);
	});

	it('naming a different processor, registers it as the successor beside the uploaded one', async () => {
		const db = oneDatabase();
		const written = await aStartOf(node, db, fakeChain().serve(LOGS, TIP), {});
		expect((await upload(written, BUNDLE)).status).toBe(200);
		const uploaded = (await listingOf(written)).slots?.canonical?.digest;
		await stop();

		const configured = await aStartOf(run, db, fakeChain().serve(LOGS, TIP), {
			processor: EDITED_BUNDLE,
			promotion: 'manual',
		});

		const listing = await listingOf(configured);
		expect(listing.slots?.canonical?.digest).toBe(uploaded);
		const editedIdentity = processorArtifactIdentity(await bytesOf(EDITED_BUNDLE));
		const edited = listing.generations.find((entry) => entry.processor === editedIdentity);
		expect(edited).toBeDefined();
		expect(listing.slots?.successor?.digest).toBe(edited?.digest);
		expect(listing.generations).toHaveLength(2);
	});
});

describe('`node` over a database a `run` wrote folds what the registry holds', () => {
	it('instantiates the canonical generation from its stored bundle, over the contracts it carries, and folds on', async () => {
		const db = oneDatabase();
		const written = await aStartOf(run, db, fakeChain().serve(LOGS, TIP), {processor: BUNDLE});
		await waitFor('the run folded to the tip', async () => (await canonicalPositionOn(written)) === TIP);
		const canonical = (await listingOf(written)).slots?.canonical?.digest;
		await stop();

		const receiving = await aStartOf(node, db, fakeChain().serve(LATER, LATER_TIP), {});

		// NOT waiting: it came up FOLDING what the `run` left, from the bytes stored for it
		expect(receiving.container.held().map((fold) => generationDigestOf(fold.record))).toEqual([canonical]);
		expect('waiting' in (await statusOf(receiving)).cursor).toBe(false);
		await waitFor('the node folded on past the tip the run left', async () => {
			return (await canonicalPositionOn(receiving)) === LATER_TIP;
		});
		const read = await feedOf(receiving);
		expect(read.status).toBe(200);
		expect(read.body.generation).toBe(canonical);
		expect(read.body.entries).toHaveLength(LATER.length);

		// ...and it RECEIVES: the next upload registers beside it
		const next = await upload(receiving, EDITED_BUNDLE);
		expect(next.status, JSON.stringify(next.body)).toBe(200);
		expect(next.body.outcome).toBe('registered');
	});

	it('serves FROZEN, with the reason, a generation `run` folded over a source its bundle does not carry, and waits', async () => {
		const db = oneDatabase();
		// the operator gave `run` a source of its OWN: a contract the bundle does not carry
		const configuredSource = JSON.stringify({
			chainId: '1',
			contracts: [{abi, address: ELSEWHERE, startBlock: START_BLOCK}],
		});
		const written = await aStartOf(
			run,
			db,
			fakeChain().serve(LOGS, TIP),
			{processor: BUNDLE},
			{INDEXING_SOURCE: configuredSource},
		);
		await waitFor('the run folded to the tip', async () => (await canonicalPositionOn(written)) === TIP);
		const canonical = (await listingOf(written)).generations[0]!;
		const folded = (await feedOf(written)).body.entries.length;
		await stop();

		const chain = fakeChain().serve(LATER, LATER_TIP);
		const receiving = await aStartOf(node, db, chain, {});

		// it SERVES that generation, from the state the `run` left...
		const read = await feedOf(receiving);
		expect(read.status).toBe(200);
		expect(read.body.generation).toBe(canonical.digest);
		expect(read.body.entries).toHaveLength(folded);
		// ...says it is FROZEN, and why, on `/status` and on the admin listing...
		const status = await statusOf(receiving);
		expect(status.cursor.canonical).toMatchObject({
			generation: canonical.digest,
			folding: 'frozen',
			frozen: {reason: 'stream-not-fetched', message: expect.any(String)},
		});
		expect((await listingOf(receiving)).generations.find((entry) => entry.digest === canonical.digest)?.folding).toBe(
			'frozen',
		);
		// ...and WAITS for the next upload, fetching nothing: not the source `run` was
		// configured with, which is nowhere in the database, nor the bundle's own contracts
		expect(status.cursor.waiting?.for).toBe('processor');
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(chain.logRanges).toEqual([]);
		expect(receiving.container.held()).toEqual([]);

		// the next upload registers, and the node starts fetching what IT carries
		const next = await upload(receiving, EDITED_BUNDLE);
		expect(next.status, JSON.stringify(next.body)).toBe(200);
		expect(next.body.outcome).toBe('registered');
		await waitFor('the node started fetching', async () => chain.logRanges.length > 0);
	});
});
