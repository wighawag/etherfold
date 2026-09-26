import {generationDigestOf} from '@etherfold/core';
import {GENERATION_TABLE} from '@etherfold/server';
import {processorArtifactIdentity} from '@etherfold/utils';
import {createClient} from '@libsql/client';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {node, type RunningIndexer} from '../src/index.js';
import type {Options} from '../src/types.js';
import {uploadMain} from '../src/uploadCommand.js';
import {abi, ALICE, BOB, CAROL, CONTRACT, fakeChain, SOURCE, START_BLOCK, transfer, ZERO} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// `etherfold node` WAITS FOR ITS FIRST UPLOAD (ADR-0094, ADR-0093's waiting mode)
// ---------------------------------------------------------------------------------------------------
// The Graph's first half: a node is stood up ONCE, with no processor and no source,
// and processors ARRIVE by deploy. That used to be a MODE of `run` started with
// nothing configured (ADR-0093); it is its own command now, `node`, and this suite
// moved with it. Asserted END TO END against a real `node` and the real
// `etherfold upload` command, over the committed REAL bundles
// (`fixtures/processor-bundle/`):
//
//  - started with the chain, the store and the database only, it SERVES, fetches nothing, answers reads with the
//    existing `503 no-canonical-generation` (ADR-0058) and says on `/status` that it
//    is WAITING for a processor;
//  - its first upload becomes its first generation and takes `canonical`, and the node
//    starts FETCHING the contracts that upload carries and folds them;
//  - later uploads are never refused for carrying different contracts: nothing the
//    operator configured is there to match;
//  - over a registry whose canonical generation it can run, it instantiates that from
//    its stored bundle and folds the contracts THAT bundle carries;
//  - over one whose canonical generation it cannot run, it starts anyway, serves it
//    frozen with the reason, fetches nothing, and the next upload registers.
//
// What is deliberately NOT here: a placeholder. The claim every case makes is that no
// fold, no source and no fetch exist until a processor does.
// ---------------------------------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL('./fixtures/processor-bundle/', import.meta.url));
const BUNDLE = join(FIXTURES, 'nfts.bundle.js');
const EDITED_BUNDLE = join(FIXTURES, 'nfts-edited.bundle.js');
const APPROVAL_BUNDLE = join(FIXTURES, 'nfts-with-approval.bundle.js');
const THROWS_ON_EVALUATION = join(FIXTURES, 'throws-on-evaluation.bundle.js');

const INDEXER = 'nfts';
const ADMIN_TOKEN = 'the-operators-own-secret';

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
];
const TIP = START_BLOCK + 50;

let running: RunningIndexer | undefined;

afterEach(async () => {
	await running?.stop().catch(() => undefined);
	running = undefined;
	delete process.env.ADMIN_TOKEN;
});

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/** NOTHING CONFIGURED: no processor and no source, only where to fold, where to answer and the chain. */
const NOTHING: Options = {nodeUrl: 'http://localhost:0', store: 'sqlite', db: ':memory:', port: '0', indexer: INDEXER};

/** START a `node` over `db`, which may already hold generations. */
async function aWaitingNodeOver(
	db: RemoteSQL,
	chain: ReturnType<typeof fakeChain>,
	options: Partial<Options> = {},
	env: Record<string, string> = {},
): Promise<RunningIndexer> {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	running = await node(
		{...NOTHING, ...options},
		{
			provider: chain.provider,
			createDB: () => db,
			sleep: async () => {
				await new Promise((resolve) => setTimeout(resolve, 1));
			},
			handleSignals: false,
			log: () => {},
			env: {MAX_BLOCKS_PER_FETCH: '20', ...env},
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

async function feedAnswer(indexer: RunningIndexer): Promise<{status: number; body: Record<string, any>}> {
	const res = await fetch(`${indexer.url}/${INDEXER}/feed`);
	return {status: res.status, body: (await res.json()) as Record<string, any>};
}

async function statusOf(indexer: RunningIndexer): Promise<Record<string, any>> {
	return (await (await fetch(`${indexer.url}/status`)).json()) as Record<string, any>;
}

type Listing = {
	canonical?: {digest: string};
	slots?: Record<string, {digest: string}>;
	generations: {digest: string; stream: string; processor: string; canonical: boolean; slot?: string}[];
};

async function listingOf(indexer: RunningIndexer): Promise<Listing> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
	});
	expect(res.status).toBe(200);
	return (await res.json()) as Listing;
}

