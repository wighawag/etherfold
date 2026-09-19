import {generationDigestOf, type PromotionPolicy} from '@etherfold/core';
import {createClient} from '@libsql/client';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {run, type RunningIndexer} from '../src/index.js';
import type {Options} from '../src/types.js';
import {ALICE, BOB, CONTRACT, fakeChain, START_BLOCK, transfer, ZERO} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// AN OPERATOR SAYS WHEN A SUCCESSOR TAKES OVER, AND THE DEPLOYMENT DOES THAT
// ---------------------------------------------------------------------------------------------------
// `packages/cli/test/configuration.test.ts` asserts the INPUT: one name, a flag
// that beats the variable, a refusal for a value nobody recognises, and an
// ownership row per command. This file asserts the thing the input is FOR, and
// there is only one honest way to assert it: stand a deployment up under each
// policy and watch WHEN the canonical pointer actually moves.
//
// The three are three different moments and the difference is the whole feature:
//
//   immediate     the successor is canonical the moment it is REGISTERED, before
//                 it has folded anything -- what a developer iterating on a
//                 handler wants, because stale-but-complete answers from the fold
//                 they just replaced are more confusing than incomplete answers
//                 from the new one;
//   on-catch-up   it takes over when it reaches the cursor the incumbent had,
//                 which is the DEFAULT everywhere and what an app shipping to
//                 users wants;
//   manual        it never takes over on its own, however level it gets, until
//                 somebody asks -- so an operator can inspect a successor before
//                 it answers anybody.
//
// The successor is introduced exactly as a deployment introduces one: an EDIT to
// the processor bundle on disk and `POST /{indexer}/admin/reconfigure`. That is
// what makes the assertion honest rather than a test of `container.add` wearing a
// command line -- and it is the only way a successor reaches a RUNNING CLI
// deployment, which is why `run` is the one command that owns this input.
//
// The OTHER way one arrives is by RESTARTING the deployment with different bytes,
// which is what a redeploy does, and the three values mean the same three things
// there: `packages/cli/test/aRestartFinishesTheUpgrade.test.ts` asserts them on
// that path (ADR-0084). The cases below are deliberately NOT rewritten onto the
// shorter path now that one exists -- what they assert is the reconfigure
// ENDPOINT's behaviour, which nothing else covers.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'nfts';
const ADMIN_TOKEN = 'the-operators-own-secret';

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
];
const TIP = START_BLOCK + 50;

/**
 * THE PROCESSOR BUNDLE A DEPLOYMENT SHIPS, as text: a successor is an EDIT to
 * these bytes and nothing else.
 *
 * It is SELF-CONTAINED -- the ABI is inline, so it expects nobody else to resolve
 * anything -- which is exactly what makes it a BUNDLE (`unresolvedImportsOf`,
 * `@etherfold/utils`), so the deployment's arrival reads it, hashes it, and names
 * the generation by the SHA-256 of these octets (ADR-0086). Nothing bundles
 * anything here: writing self-contained bytes to disk IS the artifact, and a test
 * that reached for `esbuild` to obtain an identity would have misread the design.
 *
 * These cases are about WHEN THE POINTER MOVES, so what matters is only that the
 * successor is a DIFFERENT fold from the incumbent. Under the arrival that is one
 * changed handler line -- the edit a developer actually makes -- rather than a
 * `version` bump they had to remember, which is the whole of what ADR-0086 buys.
 */
function processorBundleSource(options: {credit: 'to' | 'from'}): string {
	return `const abi = [
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

/** The scratch directories these cases write processor bundles into, outside the repository. */
const scratch: string[] = [];

async function aProcessorBundleOnDisk(source: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-promotion-'));
	scratch.push(dir);
	const path = join(dir, 'processor.bundle.js');
	await writeFile(path, source, 'utf-8');
	return path;
}

let running: RunningIndexer | undefined;

afterEach(async () => {
	await running?.stop().catch(() => undefined);
	running = undefined;
	for (const dir of scratch.splice(0)) {
		await rm(dir, {recursive: true, force: true}).catch(() => undefined);
	}
	delete process.env.ADMIN_TOKEN;
});

/** The command line a deployment is stood up with, plus whatever it says about promotion. */
function optionsFor(processor: string, promotion?: Partial<Options>): Options {
	return {
		processor,
		nodeUrl: 'http://localhost:0',
		store: 'sqlite',
		db: ':memory:',
		port: '0',
		indexer: INDEXER,
		...promotion,
	};
}

/** A `run` that has folded `LOGS` and is answering, under whatever promotion it was given. */
async function aRunServing(processorPath: string, promotion?: Partial<Options>): Promise<RunningIndexer> {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	const chain = fakeChain().serve(LOGS, TIP);
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	const started = await run(optionsFor(processorPath, promotion), {
		provider: chain.provider,
		createDB: () => db,
		sleep: async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
		},
		handleSignals: false,
		log: () => {},
		env: {MAX_BLOCKS_PER_FETCH: '20'},
	});
	running = started;
	await feedOf(started, LOGS.length);
	return started;
}

/** READ THE FEED, refusing anything but a served answer: the incumbent answers throughout. */
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

/** WHAT A WATCHER DOES after its rebuild: one call, no body. */
async function reconfigure(indexer: RunningIndexer): Promise<{outcome?: string; generation?: {digest: string}}> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/reconfigure`, {
		method: 'POST',
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
	});
	const body = (await res.json()) as {outcome?: string; generation?: {digest: string}};
	expect(res.status, JSON.stringify(body)).toBe(200);
	return body;
}

