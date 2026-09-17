import {generationDigestOf} from '@etherfold/core';
import {createClient} from '@libsql/client';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {run, type RunDependencies, type RunningIndexer} from '../src/index.js';
import type {Options} from '../src/types.js';
import {ALICE, BOB, CONTRACT, fakeChain, START_BLOCK, transfer, ZERO} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// A CHANGE REACHES A RUNNING DEPLOYMENT: ONE ENDPOINT, NO RESTART
// ---------------------------------------------------------------------------------------------------
// Everything downstream of "a successor exists" was already built: a successor is
// registered BESIDE the incumbent, the incumbent goes on answering every read, a
// follower is advanced by a bounded rebuild this host schedules, and the pointer
// moves on its own once it is level. What was missing was the thing that
// INTRODUCES the successor, so a changed processor reached a running `run` by
// stopping it and starting it again.
//
// `POST /{indexer}/admin/reconfigure` is that trigger, and what is asserted here
// is the END-TO-END claim rather than a function's return value: a deployment
// stood up exactly as the other `run` tests stand one up, a processor module that
// is a REAL FILE ON DISK, and an EDIT to that file between two calls.
//
// The file is real deliberately. The module cache is the hazard this mechanism
// lives or dies on -- `import()` hands back the CACHED module for a path already
// imported, so a re-read that did nothing about it would observe every rebuild as
// no change at all -- and an injected importer would assert nothing about it,
// because a test double is free to answer differently every time whether the
// cache was defeated or not.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'nfts';
const INGEST_TOKEN = 'a-shared-secret';
const ADMIN_TOKEN = 'the-operators-own-secret';

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
];
const TIP = START_BLOCK + 50;

/**
 * THE SIBLING MODULE the entry point below imports, which is what makes it an
 * UNBUNDLED ENTRY POINT rather than a bundle.
 *
 * That distinction is load-bearing now and was not when this suite was written.
 * A processor arrives either as a PATH the module system resolves, keeping the
 * author-DECLARED identity, or as a self-contained BUNDLE, named by the hash of
 * its bytes (ADR-0086) -- and "self-contained" means exactly "expects nobody else
 * to resolve anything", so an entry point that imported nothing at all would BE a
 * bundle and would be identified by its bytes. Every case below is about the
 * declared identity: a `version` bump registering a successor, a handler edit at
 * a static version reporting drift and registering nothing. So the module ships
 * its ABI the way a real one does, in a second file, and stays on the route these
 * cases are about. Do not inline it back.
 */
const abiModuleSource = `
export const abi = [
	{
		anonymous: false,
		inputs: [
			{indexed: true, internalType: 'address', name: 'from', type: 'address'},
			{indexed: true, internalType: 'address', name: 'to', type: 'address'},
			{indexed: true, internalType: 'uint256', name: 'id', type: 'uint256'},
		],
		name: 'Transfer',
		type: 'event',
	},
];
`;

/** What every source below opens with, so an EDIT never turns the module into a bundle. */
const IMPORTS_ITS_ABI = `import {abi} from './abi.js';\n`;

/**
 * The processor module a deployment SHIPS, as text, because the thing under test
 * is what happens when the bytes on disk change.
 *
 * The entity declarations are literals and the handler is a function, so apart
 * from the sibling ABI this is a module the real `import()` can evaluate with no
 * build step between the test and the loader.
 */
function processorModuleSource(options: {version: string; credit: 'to' | 'from'}): string {
	return `${IMPORTS_ITS_ABI}
export const contractsDataPerChain = {
	'1': [
		{
			abi,
			address: '${CONTRACT}',
			startBlock: ${START_BLOCK},
		},
	],
};

export function createProcessor() {
	return {
		version: '${options.version}',
		entities: [{name: 'nft', id: ['tokenID'], fields: {owner: 'text'}}],
		async onTransfer(state, event) {
			const tokenID = event.args.id.toString().padStart(78, '0');
			state.set('nft', {tokenID}, {owner: event.args.${options.credit}.toLowerCase()});
		},
	};
}
`;
}