async function waitFor(what: string, done: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		if (await done()) return;
		if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Where the canonical generation's fold has got to, as `/status` reports it. */
async function canonicalReachedOn(indexer: RunningIndexer): Promise<number | undefined> {
	return (await statusOf(indexer)).cursor?.value?.lastToBlock;
}

const bytesOf = async (path: string): Promise<Uint8Array> => new Uint8Array(await readFile(path));

// ---------------------------------------------------------------------------------------------------

describe('a `node` waits, and says so', () => {
	it('starts, refuses reads with the no-canonical-generation 503, fetches nothing, and reports WAITING on /status', async () => {
		const chain = fakeChain().serve(LOGS, TIP);
		const indexer = await aWaitingNodeOver(oneDatabase(), chain);

		const read = await feedAnswer(indexer);
		expect(read.status).toBe(503);
		expect(read.body.error).toBe('no-canonical-generation');

		const status = await statusOf(indexer);
		expect(status.cursor.waiting).toMatchObject({for: 'processor', message: expect.stringContaining('upload')});
		expect(status.cursor.reported).toBe(false);
		expect(status.cursor.generations).toEqual([]);
		expect('canonical' in status.cursor).toBe(false);
		// no fetcher: the chain-facing half has nothing to report, because it does not exist yet
		expect(status.fetcher.reported).toBe(false);
		expect(() => indexer.host).toThrow(/WAITING/);

		// ...and it STAYS that way while it waits: not one log range is asked for
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(chain.logRanges).toEqual([]);
		expect(indexer.container.held()).toEqual([]);
		expect((await listingOf(indexer)).generations).toEqual([]);
	});
});

describe('a `node` serves no re-read route: an upload is the ONE way code reaches it (ADR-0094)', () => {
	it('answers `POST /{indexer}/admin/reconfigure` as a route that does not exist, and registers nothing', async () => {
		const indexer = await aWaitingNodeOver(oneDatabase(), fakeChain().serve(LOGS, TIP));

		const res = await fetch(`${indexer.url}/${INDEXER}/admin/reconfigure`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
		});

		// NOT a `501` capability refusal: the route itself is deleted, on every host
		expect(res.status).toBe(404);
		expect((await listingOf(indexer)).generations).toEqual([]);
	});
});

describe('its first upload makes it index', () => {
	it('registers the first upload as canonical, starts fetching the contracts it carries, and folds them', async () => {
		const chain = fakeChain().serve(LOGS, TIP);
		const indexer = await aWaitingNodeOver(oneDatabase(), chain);

		const ran = await uploadWith(indexer, BUNDLE);

		expect(ran.code, ran.err).toBe(0);
		expect(ran.out).toMatch(/\bregistered\b/);
		const listing = await listingOf(indexer);
		expect(listing.generations).toHaveLength(1);
		const first = listing.generations[0]!;
		expect(first.processor).toBe(processorArtifactIdentity(await bytesOf(BUNDLE)));
		// CANONICAL by the registry's existing rule: the first generation registered takes the pointer
		expect(first.canonical).toBe(true);
		expect(listing.slots?.canonical?.digest).toBe(first.digest);

		// ...and it FOLDS: the cursor advances over the fake chain to its tip, fetched from the
		// contracts the upload carried
		await waitFor('the uploaded processor folded to the tip', async () => (await canonicalReachedOn(indexer)) === TIP);
		expect(chain.logRanges.length).toBeGreaterThan(0);
		const read = await feedAnswer(indexer);
		expect(read.status).toBe(200);
		expect(read.body.generation).toBe(first.digest);
		expect(read.body.entries).toHaveLength(LOGS.length);
		expect(indexer.container.fetchedSource?.chainId).toBe(SOURCE.chainId);

		// it is no longer waiting, and its fetcher reports
		const status = await statusOf(indexer);
		expect('waiting' in status.cursor).toBe(false);
		expect(status.fetcher.reported).toBe(true);
	});

	it('registers a second upload as `successor`, whether it carries the same contracts or different ones', async () => {
		// `manual`, so what is read is the REGISTRATION: under `on-catch-up` the successor on a
		// new stream is fetched and promoted as soon as it catches up, which is
		// `aSuccessorOnANewStreamIsFetchedByItsOwnWriter.test.ts`
		const indexer = await aWaitingNodeOver(oneDatabase(), fakeChain().serve(LOGS, TIP), {promotion: 'manual'});
		expect((await uploadWith(indexer, BUNDLE)).code).toBe(0);
		await waitFor('the first upload folded to the tip', async () => (await canonicalReachedOn(indexer)) === TIP);
		const first = (await listingOf(indexer)).generations[0]!;

		// DIFFERENT contracts: nothing the operator configured is here to match, so it is a
		// successor on its own new stream and NOT refused
		const approval = await uploadWith(indexer, APPROVAL_BUNDLE);
		expect(approval.code, approval.err).toBe(0);
		expect(approval.out).toMatch(/\bregistered\b/);
		let listing = await listingOf(indexer);
		const approvalIdentity = processorArtifactIdentity(await bytesOf(APPROVAL_BUNDLE));
		const onNewStream = listing.generations.find((entry) => entry.processor === approvalIdentity)!;
		expect(onNewStream.stream).not.toBe(first.stream);
		expect(listing.slots?.successor?.digest).toBe(onNewStream.digest);
		expect(listing.slots?.canonical?.digest).toBe(first.digest);

		// the SAME contracts, edited handlers: a successor too, on the stream the node fetches
		// (it takes the successor slot, which holds one: the pending one it replaces goes)
		const edited = await uploadWith(indexer, EDITED_BUNDLE);
		expect(edited.code, edited.err).toBe(0);
		expect(edited.out).toMatch(/\bregistered\b/);
		listing = await listingOf(indexer);
		const editedIdentity = processorArtifactIdentity(await bytesOf(EDITED_BUNDLE));
		const editedEntry = listing.generations.find((entry) => entry.processor === editedIdentity)!;
		expect(editedEntry.stream).toBe(first.stream);
		expect([listing.slots?.successor?.digest, listing.slots?.canonical?.digest]).toContain(editedEntry.digest);
	});
});

