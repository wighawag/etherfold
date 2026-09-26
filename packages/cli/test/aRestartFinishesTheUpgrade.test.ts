import {createClient} from '@libsql/client';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {node, run, type RunningIndexer} from '../src/index.js';
import type {Options} from '../src/types.js';
import {ALICE, BOB, CONTRACT, fakeChain, START_BLOCK, transfer, ZERO} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// A RESTART WITH A CHANGED PROCESSOR FINISHES THE UPGRADE, AND A REVERT SURVIVES ONE
// ---------------------------------------------------------------------------------------------------
// A successor arrives two ways: by an UPLOAD to a `node` that keeps running
// (ADR-0094), and by RESTARTING the deployment with different bytes at `--processor`
// (`theDeploymentSelectsItsPromotionPolicy.test.ts` asserts the policy on both). The
// second is the one a developer does by hand and the one a redeploy does on its
// own, and until ADR-0084's arming landed it could never finish: a generation
// registered at `open` was never armed, the trigger could not be EVALUATED with
// no held fold for the incumbent, and on `run` nothing even called the settle.
// Three separate things, each of which alone leaves the pointer where it was --
// which is why this file asserts the END of it, on a real deployment, rather
// than any one of them.
//
// The SEAM is deliberately the whole command: `run` stood up the way the policy
// suite stands one up, STOPPED, and re-run over the SAME libSQL handle with an
// edited bundle. That is a restart in every way that matters here -- a fresh
// container with an empty memory over the same rows -- and it is the only level
// at which "the upgrade finished" is a claim rather than an inference.
//
// The pair is what makes the narrowing safe, and neither half is sufficient:
//
//   the upgrade FINISHES   a successor registered at `open` takes over once it
//                          has caught the incumbent up;
//   the revert HOLDS       a restart after a deliberate revert does NOT
//                          re-promote what was reverted away from, under any
//                          policy value, unless its CONFIGURATION names it: the
//                          generation `predecessor` names is never armed while it
//                          is there. A `node` (nothing configured) and a `run`
//                          whose `-p` names the reverted-TO generation keep the
//                          revert; a `run` restarted with an unchanged `-p` names
//                          the reverted-FROM generation, and configuration is the
//                          truth on `run` (ADR-0094), so it is RE-ARMED and
//                          promoted like any arrival.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'nfts';
const ADMIN_TOKEN = 'the-operators-own-secret';

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
];
const TIP = START_BLOCK + 50;

/**
 * THE BUNDLE A DEPLOYMENT SHIPS, as text: an upgrade is an EDIT to these bytes.
 *
 * Self-contained, so the arrival hashes the octets and the generation is named by
 * them (ADR-0086) -- which is what makes "the developer changed a handler and
 * restarted" a different generation with no author action.
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

/** ONE path a deployment is pointed at, whose BYTES the cases below rewrite. */
async function aProcessorBundleOnDisk(source: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-restart-'));
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

/**
 * START a deployment over a database that may already hold generations.
 *
 * The handle is the CALLER's, so stopping one and starting the next over the same
 * `db` is a restart: the registry rows, the stored stream and every generation's
 * state namespace are exactly where the previous process left them, and the new
 * process remembers nothing.
 */
async function aRunOver(db: RemoteSQL, processorPath: string, extra?: Partial<Options>): Promise<RunningIndexer> {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	const chain = fakeChain().serve(LOGS, TIP);
	const started = await run(optionsFor(processorPath, extra), {
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
	return started;
}

/** Stop the process the way a redeploy does, leaving its database behind. */
async function stop(): Promise<void> {
	await running?.stop().catch(() => undefined);
	running = undefined;
}

/** READ THE FEED, which says WHICH generation answers reads and serves its answer. */
async function feedOf(indexer: RunningIndexer, expectedEntries?: number): Promise<{generation: string}> {
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

type SlotListing = {
	generations: {digest: string; canonical: boolean; stream: string; processor: string}[];
	slots?: Record<string, {digest: string} | undefined>;
};

/** What the operator's own listing says this deployment holds. */
async function listingOf(indexer: RunningIndexer): Promise<SlotListing> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
	});
	expect(res.status).toBe(200);
	return (await res.json()) as SlotListing;
}

/** WHICH generation answers reads right now. */
async function canonicalOf(indexer: RunningIndexer): Promise<string | undefined> {
	return (await listingOf(indexer)).generations.find((entry) => entry.canonical)?.digest;
}

/** MOVE THE POINTER because an operator asked: the verb no policy value gates. */
async function promote(indexer: RunningIndexer, digest: string): Promise<number> {
	const target = (await listingOf(indexer)).generations.find((entry) => entry.digest === digest);
	if (!target) throw new Error(`this deployment holds no generation ${digest}`);
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		method: 'POST',
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json'},
		body: JSON.stringify({stream: target.stream, processor: target.processor}),
	});
	return res.status;
}