/** Every generation this deployment holds, as the operator's own listing reports them. */
async function generationsOf(indexer: RunningIndexer): Promise<{digest: string; canonical: boolean}[]> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as {generations: {digest: string; canonical: boolean}[]}).generations;
}

/** WHICH generation answers reads right now. */
async function canonicalOf(indexer: RunningIndexer): Promise<string | undefined> {
	return (await generationsOf(indexer)).find((entry) => entry.canonical)?.digest;
}

/** MOVE THE POINTER because an operator asked: the verb no policy value gates. */
async function promote(indexer: RunningIndexer, generation: {stream: string; processor: string}): Promise<number> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		method: 'POST',
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json'},
		body: JSON.stringify(generation),
	});
	return res.status;
}

type StatusBody = {
	promotion?: {reported: boolean; policy?: string; dropOnPromotion?: boolean; reason?: string};
	cursor: {generations?: {generation: string; canonical: boolean; value?: {lastToBlock: number}}[]};
};

async function statusOf(indexer: RunningIndexer): Promise<StatusBody> {
	const res = await fetch(`${indexer.url}/status`);
	const body = (await res.json()) as StatusBody;
	expect(res.status, JSON.stringify(body)).toBe(200);
	return body;
}

/**
 * Wait until the successor has caught the incumbent UP, which is the moment
 * `on-catch-up` acts on and the moment `manual` deliberately does not.
 *
 * Asserted off `/status`, which is where the rebuild is already visible: an entry
 * with no `value` has folded nothing, and level means its `lastToBlock` has
 * reached the number the entry that was canonical when the successor was created
 * carries.
 */