describe('a `node` over a registry that already has a canonical generation', () => {
	it('instantiates it from its stored bundle and folds the contracts THAT bundle carries', async () => {
		const db = oneDatabase();
		const first = await aWaitingNodeOver(db, fakeChain().serve(LOGS, TIP));
		expect((await uploadWith(first, BUNDLE)).code).toBe(0);
		await waitFor('the first process folded to the tip', async () => (await canonicalReachedOn(first)) === TIP);
		const canonical = (await listingOf(first)).slots?.canonical?.digest;
		await stop();

		// the chain moved on while nothing was running
		const LATER = [...LOGS, transfer(START_BLOCK + 70, '0xa70', BOB, CAROL, 1n)];
		const LATER_TIP = START_BLOCK + 90;
		const chain = fakeChain().serve(LATER, LATER_TIP);
		const restarted = await aWaitingNodeOver(db, chain);

		// it came up FOLDING the canonical generation, from the bytes stored for it
		expect(restarted.container.held().map((fold) => generationDigestOf(fold.record))).toEqual([canonical]);
		expect(restarted.container.fetchedSource?.chainId).toBe(SOURCE.chainId);
		await waitFor(
			'the restarted node folded the new block',
			async () => (await canonicalReachedOn(restarted)) === LATER_TIP,
		);
		const read = await feedAnswer(restarted);
		expect(read.status).toBe(200);
		expect(read.body.generation).toBe(canonical);
		expect(read.body.entries).toHaveLength(LATER.length);
		expect('waiting' in (await statusOf(restarted)).cursor).toBe(false);
	});

	it('starts anyway where it cannot instantiate it, serves it frozen with the reason, fetches nothing, and takes the next upload', async () => {
		const db = oneDatabase();
		const first = await aWaitingNodeOver(db, fakeChain().serve(LOGS, TIP));
		expect((await uploadWith(first, BUNDLE)).code).toBe(0);
		await waitFor('the first process folded to the tip', async () => (await canonicalReachedOn(first)) === TIP);
		const canonical = (await listingOf(first)).generations[0]!;
		await stop();

		// ITS STORED CODE IS BROKEN: the bytes on its row no longer evaluate
		await db
			.prepare(`UPDATE ${GENERATION_TABLE} SET bundle = ?1 WHERE indexer = ?2 AND processor = ?3`)
			.bind(await bytesOf(THROWS_ON_EVALUATION), INDEXER, canonical.processor)
			.all();

		const chain = fakeChain().serve(LOGS, TIP);
		const restarted = await aWaitingNodeOver(db, chain);

		// it SERVES the frozen generation, from its own state
		const read = await feedAnswer(restarted);
		expect(read.status).toBe(200);
		expect(read.body.generation).toBe(canonical.digest);
		expect(read.body.entries).toHaveLength(LOGS.length);
		// ...says it is frozen, and why, and that it is waiting
		const status = await statusOf(restarted);
		expect(status.cursor.canonical).toMatchObject({
			generation: canonical.digest,
			folding: 'frozen',
			frozen: {reason: 'instantiation-failed', message: expect.any(String)},
		});
		expect(status.cursor.value?.lastToBlock).toBe(TIP);
		expect(status.cursor.waiting?.for).toBe('processor');
		// ...and fetches nothing
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(chain.logRanges).toEqual([]);
		expect(restarted.container.held()).toEqual([]);

		// the next upload is accepted and registers BESIDE it, as usual
		const ran = await uploadWith(restarted, EDITED_BUNDLE);
		expect(ran.code, ran.err).toBe(0);
		expect(ran.out).toMatch(/\bregistered\b/);
		const listing = await listingOf(restarted);
		expect(listing.slots?.successor?.digest ?? listing.slots?.canonical?.digest).not.toBe(canonical.digest);
		expect(listing.generations.map((entry) => entry.processor)).toContain(
			processorArtifactIdentity(await bytesOf(EDITED_BUNDLE)),
		);
		// ...and the node now knows what to fetch, so it fetches
		await waitFor('the node started fetching', async () => chain.logRanges.length > 0);
	});
});