/** The scratch directories these cases write processor modules into, outside the repository. */
const scratch: string[] = [];

async function aProcessorModuleOnDisk(source: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-reconfigure-'));
	scratch.push(dir);
	await writeFile(join(dir, 'abi.js'), abiModuleSource, 'utf-8');
	const path = join(dir, 'processor.mjs');
	await writeFile(path, source, 'utf-8');
	return path;
}

/** THE EDIT a watcher notices: the same path, different bytes. */
async function edit(path: string, source: string): Promise<void> {
	await writeFile(path, source, 'utf-8');
}

let running: RunningIndexer | undefined;
let release: (() => void) | undefined;

afterEach(async () => {
	release?.();
	release = undefined;
	await running?.stop().catch(() => undefined);
	running = undefined;
	for (const dir of scratch.splice(0)) {
		await rm(dir, {recursive: true, force: true}).catch(() => undefined);
	}
	delete process.env.INGEST_TOKEN;
	delete process.env.ADMIN_TOKEN;
});

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

/**
 * A `run` process that has already folded `LOGS` and is answering, with its
 * processor module on disk where a rebuild can replace it.
 *
 * `importModule` is deliberately NOT injected: the real dynamic import is the
 * thing under test.
 */
async function aRunServing(
	processorPath: string,
	extra: RunDependencies = {},
): Promise<{indexer: RunningIndexer; db: RemoteSQL; chain: ReturnType<typeof fakeChain>}> {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	const chain = fakeChain().serve(LOGS, TIP);
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	const started = await run(optionsFor(processorPath), {
		provider: chain.provider,
		createDB: () => db,
		sleep: async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
		},
		handleSignals: false,
		log: () => {},
		env: {MAX_BLOCKS_PER_FETCH: '20'},
		...extra,
	});
	running = started;
	await feedOf(started, LOGS.length);
	return {indexer: started, db, chain};
}

/**
 * READ THE FEED, refusing to accept anything but a served answer.
 *
 * Every call in these cases goes through here, which is what makes "the incumbent
 * kept answering reads throughout" an assertion rather than a hope: a read that
 * went unanswered at any point during a reconfigure fails the case that made it.
 */