/**
 * HOW FAR ONE GENERATION HAS GOT, through the seam the trigger itself measures
 * through.
 *
 * NOT `/status`, deliberately, and the difference is the restart shape itself:
 * that reporter answers one entry per fold this process HOLDS, and a redeployed
 * process holds no fold for the incumbent -- so the number the promotion compares
 * is not on that page at all. It is a row in the incumbent's own table namespace,
 * and the host that named the tables is what reads it
 * (`GenerationRegistryPort.readStateCursor`, supplied by `openFolding`), with no
 * engine and nothing re-imported.
 */
async function positionOf(indexer: RunningIndexer, digest: string): Promise<number | undefined> {
	const target = (await listingOf(indexer)).generations.find((entry) => entry.digest === digest);
	if (!target) throw new Error(`this deployment holds no generation ${digest}`);
	return indexer.container.registry.readStateCursor({stream: target.stream, processor: target.processor});
}

/**
 * Wait until the successor has caught the incumbent UP, which is the moment
 * `on-catch-up` acts on and the moment `manual` deliberately does not.
 */
async function waitUntilLevel(indexer: RunningIndexer, successor: string, incumbent: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const behind = await positionOf(indexer, successor);
		const ahead = await positionOf(indexer, incumbent);
		if (behind !== undefined && ahead !== undefined && behind >= ahead) return;
		if (Date.now() > deadline) {
			throw new Error(`the successor never became level with the incumbent (${behind} against ${ahead})`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Wait for the pointer to reach a generation, or say what it was still on. */
async function waitUntilCanonical(indexer: RunningIndexer, digest: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const canonical = await canonicalOf(indexer);
		if (canonical === digest) return;
		if (Date.now() > deadline) {
			throw new Error(`the pointer never moved to ${digest}; it is on ${canonical}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/**
 * A deployment that folded under one processor, was STOPPED, and is running again
 * over the same database with an edited one.
 *
 * The previous processor's code is not in this build. Since ADR-0092 `run` still
 * folds it, instantiated at `open` from the bytes stored beside its generation, so
 * the restarted process holds both; the shape where it holds NO fold for the
 * incumbent is pinned at the container seam
 * (`packages/core/test/aSuccessorIsPromotedOverAnIncumbentNoFoldHereHolds.test.ts`).
 */
async function aRestartWithAChangedProcessor(
	extra?: Partial<Options>,
): Promise<{db: RemoteSQL; path: string; indexer: RunningIndexer; incumbent: string; successor: string}> {
	const db = oneDatabase();
	const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
	const first = await aRunOver(db, path);
	await feedOf(first, LOGS.length);
	const incumbent = (await canonicalOf(first)) as string;
	expect(incumbent).toBeDefined();
	await stop();

	// THE REDEPLOY: one edited handler at the same path, so the bytes moved and the
	// identity with them, with no author action (ADR-0086).
	await writeFile(path, processorBundleSource({credit: 'from'}), 'utf-8');
	const indexer = await aRunOver(db, path, extra);
	const successor = (await listingOf(indexer)).generations
		.map((entry) => entry.digest)
		.find((one) => one !== incumbent);
	expect(successor, `the restart registered no successor beside ${incumbent}`).toBeDefined();
	return {db, path, indexer, incumbent, successor: successor as string};
}

// ---------------------------------------------------------------------------------------------------

describe('a restart with a changed processor FINISHES the upgrade', () => {
	it('promotes the successor once it has caught the incumbent up, with nobody asking', async () => {
		const {indexer, incumbent, successor} = await aRestartWithAChangedProcessor();

		// nothing said anything about promotion, so this is the default everywhere --
		// and the whole claim is that it now means the same thing on the restart path
		// as it does on an upload to a running `node`
		await waitUntilCanonical(indexer, successor);
		expect((await feedOf(indexer)).generation).toBe(successor);

		// ...and the generation it superseded is RETAINED, which is what keeps the way
		// back real: an upgrade that finished is not an upgrade that deleted anything
		const listing = await listingOf(indexer);
		expect(listing.generations.map((entry) => entry.digest).sort()).toEqual([incumbent, successor].sort());
	});

	it('leaves the incumbent answering every read until the move, so the upgrade is not an outage', async () => {
		const {indexer, incumbent, successor} = await aRestartWithAChangedProcessor();

		const deadline = Date.now() + 10_000;
		for (;;) {
			const feed = await feedOf(indexer);
			if (feed.generation === successor) break;
			// every read on the way is answered by the incumbent, from the state it still
			// holds -- which is the point of a successor catching up beside it
			expect(feed.generation).toBe(incumbent);
			if (Date.now() > deadline) throw new Error(`the deployment never moved onto the successor`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	});

	it('under `immediate` the restarted successor answers AT ONCE, before it has folded anything', async () => {
		const {indexer, incumbent, successor} = await aRestartWithAChangedProcessor({promotion: 'immediate'});

		// NOT a race and not a poll: the policy acts inside `add`, which is inside
		// `open`, so the pointer had moved before `run` returned -- while the successor
		// had folded nothing. That is what this value buys and what it costs, and it is
		// the same thing it means on an upload to a running `node`: one policy, however
		// the successor arrived.
		expect(await canonicalOf(indexer)).toBe(successor);
		expect((await listingOf(indexer)).generations.map((entry) => entry.digest).sort()).toEqual(
			[incumbent, successor].sort(),
		);
	});

	it('does NOT move its own pointer when the restart changed nothing, under `immediate`', async () => {
		const db = oneDatabase();
		const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
		const first = await aRunOver(db, path, {promotion: 'immediate'});
		await feedOf(first, LOGS.length);
		const incumbent = (await canonicalOf(first)) as string;
		await stop();

		// the ordinary restart of an unchanged deployment: the fold it comes up with is
		// what `canonical` already names, so it is not a successor to anything and the
		// most eager policy value has nothing to say about it. Arming on ARRIVAL rather
		// than on the SLOT is exactly what would move a pointer here for no reason.
		const restarted = await aRunOver(db, path, {promotion: 'immediate'});

		expect(await canonicalOf(restarted)).toBe(incumbent);
		const listing = await listingOf(restarted);
		expect(listing.generations.map((entry) => entry.digest)).toEqual([incumbent]);
	});

	it('still WAITS under `manual`, however level the successor gets', async () => {
		const {indexer, incumbent, successor} = await aRestartWithAChangedProcessor({promotion: 'manual'});

		// LEVEL is the moment the default acts on, so reaching it without a move is the
		// assertion: the slot says what a generation is FOR and the policy still says
		// WHEN, so a successor sitting armed in a slot must not creep forward because
		// the slot exists.
		await waitUntilLevel(indexer, successor, incumbent);
		expect(await positionOf(indexer, incumbent)).toBe(TIP);
		expect(await canonicalOf(indexer)).toBe(incumbent);

		// several more turns of the host's own clock, to say it is a decision and not a
		// delay
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await canonicalOf(indexer)).toBe(incumbent);

		// `manual` means ONLY WHEN ASKED and never NEVER
		expect(await promote(indexer, successor)).toBe(200);
		expect(await canonicalOf(indexer)).toBe(successor);
	});
});

describe('a REVERT survives a restart: what was reverted away from is never re-promoted', () => {
	/** A `run` upgraded by restart, whose operator then moved the pointer BACK, and stopped. */
	async function aRevertedDeployment(): Promise<{db: RemoteSQL; path: string; incumbent: string; successor: string}> {
		const {db, path, indexer, incumbent, successor} = await aRestartWithAChangedProcessor();
		await waitUntilCanonical(indexer, successor);

		// the operator does not like what they see and moves the pointer BACK. The
		// generation reverted away from is caught up BY CONSTRUCTION, so "any level
		// non-canonical generation is promotable" would put the pointer straight back
		// (ADR-0046).
		expect(await promote(indexer, incumbent)).toBe(200);
		expect(await canonicalOf(indexer)).toBe(incumbent);
		await stop();
		return {db, path, incumbent, successor};
	}

	/** The same database, restarted as a `node`: nothing configured, so nothing arrives (ADR-0094). */
	async function aNodeOver(db: RemoteSQL, extra?: Partial<Options>): Promise<RunningIndexer> {
		process.env.ADMIN_TOKEN = ADMIN_TOKEN;
		const {processor: _none, ...rest} = optionsFor('', extra);
		running = await node(rest, {
			provider: fakeChain().serve(LOGS, TIP).provider,
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

	for (const promotion of [undefined, 'immediate'] as const) {
		const under = promotion ?? 'the default';
		it(`holds the pointer where the operator put it on a \`node\` restart, under ${under}`, async () => {
			const {db, incumbent, successor} = await aRevertedDeployment();

			// `predecessor` names the reverted-FROM generation, and nothing ARRIVES to move
			// it: a `node` is configured with no code, so the most eager policy there is has
			// nothing in `successor` to promote.
			const restarted = await aNodeOver(db, promotion ? {promotion} : {});
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(await canonicalOf(restarted)).toBe(incumbent);
			expect((await feedOf(restarted)).generation).toBe(incumbent);
			expect((await listingOf(restarted)).slots?.predecessor?.digest).toBe(successor);
		});

		it(`holds it on a \`run\` whose \`-p\` names the reverted-TO generation, under ${under}`, async () => {
			const {db, path, incumbent, successor} = await aRevertedDeployment();
			// the revert made durable in configuration: the path carries the reverted-TO bytes again
			await writeFile(path, processorBundleSource({credit: 'to'}), 'utf-8');

			const restarted = await aRunOver(db, path, promotion ? {promotion} : {});
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(await canonicalOf(restarted)).toBe(incumbent);
			expect((await listingOf(restarted)).generations.map((entry) => entry.digest).sort()).toEqual(
				[incumbent, successor].sort(),
			);
			expect((await listingOf(restarted)).slots?.predecessor?.digest).toBe(successor);
		});
	}

	it('is rolled FORWARD by a `run` restarted with an unchanged `-p`: configuration is the truth on `run` (ADR-0094)', async () => {
		const {db, path, incumbent, successor} = await aRevertedDeployment();

		// the SAME bytes the operator reverted away from, which is what a redeploy of the
		// unchanged build does. Its `-p` names what `predecessor` holds, which is an
		// ARRIVAL of it: re-armed into `successor`, level, and promoted like any successor.
		// A revert on `run` that should outlive a restart is made by changing `-p` too.
		const restarted = await aRunOver(db, path);

		await waitUntilCanonical(restarted, successor);
		expect((await listingOf(restarted)).slots?.predecessor?.digest).toBe(incumbent);
	});
});