async function waitUntilLevel(indexer: RunningIndexer, successor: string, incumbent: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const entries = (await statusOf(indexer)).cursor.generations ?? [];
		const behind = entries.find((entry) => entry.generation === successor)?.value?.lastToBlock;
		const ahead = entries.find((entry) => entry.generation === incumbent)?.value?.lastToBlock;
		if (behind !== undefined && ahead !== undefined && behind >= ahead) return;
		if (Date.now() > deadline) throw new Error(`the successor never became level with the incumbent`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** A deployment that has folded, has been edited, and has registered the successor that edit names. */
async function aDeploymentWithASuccessor(
	promotion?: Partial<Options>,
): Promise<{indexer: RunningIndexer; incumbent: string; successor: string}> {
	const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
	const indexer = await aRunServing(path, promotion);
	const incumbent = generationDigestOf(indexer.streamBuilder!.generation);

	// THE REBUILD a watcher notices: one edited handler at the same path, so the
	// bytes moved and the identity with them, with no author action
	await writeFile(path, processorBundleSource({credit: 'from'}), 'utf-8');
	const registered = await reconfigure(indexer);
	expect(registered.outcome).toBe('registered');
	const successor = registered.generation?.digest as string;
	expect(successor).not.toBe(incumbent);
	return {indexer, incumbent, successor};
}

// ---------------------------------------------------------------------------------------------------

describe('`--promotion immediate`: the successor answers the moment it exists', () => {
	it('has already moved the pointer by the time the reconfigure has answered', async () => {
		const {indexer, incumbent, successor} = await aDeploymentWithASuccessor({promotion: 'immediate'});

		// NOT a race and not a poll: the policy acts INSIDE `add`, which is inside the
		// call that registered the successor, so the pointer has moved before the
		// watcher's request came back -- while the successor has folded NOTHING. That is
		// the whole of what this value buys and the whole of what it costs.
		expect(await canonicalOf(indexer)).toBe(successor);
		const entries = (await statusOf(indexer)).cursor.generations ?? [];
		expect(entries.find((entry) => entry.generation === incumbent)?.canonical).toBe(false);

		// and the deployment SAYS which value it is running under, so an operator
		// confirms it rather than inferring it from the move they just watched
		expect((await statusOf(indexer)).promotion).toEqual({
			reported: true,
			policy: 'immediate',
			dropOnPromotion: false,
		});
	});
});

describe('the DEFAULT is unchanged: the successor takes over when it has caught up', () => {
	it('keeps the incumbent answering until the rebuild is level, then moves on its own', async () => {
		const {indexer, incumbent, successor} = await aDeploymentWithASuccessor();

		// nothing was said, so what runs is what ran before this input existed -- and
		// it is reported as the RESOLVED value rather than as the absence that was
		// configured
		expect((await statusOf(indexer)).promotion).toEqual({
			reported: true,
			policy: 'on-catch-up',
			dropOnPromotion: false,
		});

		const deadline = Date.now() + 10_000;
		for (;;) {
			const feed = await feedOf(indexer, LOGS.length);
			if (feed.generation === successor) break;
			// every read on the way is a COMPLETE answer from the incumbent, which is
			// what this value exists to buy
			expect(feed.generation).toBe(incumbent);
			if (Date.now() > deadline) throw new Error(`the deployment never moved onto the successor`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(await canonicalOf(indexer)).toBe(successor);
	});
});

describe('`--promotion manual`: it moves only when asked', () => {
	it('leaves the pointer alone even once the successor is LEVEL, and moves it when an operator asks', async () => {
		const {indexer, incumbent, successor} = await aDeploymentWithASuccessor({promotion: 'manual'});

		expect((await statusOf(indexer)).promotion).toMatchObject({reported: true, policy: 'manual'});

		// LEVEL is the moment the default acts on, so reaching it without a move is the
		// assertion: under `on-catch-up` the pointer moves in the very call that made
		// the successor level, so observing level-and-not-canonical cannot be a race
		// that resolves later.
		await waitUntilLevel(indexer, successor, incumbent);
		expect(await canonicalOf(indexer)).toBe(incumbent);
		expect((await feedOf(indexer, LOGS.length)).generation).toBe(incumbent);

		// several more cycles of the host's own clock, to say it is a decision and not a
		// delay
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await canonicalOf(indexer)).toBe(incumbent);

		// `manual` means ONLY WHEN ASKED and never NEVER: the verb an operator calls is
		// ungated under every value.
		const target = (await generationsOf(indexer)).find((entry) => entry.digest === successor) as unknown as {
			stream: string;
			processor: string;
		};
		expect(await promote(indexer, {stream: target.stream, processor: target.processor})).toBe(200);
		expect(await canonicalOf(indexer)).toBe(successor);
	});
});

describe('the combination this runtime cannot honour is refused BEFORE anything folds', () => {
	it('refuses `--promotion immediate --drop-on-promotion` at start-up, naming what to use instead', async () => {
		const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
		const chain = fakeChain().serve(LOGS, TIP);
		await expect(
			run(optionsFor(path, {promotion: 'immediate', dropOnPromotion: true}), {
				provider: chain.provider,
				createDB: () => new RemoteLibSQL(createClient({url: ':memory:'})),
				handleSignals: false,
				log: () => {},
			}),
		).rejects.toThrow(/--promotion immediate with --drop-on-promotion is not available on this runtime/);

		// ...and it never dialled the chain: this is a CONFIGURATION refusal, made by
		// the pure resolver before a module is imported, a database is opened or a port
		// is bound, rather than one surfacing from inside the container afterwards
		expect(chain.calls ?? []).toEqual([]);
	});

	it('accepts either half on its own, because only the pair is unbuildable here', async () => {
		const {indexer} = await aDeploymentWithASuccessor({dropOnPromotion: true});
		expect((await statusOf(indexer)).promotion).toEqual({
			reported: true,
			policy: 'on-catch-up',
			dropOnPromotion: true,
		});
	});
});

describe('every value the type names is reachable from a command line', () => {
	const policies: readonly PromotionPolicy[] = ['on-catch-up', 'immediate', 'manual'];

	for (const policy of policies) {
		it(`stands a deployment up under \`--promotion ${policy}\` and reports it back`, async () => {
			const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
			const indexer = await aRunServing(path, {promotion: policy});
			expect((await statusOf(indexer)).promotion).toMatchObject({reported: true, policy});
		});
	}
});