// ---------------------------------------------------------------------------------------------------
// WHAT `node` TAKES, AND WHAT IT DOES NOT READ (ADR-0094)
// ---------------------------------------------------------------------------------------------------
// Its FLAGS `-p` and `--deployments` are refused by the resolver (`configuration.test.ts`).
// The ambient `INDEXING_SOURCE` is NOT refused and NOT read (ADR-0048): one host may run
// `node` beside a configured command that owns the variable. So it is asserted here, end to
// end, that a node whose environment names a DIFFERENT contract never fetches it.
// ---------------------------------------------------------------------------------------------------

/** A source naming a contract the uploaded bundles do not carry. */
const ELSEWHERE = '0x00000000000000000000000000000000000000ee';

describe('a `node` does not read INDEXING_SOURCE, which it does not own', () => {
	it('starts and waits with it set, and fetches the contracts the UPLOAD carries, never the ones it names', async () => {
		const chain = fakeChain().serve(LOGS, TIP);
		const indexer = await aWaitingNodeOver(
			oneDatabase(),
			chain,
			{},
			{
				INDEXING_SOURCE: JSON.stringify({
					chainId: '1',
					contracts: [{abi, address: ELSEWHERE, startBlock: START_BLOCK}],
				}),
			},
		);

		// not refused, and not used as a source: it WAITS, exactly as it would without it
		expect((await statusOf(indexer)).cursor.waiting?.for).toBe('processor');
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(chain.logRanges).toEqual([]);

		expect((await uploadWith(indexer, BUNDLE)).code).toBe(0);
		await waitFor('the uploaded processor folded to the tip', async () => (await canonicalReachedOn(indexer)) === TIP);

		const fetched = indexer.container.fetchedSource?.contracts as readonly {address: string}[];
		expect(fetched.map((contract) => contract.address.toLowerCase())).toEqual([CONTRACT.toLowerCase()]);
		const asked = chain.calls
			.filter((call) => call.method === 'eth_getLogs')
			.flatMap((call) => [call.params[0].address].flat())
			.map((address: string) => address.toLowerCase());
		expect(asked.length).toBeGreaterThan(0);
		expect(asked).not.toContain(ELSEWHERE);
	});
});