async function feedOf(
	indexer: RunningIndexer,
	expectedEntries?: number,
): Promise<{generation: string; entries: unknown[]}> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const res = await fetch(`${indexer.url}/${INDEXER}/feed`);
		const body = (await res.json()) as {generation: string; entries: unknown[]};
		expect(res.status, JSON.stringify(body)).toBe(200);
		if (expectedEntries === undefined || body.entries.length === expectedEntries) return body;
		if (Date.now() > deadline) throw new Error(`the feed never served ${expectedEntries} entries`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

type Reconfigured = {
	status: number;
	body: {
		success?: boolean;
		outcome?: string;
		error?: string;
		message?: string;
		indexer?: string;
		generation?: {stream: string; processor: string; digest: string};
		/** The SECOND OPINION on an `unchanged`: present only when the handler code moved. */
		drift?: {
			processorHash: string;
			compared: string;
			previousFingerprint: string;
			currentFingerprint: string;
			message: string;
		};
	};
};

/** WHAT A WATCHER DOES after its rebuild: one call, no body. */
async function reconfigure(indexer: RunningIndexer, options: {token?: string | undefined} = {}): Promise<Reconfigured> {
	const token = 'token' in options ? options.token : ADMIN_TOKEN;
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/reconfigure`, {
		method: 'POST',
		...(token === undefined ? {} : {headers: {Authorization: `Bearer ${token}`}}),
	});
	return {status: res.status, body: (await res.json()) as Reconfigured['body']};
}

/** Every generation this deployment holds, as the operator's own listing reports them. */
async function generationsOf(indexer: RunningIndexer): Promise<{digest: string; canonical: boolean}[]> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as {generations: {digest: string; canonical: boolean}[]}).generations;
}

// ---------------------------------------------------------------------------------------------------

describe('a watcher calls one endpoint and the running deployment picks up the edit', () => {
	it('registers the edited processor beside the incumbent, with no restart and no read unanswered', async () => {
		const path = await aProcessorModuleOnDisk(processorModuleSource({version: '1.0.0', credit: 'to'}));
		const {indexer} = await aRunServing(path);
		const incumbent = generationDigestOf(indexer.streamBuilder.generation);
		const port = indexer.port;

		// THE FIRST CALL, before anything was edited: the configuration names the
		// generation this deployment is already holding, and it SAYS so rather than
		// looking like a call that did nothing
		const unchanged = await reconfigure(indexer);
		expect(unchanged.status, JSON.stringify(unchanged.body)).toBe(200);
		expect(unchanged.body.outcome).toBe('unchanged');
		expect(unchanged.body.generation?.digest).toBe(incumbent);
		expect(await generationsOf(indexer)).toHaveLength(1);

		// THE EDIT, and the rebuild a watcher would have done for us
		await edit(path, processorModuleSource({version: '2.0.0', credit: 'from'}));

		const registered = await reconfigure(indexer);
		expect(registered.status, JSON.stringify(registered.body)).toBe(200);
		expect(registered.body.outcome).toBe('registered');
		expect(registered.body.success).toBe(true);
		expect(registered.body.indexer).toBe(INDEXER);
		// the SECOND call registered a generation the first did not, which is the
		// module cache being defeated: an unchanged re-import would have produced the
		// digest above again
		expect(registered.body.generation?.digest).not.toBe(incumbent);
		expect(registered.body.generation?.stream).toBe(indexer.streamBuilder.generation.stream);

		// BESIDE, not instead: two generations, and the incumbent still answers
		const held = await generationsOf(indexer);
		expect(held.map((entry) => entry.digest).sort()).toEqual(
			[incumbent, registered.body.generation?.digest as string].sort(),
		);

		// NO RESTART: the same process, on the same port, with its loop still running
		expect(indexer.port).toBe(port);
		expect((await fetch(`${indexer.url}/status`)).status).toBe(200);

		// ...and the deployment actually MOVES ONTO the edit on its own: the successor
		// is a follower on the same stream, a bounded rebuild between fetch cycles
		// advances it, and the pointer moves once it is level. Every poll on the way
		// is a served read (`feedOf` refuses anything else), which is the property this
		// whole affordance exists to preserve.
		const successor = registered.body.generation?.digest as string;
		const deadline = Date.now() + 10_000;
		for (;;) {
			const feed = await feedOf(indexer, LOGS.length);
			if (feed.generation === successor) break;
			expect(feed.generation).toBe(incumbent);
			if (Date.now() > deadline) throw new Error(`the deployment never moved onto the edited processor`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	});
});

describe('a processor that does not compile leaves the deployment exactly as it was', () => {
	it('reports WHAT went wrong, registers nothing, and goes on folding and answering', async () => {
		const path = await aProcessorModuleOnDisk(processorModuleSource({version: '1.0.0', credit: 'to'}));
		const {indexer, chain} = await aRunServing(path);
		const incumbent = generationDigestOf(indexer.streamBuilder.generation);
		const before = await generationsOf(indexer);

		// the NORMAL state between the two halves of one change: the source landed and
		// the handlers have not, so the module throws the moment it is evaluated
		await edit(path, `${IMPORTS_ITS_ABI}throw new Error('the deployments folder is not built yet');\n`);

		const refused = await reconfigure(indexer);
		expect(refused.status, JSON.stringify(refused.body)).toBe(409);
		expect(refused.body.success).toBe(false);
		expect(refused.body.error).toBe('reconfigure-failed');
		// the author's own message reaches the watcher verbatim, because the watcher is
		// what they are going to read
		expect(refused.body.message).toContain('the deployments folder is not built yet');
		expect(refused.body.generation).toBeUndefined();

		// NOTHING PARTIAL: the same generations, the same canonical pointer
		expect(await generationsOf(indexer)).toEqual(before);
		const feed = await feedOf(indexer, LOGS.length);
		expect(feed.generation).toBe(incumbent);

		// ...and it is still FOLDING: the chain moves on and this process applies it,
		// which is the half a refusal that had half-applied would have broken
		chain.serve([...LOGS, transfer(START_BLOCK + 60, '0xa60', BOB, ALICE, 1n)], TIP + 50);
		expect((await feedOf(indexer, LOGS.length + 1)).generation).toBe(incumbent);

		// the next save repairs it, on the very same running process
		await edit(path, processorModuleSource({version: '3.0.0', credit: 'from'}));
		const repaired = await reconfigure(indexer);
		expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
		expect(repaired.body.outcome).toBe('registered');
	});

	it('refuses a module that cannot be parsed at all, on the same shape', async () => {
		const path = await aProcessorModuleOnDisk(processorModuleSource({version: '1.0.0', credit: 'to'}));
		const {indexer} = await aRunServing(path);
		const before = await generationsOf(indexer);

		await edit(path, `${IMPORTS_ITS_ABI}export function createProcessor() { return {\n`);

		const refused = await reconfigure(indexer);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toBe('reconfigure-failed');
		expect(typeof refused.body.message).toBe('string');
		expect(await generationsOf(indexer)).toEqual(before);
		expect((await feedOf(indexer, LOGS.length)).generation).toBe(before[0]?.digest);
	});
});

describe('a burst of calls does not fill the registry', () => {
	it('holds ONE successor beside the incumbent after six saves, rather than one per save', async () => {
		// The host's own clock is PARKED at the tip for this case, deliberately. A
		// successor stops being droppable the moment it becomes canonical, and what
		// makes it canonical here is the bounded rebuild this host schedules between
		// fetch cycles -- which on a two-log stream completes instantly. A developer
		// saving six times in an afternoon is saving faster than their rebuild
		// finishes, and parking the clock is how that is expressed in a test rather
		// than raced against.
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const path = await aProcessorModuleOnDisk(processorModuleSource({version: '1.0.0', credit: 'to'}));
		const {indexer} = await aRunServing(path, {
			sleep: async (ms, signal) => {
				if (ms <= 0) return;
				await Promise.race([
					parked,
					new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), {once: true})),
				]);
			},
		});
		const incumbent = generationDigestOf(indexer.streamBuilder.generation);

		const digests: string[] = [];
		for (const version of ['2.0.0', '3.0.0', '4.0.0', '5.0.0', '6.0.0', '7.0.0']) {
			await edit(path, processorModuleSource({version, credit: 'from'}));
			const answer = await reconfigure(indexer);
			// EVERY call succeeds: accumulating one generation per save would have met
			// the cap (four) on the third and been REFUSED from then on
			expect(answer.status, `${version}: ${JSON.stringify(answer.body)}`).toBe(200);
			expect(answer.body.outcome).toBe('registered');
			digests.push(answer.body.generation?.digest as string);
		}
		expect(new Set(digests).size).toBe(digests.length);

		// what is LEFT is the incumbent and the newest successor: each save abandoned
		// the one before it, and an abandoned successor is dropped rather than kept
		const held = await generationsOf(indexer);
		expect(held.map((entry) => entry.digest).sort()).toEqual([incumbent, digests[digests.length - 1] as string].sort());
		expect(held.filter((entry) => entry.canonical).map((entry) => entry.digest)).toEqual([incumbent]);

		// and the deployment answered throughout
		expect((await feedOf(indexer, LOGS.length)).generation).toBe(incumbent);
	});
});

describe('the trigger is the operator\u2019s, on the operator\u2019s credential', () => {
	it('refuses a caller with no token and one holding the INGEST token, and registers nothing', async () => {
		process.env.INGEST_TOKEN = INGEST_TOKEN;
		const path = await aProcessorModuleOnDisk(processorModuleSource({version: '1.0.0', credit: 'to'}));
		const {indexer} = await aRunServing(path);
		await edit(path, processorModuleSource({version: '2.0.0', credit: 'from'}));

		expect((await reconfigure(indexer, {token: undefined})).status).toBe(401);
		// the credential a log shipper holds does not get to start a fold here either
		expect((await reconfigure(indexer, {token: INGEST_TOKEN})).status).toBe(401);

		expect(await generationsOf(indexer)).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------------------------------
// `unchanged` IS TRUTHFUL AND, ON ITS OWN, USELESS
// ---------------------------------------------------------------------------------------------------
// A generation is identified by `getVersionHash()` -- the DECLARED version plus
// the entity declarations and the config -- and never by the text of the
// handlers, so a developer who edits a handler body, saves and calls this
// endpoint is told that nothing changed. That answer is correct and reads
// exactly like a save that genuinely changed nothing, which is how "I saved and
// nothing happened" becomes an afternoon.
//
// The system already knows better: `getCodeFingerprint()` is the second opinion,
// and the module this endpoint has just re-imported carries one. So an
// `unchanged` SAYS whether the code moved, in the `PROCESSOR DRIFT` vocabulary
// the chain-facing indexer already uses, and names the one thing that would make
// it a different fold.
//
// What it must NOT do is act on it. The fingerprint is ADVISORY (`@etherfold/core`,
// `utils/fingerprint.ts`): registering a generation because the code drifted
// would fold it into the identity through the back door and force a full replay
// on a re-minification that changed no logic. So these cases assert the report
// AND that nothing was registered.
// ---------------------------------------------------------------------------------------------------

describe('a reload that changed nothing says whether the CODE changed', () => {
	it('reports PROCESSOR DRIFT for a handler edit at a static version, and still registers nothing', async () => {
		const path = await aProcessorModuleOnDisk(processorModuleSource({version: '1.0.0', credit: 'to'}));
		const {indexer} = await aRunServing(path);
		const incumbent = generationDigestOf(indexer.streamBuilder.generation);
		const before = await generationsOf(indexer);

		// THE EDIT A DEVELOPER ACTUALLY MAKES: a handler body, and a `version` they did
		// not think to touch
		await edit(path, processorModuleSource({version: '1.0.0', credit: 'from'}));

		const answer = await reconfigure(indexer);
		expect(answer.status, JSON.stringify(answer.body)).toBe(200);
		// STILL a successful no-op, and still the generation this deployment holds
		expect(answer.body.outcome).toBe('unchanged');
		expect(answer.body.generation?.digest).toBe(incumbent);

		// ...but it no longer reads like a save that changed nothing
		expect(answer.body.drift?.compared).toBe('reloaded-module');
		expect(answer.body.drift?.previousFingerprint).not.toBe(answer.body.drift?.currentFingerprint);
		expect(answer.body.drift?.processorHash).toBe(indexer.streamBuilder.generation.processor);
		expect(answer.body.message).toContain('PROCESSOR DRIFT');
		// and it names what to do about it rather than only reporting two hashes
		expect(answer.body.message).toContain('version');

		// ADVISORY, end to end: no generation was registered because the code drifted,
		// and the deployment goes on answering from the fold it came up with
		expect(await generationsOf(indexer)).toEqual(before);
		expect((await feedOf(indexer, LOGS.length)).generation).toBe(incumbent);

		// the condition LASTS until the author acts, so a second call says it again
		const again = await reconfigure(indexer);
		expect(again.body.outcome).toBe('unchanged');
		expect(again.body.drift?.currentFingerprint).toBe(answer.body.drift?.currentFingerprint);

		// ...and bumping `version` is what makes it a different fold
		await edit(path, processorModuleSource({version: '2.0.0', credit: 'from'}));
		const registered = await reconfigure(indexer);
		expect(registered.body.outcome).toBe('registered');
		expect(registered.body.drift).toBeUndefined();
	});

	it('says nothing about drift when the reload really was a no-op', async () => {
		const path = await aProcessorModuleOnDisk(processorModuleSource({version: '1.0.0', credit: 'to'}));
		const {indexer} = await aRunServing(path);

		// no edit at all: the same bytes, re-imported behind the cache breaker
		const answer = await reconfigure(indexer);

		expect(answer.body.outcome).toBe('unchanged');
		expect(answer.body.drift).toBeUndefined();
		expect(answer.body.message).not.toContain('PROCESSOR DRIFT');
	});
});
