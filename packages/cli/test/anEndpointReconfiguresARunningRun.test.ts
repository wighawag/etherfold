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
 * THE PROCESSOR A DEPLOYMENT SHIPS, as text, because the thing under test is what
 * happens when the bytes on disk change.
 *
 * It is SELF-CONTAINED -- it imports nothing, so `unresolvedImportsOf` calls it a
 * bundle -- and that is load-bearing rather than incidental. A processor is
 * identified by the SHA-256 of its bytes (ADR-0086), an entry point that still
 * expects somebody else to resolve an import has no bytes that describe it and is
 * refused (`aDeploymentRunsFromABundle.test.ts`), and every case below is about
 * what a REBUILD at one path does to a running deployment.
 *
 * `credit` is the handler EDIT these cases make: crediting `from` instead of `to`
 * is a different fold, and a save that changes it changes the bytes. `marker` is a
 * comment, which is how a case makes a save DISTINCT without changing behaviour --
 * the bytes moved, so the identity did, which is the whole difference between a
 * derived identity and a declared one.
 */
function processorModuleSource(options: {credit: 'to' | 'from'; marker?: string}): string {
	return `${options.marker === undefined ? '' : `// ${options.marker}\n`}const abi = [
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
		const path = await aProcessorModuleOnDisk(processorModuleSource({credit: 'to'}));
		const {indexer} = await aRunServing(path);
		const incumbent = generationDigestOf(indexer.streamBuilder!.generation);
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
		await edit(path, processorModuleSource({credit: 'from'}));

		const registered = await reconfigure(indexer);
		expect(registered.status, JSON.stringify(registered.body)).toBe(200);
		expect(registered.body.outcome).toBe('registered');
		expect(registered.body.success).toBe(true);
		expect(registered.body.indexer).toBe(INDEXER);
		// the SECOND call registered a generation the first did not, which is the
		// module cache being defeated: an unchanged re-import would have produced the
		// digest above again
		expect(registered.body.generation?.digest).not.toBe(incumbent);
		expect(registered.body.generation?.stream).toBe(indexer.streamBuilder!.generation.stream);

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
		const path = await aProcessorModuleOnDisk(processorModuleSource({credit: 'to'}));
		const {indexer, chain} = await aRunServing(path);
		const incumbent = generationDigestOf(indexer.streamBuilder!.generation);
		const before = await generationsOf(indexer);

		// the NORMAL state between the two halves of one change: the source landed and
		// the handlers have not, so the module throws the moment it is evaluated
		await edit(path, `throw new Error('the deployments folder is not built yet');\n`);

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
		await edit(path, processorModuleSource({credit: 'from'}));
		const repaired = await reconfigure(indexer);
		expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
		expect(repaired.body.outcome).toBe('registered');
	});

	it('refuses a module that cannot be parsed at all, on the same shape', async () => {
		const path = await aProcessorModuleOnDisk(processorModuleSource({credit: 'to'}));
		const {indexer} = await aRunServing(path);
		const before = await generationsOf(indexer);

		await edit(path, `export function createProcessor() { return {\n`);

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
		const path = await aProcessorModuleOnDisk(processorModuleSource({credit: 'to'}));
		const {indexer} = await aRunServing(path, {
			sleep: async (ms, signal) => {
				if (ms <= 0) return;
				await Promise.race([
					parked,
					new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), {once: true})),
				]);
			},
		});
		const incumbent = generationDigestOf(indexer.streamBuilder!.generation);

		const digests: string[] = [];
		for (const save of ['save 1', 'save 2', 'save 3', 'save 4', 'save 5', 'save 6']) {
			await edit(path, processorModuleSource({credit: 'from', marker: save}));
			const answer = await reconfigure(indexer);
			// EVERY call succeeds: accumulating one generation per save would have met
			// the cap (four) on the third and been REFUSED from then on
			expect(answer.status, `${save}: ${JSON.stringify(answer.body)}`).toBe(200);
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
		const path = await aProcessorModuleOnDisk(processorModuleSource({credit: 'to'}));
		const {indexer} = await aRunServing(path);
		await edit(path, processorModuleSource({credit: 'from'}));

		expect((await reconfigure(indexer, {token: undefined})).status).toBe(401);
		// the credential a log shipper holds does not get to start a fold here either
		expect((await reconfigure(indexer, {token: INGEST_TOKEN})).status).toBe(401);

		expect(await generationsOf(indexer)).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------------------------------
// `unchanged` MEANS WHAT IT SAYS, because an identity is DERIVED
// ---------------------------------------------------------------------------------------------------
// A generation is identified by the SHA-256 of the bundle it folds (ADR-0086), so
// every handler edit moves it and a re-read that answers `unchanged` is telling
// the truth: these are the same bytes. There is nothing an author could have
// forgotten to declare.
//
// That is what retired the second half of this endpoint's answer. Under the
// author-DECLARED identity an edit to a handler body alone named the generation
// already held, so `unchanged` read two ways and carried a drift
// report to say which; the declared identity and the report went together
// (`the-declared-version-and-the-drift-report-are-deleted`), and the condition
// cannot occur.
// ---------------------------------------------------------------------------------------------------

describe('a reload that changed nothing answers `unchanged`, and says why', () => {
	it('answers `unchanged` for the same bytes re-read behind the cache breaker', async () => {
		const path = await aProcessorModuleOnDisk(processorModuleSource({credit: 'to'}));
		const {indexer} = await aRunServing(path);
		const incumbent = generationDigestOf(indexer.streamBuilder!.generation);
		const before = await generationsOf(indexer);

		// no edit at all: the same bytes, re-imported behind the cache breaker
		const answer = await reconfigure(indexer);

		expect(answer.status, JSON.stringify(answer.body)).toBe(200);
		expect(answer.body.outcome).toBe('unchanged');
		expect(answer.body.generation?.digest).toBe(incumbent);
		// and it says the one thing that is true of the save: the bytes did not move
		expect(answer.body.message).toContain('BUNDLE');

		// nothing was registered, and the deployment goes on answering from the fold it
		// came up with
		expect(await generationsOf(indexer)).toEqual(before);
		expect((await feedOf(indexer, LOGS.length)).generation).toBe(incumbent);
	});

	it('answers `registered` for a handler edit, with nothing declared and nothing bumped', async () => {
		const path = await aProcessorModuleOnDisk(processorModuleSource({credit: 'to'}));
		const {indexer} = await aRunServing(path);

		// THE EDIT A DEVELOPER ACTUALLY MAKES: a handler body, and no version anywhere to
		// think about. Under the declared identity this was the trap -- an `unchanged`
		// for an edit that really happened -- and it is now unrepresentable.
		await edit(path, processorModuleSource({credit: 'from'}));

		const answer = await reconfigure(indexer);
		expect(answer.status, JSON.stringify(answer.body)).toBe(200);
		expect(answer.body.outcome).toBe('registered');
	});
});