describe('a `node` honours --promotion', () => {
	it('under `manual`, holds an upload that has CAUGHT UP until it is asked, then moves when asked', async () => {
		const indexer = await aWaitingNodeOver(oneDatabase(), fakeChain().serve(LOGS, TIP), {promotion: 'manual'});
		expect((await uploadWith(indexer, BUNDLE)).code).toBe(0);
		await waitFor('the first upload folded to the tip', async () => (await canonicalReachedOn(indexer)) === TIP);
		const first = (await listingOf(indexer)).generations[0]!;

		expect((await uploadWith(indexer, EDITED_BUNDLE)).code).toBe(0);
		const editedIdentity = processorArtifactIdentity(await bytesOf(EDITED_BUNDLE));
		const edited = (await listingOf(indexer)).generations.find((entry) => entry.processor === editedIdentity)!;
		await waitFor('the uploaded successor caught up', async () => {
			return (
				(await indexer.container.registry.readStateCursor({stream: edited.stream, processor: edited.processor})) === TIP
			);
		});
		// CAUGHT UP, and still not canonical, cycle after cycle: nobody asked
		await new Promise((resolve) => setTimeout(resolve, 100));
		let listing = await listingOf(indexer);
		expect(listing.slots?.canonical?.digest).toBe(first.digest);
		expect(listing.slots?.successor?.digest).toBe(edited.digest);
		expect((await statusOf(indexer)).promotion).toMatchObject({policy: 'manual'});

		// ...and the operator's promote moves it
		const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json'},
			body: JSON.stringify({stream: edited.stream, processor: edited.processor}),
		});
		expect(res.status, await res.clone().text()).toBe(200);
		listing = await listingOf(indexer);
		expect(listing.slots?.canonical?.digest).toBe(edited.digest);
	});
});

// ---------------------------------------------------------------------------------------------------
// THE LINES AN OPERATOR READS FIRST (found by a hand smoke test on 2026-09-26)
// ---------------------------------------------------------------------------------------------------

/** START a `node` over `db` and return what it printed at start. `ADMIN_TOKEN` is set only when given. */
async function startupLinesOf(db: RemoteSQL, chain: ReturnType<typeof fakeChain>, token?: string): Promise<string> {
	delete process.env.ADMIN_TOKEN;
	if (token !== undefined) process.env.ADMIN_TOKEN = token;
	const lines: string[] = [];
	running = await node(NOTHING, {
		provider: chain.provider,
		createDB: () => db,
		sleep: async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
		},
		handleSignals: false,
		log: (...args) => lines.push(args.map(String).join(' ')),
		env: {MAX_BLOCKS_PER_FETCH: '20'},
	});
	return lines.join('\n');
}

describe('what a `node` says when it starts', () => {
	it('WARNS that it can never receive a processor when ADMIN_TOKEN is not set', async () => {
		const said = await startupLinesOf(oneDatabase(), fakeChain().serve(LOGS, TIP));
		expect(said).toMatch(/WARNING: ADMIN_TOKEN is not set, so this node refuses every upload \(401\)/);
		// ...and it means it: the first upload is refused
		const res = await fetch(`${running!.url}/${INDEXER}/admin/upload`, {
			method: 'POST',
			headers: {'Content-Type': 'text/javascript', Authorization: `Bearer ${ADMIN_TOKEN}`},
			body: new Uint8Array(await bytesOf(BUNDLE)),
		});
		expect(res.status).toBe(401);
	});

	it('does not warn when ADMIN_TOKEN is set', async () => {
		const said = await startupLinesOf(oneDatabase(), fakeChain().serve(LOGS, TIP), ADMIN_TOKEN);
		expect(said).not.toMatch(/WARNING/);
	});

	it('names the generation it RESUMED on a restart, which nothing on its command line names', async () => {
		const db = oneDatabase();
		const first = await aWaitingNodeOver(db, fakeChain().serve(LOGS, TIP));
		expect((await uploadWith(first, BUNDLE)).code).toBe(0);
		await waitFor('the upload folded to the tip', async () => (await canonicalReachedOn(first)) === TIP);
		const resumed = (await listingOf(first)).generations[0]!;
		await stop();

		const said = await startupLinesOf(db, fakeChain().serve(LOGS, TIP), ADMIN_TOKEN);
		expect(said).toContain(`serving generation ${resumed.digest} (processor ${resumed.processor})`);
	});

	it('says what a FIRST upload does, without claiming another generation answers reads', async () => {
		const indexer = await aWaitingNodeOver(oneDatabase(), fakeChain().serve(LOGS, TIP));
		const ran = await uploadWith(indexer, BUNDLE);
		expect(ran.code, ran.err).toBe(0);
		expect(ran.out).toMatch(/if none does yet \(a first upload\) it answers them as soon as it has folded/);
	});
});
