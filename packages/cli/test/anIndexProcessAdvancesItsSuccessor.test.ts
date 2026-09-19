import type {RunningFetcher} from '@etherfold/platform-nodejs-fetcher';
import {declareEntities} from '@etherfold/state-store';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {createClient} from '@libsql/client';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {index, fetch as startFetch, type IndexDependencies, type RunningReceiver} from '../src/index.js';
import type {Options} from '../src/types.js';
import {abi, ALICE, BOB, fakeChain, SOURCE, START_BLOCK, transfer, ZERO} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// A SPLIT DEPLOYMENT FINISHES A PROCESSOR UPGRADE BY RESTARTING, LIKE THE COMBINED ONE
// ---------------------------------------------------------------------------------------------------
// `packages/cli/test/aRestartFinishesTheUpgrade.test.ts` asserts this END on the
// COMBINED command: `run` stopped and re-run over the same libSQL handle with
// edited bytes, driven until the pointer moves. This file asserts the same end on
// the SPLIT shape, where the same claim rested on a half that did not exist.
//
// Two things have to be true and only one of them was. A successor registered at
// `open` is ARMED from its durable slot (ADR-0084), which landed with the
// combined command. It also has to be ADVANCED, and `rebuildMore` is TWO things
// -- it advances every follower and then SETTLES the pointer -- so a command that
// calls it nowhere is a command whose successor catches up and then sits there
// for ever. `run` calls it in the gap its cycle already waits; `index` had no
// cycle and called it nowhere, so the only route to an upgraded fold on a split
// deployment was deleting a generation by hand.
//
// ## Where the turn comes from here, and why it is a CLOCK
//
// `index` is driven by ARRIVALS: a sender pushes and it folds. ADR-0022 says the
// bounded rebuild is a call the HOST SCHEDULES and never a side effect of a
// write, and ingest is the only other thing that happens in this process, so
// "after each batch" would be exactly that side effect wearing a different hat --
// and it would put a catch-up between a sender and its acknowledgement. So the
// turn is a TIMER, the same answer the scheduled prune beside it already reached
// for the same reason, and the two never run at once over the one handle.
//
// ## What feeds the successor on THIS half, which is the whole difference
//
// Nothing here fetches. A successor registered at `open` is not a follower --
// `add` decides that from "do I already hold a fold on this stream", and at
// `open` the fold list is empty -- so it is fed by the WIRE, which on this
// command means a sender pushing at `/{indexer}/ingest` for ITS OWN
// `{source, config}`. That is why the cases below stand a real `etherfold fetch`
// up against a real port rather than injecting batches by hand: what the tick
// contributes on this shape is the SETTLE, and a suite that fed the successor
// itself would be asserting the settle against a fold nothing in the deployment
// advanced.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'nfts';
/** The shared secret of the wire, under the same name on both halves. */
const TOKEN = 'a-shared-secret';
/** The OPERATOR's secret, which is deliberately not the wire's (ADR-0057). */
const ADMIN_TOKEN = 'the-operators-own-secret';

/** Logs every 10 blocks, so a bounded fetch range takes several pushes to cover them. */
const SPREAD = [10, 20, 30, 40, 50, 60].map((offset, order) =>
	transfer(START_BLOCK + offset, `0xa${offset}`, order === 0 ? ZERO : ALICE, order === 0 ? ALICE : BOB, BigInt(order)),
);
const TIP = START_BLOCK + 100;

/**
 * What a RECEIVER's deployment configures through the environment.
 *
 * No node URL: this half makes no chain call, so its source can only be an
 * EXPLICIT one. The fetch bounds and the waits are the SENDER's, and ride in the
 * same record only because one host runs both halves here.
 */
const DEPLOYMENT = {
	INDEXING_SOURCE: JSON.stringify(SOURCE),
	INGEST_TOKEN: TOKEN,
	INDEXER_NAME: INDEXER,
	MAX_BLOCKS_PER_FETCH: '20',
	POLL_INTERVAL_MS: '5',
	CATCH_UP_DELAY_MS: '0',
	MIN_RETRY_DELAY_MS: '5',
};

/** A database to own and a port to receive on. `--processor` is per case, because its BYTES move. */
const RECEIVING: Omit<Options, 'processor'> = {
	store: 'sqlite',
	db: ':memory:',
	port: '0',
};

/** What the bundles below declare, restated here so a case can read the namespace they folded into. */
const NFT_ENTITIES = declareEntities([{name: 'nft', id: ['tokenID'], fields: {owner: 'text'}}]);

/**
 * THE BUNDLE A DEPLOYMENT SHIPS, as text: an upgrade is an EDIT to these bytes.
 *
 * Self-contained, so the arrival hashes the octets and the generation is named by
 * them (ADR-0086) -- which is what makes "the developer changed a handler and
 * redeployed" a different generation with no author action. It declares no
 * contracts, because this command resolves its source EXPLICITLY
 * (`INDEXING_SOURCE` above) and refuses to read one out of a module: that route
 * can cost an `eth_chainId` call, and this half has no node to ask.
 */
function processorBundleSource(options: {credit: 'to' | 'from'}): string {
	return `export function createProcessor() {
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
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-index-upgrade-'));
	scratch.push(dir);
	const path = join(dir, 'processor.bundle.js');
	await writeFile(path, source, 'utf-8');
	return path;
}

let running: RunningReceiver | undefined;
let sender: RunningFetcher<typeof abi> | undefined;
/** Every startup line the command wrote, so a case can assert what an operator is told. */
let saidAtStartup: string[] = [];

afterEach(async () => {
	await sender?.stop().catch(() => undefined);
	sender = undefined;
	await running?.stop().catch(() => undefined);
	running = undefined;
	saidAtStartup = [];
	for (const dir of scratch.splice(0)) {
		await rm(dir, {recursive: true, force: true}).catch(() => undefined);
	}
	delete process.env.ADMIN_TOKEN;
});

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/**
 * START a receiver over a database that may already hold generations.
 *
 * The handle is the CALLER's, so stopping one and starting the next over the same
 * `db` is a RESTART: the registry rows, the stored stream and every generation's
 * state namespace are exactly where the previous process left them, and the new
 * process remembers nothing.
 *
 * The rebuild tick is set far below its default for the reason the prune suite
 * sets its own low -- to observe a pass without waiting for a deployment's clock.
 * A DEPLOYMENT sets neither.
 */
async function anIndexOver(db: RemoteSQL, processor: string, extra: IndexDependencies = {}): Promise<RunningReceiver> {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	const started = await index(
		{...RECEIVING, processor},
		{
			createDB: () => db,
			handleSignals: false,
			log: (...args: unknown[]) => saidAtStartup.push(args.map(String).join(' ')),
			env: DEPLOYMENT,
			rebuildIntervalSeconds: 0.02,
			...extra,
		},
	);
	running = started;
	return started;
}

/** The real `etherfold fetch`, pushing over a real socket at the receiver's real port. */
async function aSenderAgainst(receiver: RunningReceiver): Promise<RunningFetcher<typeof abi>> {
	const chain = fakeChain().serve(SPREAD, TIP);
	const started = await startFetch<typeof abi>(
		{nodeUrl: 'http://localhost:0', indexer: INDEXER, ingestEndpoint: receiver.url, ingestToken: TOKEN},
		{provider: chain.provider, handleSignals: false, env: DEPLOYMENT},
	);
	sender = started;
	return started;
}

/** Stop both halves the way a redeploy does, leaving the database behind. */
async function stopTheDeployment(): Promise<void> {
	await sender?.stop().catch(() => undefined);
	sender = undefined;
	await running?.stop().catch(() => undefined);
	running = undefined;
}

type SlotListing = {
	generations: {digest: string; canonical: boolean; stream: string; processor: string; slot?: string}[];
};

/** What the operator's own listing says this deployment holds. */
async function listingOf(receiver: RunningReceiver): Promise<SlotListing> {
	const res = await globalThis.fetch(`${receiver.url}/${INDEXER}/admin/canonical-generation`, {
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
	});
	expect(res.status).toBe(200);
	return (await res.json()) as SlotListing;
}

/** WHICH generation answers reads right now. */
async function canonicalOf(receiver: RunningReceiver): Promise<string | undefined> {
	return (await listingOf(receiver)).generations.find((entry) => entry.canonical)?.digest;
}

/**
 * HOW FAR ONE GENERATION HAS GOT, through the seam the promotion trigger itself
 * measures through.
 *
 * NOT `/status`, for the reason the combined restart suite gives: that reporter
 * answers one entry per fold this process HOLDS, and a redeployed process holds
 * no fold for the incumbent -- the previous processor's code is not in this
 * build. It is a row in the incumbent's own table namespace (ADR-0053).
 */
async function positionOf(receiver: RunningReceiver, digest: string): Promise<number | undefined> {
	const target = (await listingOf(receiver)).generations.find((entry) => entry.digest === digest);
	if (!target) throw new Error(`this deployment holds no generation ${digest}`);
	return receiver.container.registry.readStateCursor({stream: target.stream, processor: target.processor});
}

/** What ONE generation's own table namespace holds, opened with no engine (ADR-0053). */
async function ownerOf(receiver: RunningReceiver, digest: string, id: bigint): Promise<string | undefined> {
	const store = new VersionedStateStore(receiver.db, NFT_ENTITIES, {tableNamespace: digest});
	const held = await store.getCurrent<{owner: string}>('nft', {tokenID: id.toString().padStart(78, '0')});
	return held?.owner;
}

/** Poll something the running process publishes until it says what we are waiting for. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Drive a receiver with a real sender until the generation named has folded to the tip. */
async function foldToTheTip(receiver: RunningReceiver, digest: string): Promise<void> {
	await until(
		() => positionOf(receiver, digest),
		(position) => position === TIP,
		`generation ${digest} to reach the tip`,
	);
}

/**
 * A split deployment that folded under one processor, was STOPPED, and is
 * receiving again over the same database with an edited one.
 *
 * The restarted process holds exactly ONE fold, the new one, and it is fed by the
 * WIRE: a fresh sender asks this receiver where to resume, is told the successor's
 * own position, and pushes from there.
 */
async function aRestartWithAChangedProcessor(
	extra: IndexDependencies = {},
): Promise<{db: RemoteSQL; path: string; receiver: RunningReceiver; incumbent: string; successor: string}> {
	const db = oneDatabase();
	const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));

	const first = await anIndexOver(db, path);
	await aSenderAgainst(first);
	const incumbent = (await canonicalOf(first)) as string;
	expect(incumbent, `the first deployment registered no generation`).toBeDefined();
	await foldToTheTip(first, incumbent);
	await stopTheDeployment();

	// THE REDEPLOY: one edited handler at the same path, so the bytes moved and the
	// identity with them, with no author action (ADR-0086).
	await writeFile(path, processorBundleSource({credit: 'from'}), 'utf-8');
	const receiver = await anIndexOver(db, path, extra);
	const successor = (await listingOf(receiver)).generations
		.map((entry) => entry.digest)
		.find((one) => one !== incumbent);
	expect(successor, `the restart registered no successor beside ${incumbent}`).toBeDefined();
	await aSenderAgainst(receiver);
	return {db, path, receiver, incumbent, successor: successor as string};
}

// ---------------------------------------------------------------------------------------------------

describe('an `index` process ADVANCES the successor it registered', () => {
	it('finishes the upgrade on a restart: the pointer moves with nobody asking', async () => {
		const {receiver, incumbent, successor} = await aRestartWithAChangedProcessor();

		// nothing said anything about promotion, so this is the DEFAULT policy -- and
		// the claim is that it now means the same thing on the receiving half as it
		// does on the combined one
		await until(
			() => canonicalOf(receiver),
			(canonical) => canonical === successor,
			'the pointer to move onto the successor',
		);

		// ...and the generation it superseded is RETAINED, which is what keeps the way
		// back real: an upgrade that finished is not an upgrade that deleted anything
		expect((await listingOf(receiver)).generations.map((entry) => entry.digest).sort()).toEqual(
			[incumbent, successor].sort(),
		);
	});

	it('advances the successor to the incumbent, folding the same stream under the NEW handler', async () => {
		const {receiver, incumbent, successor} = await aRestartWithAChangedProcessor();

		await foldToTheTip(receiver, successor);

		// the two generations folded the same logs under DIFFERENT handlers, into their
		// own table namespaces, and both answers are still there: the incumbent credited
		// `to` and the successor credits `from`
		expect(await ownerOf(receiver, incumbent, 1n)).toBe(BOB.toLowerCase());
		expect(await ownerOf(receiver, successor, 1n)).toBe(ALICE.toLowerCase());
	});

	it('leaves the incumbent answering every read until the move, so the upgrade is not an outage', async () => {
		const {receiver, incumbent, successor} = await aRestartWithAChangedProcessor();

		const deadline = Date.now() + 10_000;
		for (;;) {
			const canonical = await canonicalOf(receiver);
			if (canonical === successor) break;
			// every read on the way is answered by the incumbent, from the state it still
			// holds -- which is the point of a successor catching up beside it
			expect(canonical).toBe(incumbent);
			if (Date.now() > deadline) throw new Error(`the deployment never moved onto the successor`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		// ...and the one-writer rule is untouched by any of it: the incumbent is still
		// the OLDEST surviving generation on this stream and therefore still its writer,
		// so nothing the tick did appended a second history beside it
		expect((await listingOf(receiver)).generations.find((entry) => entry.digest === incumbent)).toBeDefined();
	});

	it('does not starve the ingest path this command exists to serve', async () => {
		// the tick at its tightest, far tighter than any deployment's: if the rebuild
		// competed with ingest for the one database handle, this is where the pushes
		// would stop landing
		const {receiver, successor} = await aRestartWithAChangedProcessor({rebuildIntervalSeconds: 0.001});

		await foldToTheTip(receiver, successor);
		// ...and the wire is still answering, which is what this process is FOR
		expect((await globalThis.fetch(`${receiver.url}/status`)).status).toBe(200);
		expect(await ownerOf(receiver, successor, 5n)).toBe(ALICE.toLowerCase());
	});

	it('is the SCHEDULE that finishes it: with no tick the successor catches up and sits there', async () => {
		// the defect itself, named: arming a fold that nothing advances just moves the
		// stall one step later. `0` is the same "no schedule at all" the prune knob
		// already means, and it is a TEST's instrument -- a deployment has no flag for it
		const {receiver, incumbent, successor} = await aRestartWithAChangedProcessor({rebuildIntervalSeconds: 0});

		await foldToTheTip(receiver, successor);
		expect(await positionOf(receiver, incumbent)).toBe(TIP);

		// LEVEL, and the pointer has not moved, because nothing settled it
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(await canonicalOf(receiver)).toBe(incumbent);
	});

	it('moves no pointer when the restart changed nothing, which is the ordinary redeploy', async () => {
		const db = oneDatabase();
		const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
		const first = await anIndexOver(db, path);
		await aSenderAgainst(first);
		const incumbent = (await canonicalOf(first)) as string;
		await foldToTheTip(first, incumbent);
		await stopTheDeployment();

		// the same bytes at the same path: the fold it comes up with is what `canonical`
		// already names, so it is a successor to nothing and the tick has nothing to
		// settle. What it costs is a few registry reads.
		const restarted = await anIndexOver(db, path);
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(await canonicalOf(restarted)).toBe(incumbent);
		expect((await listingOf(restarted)).generations.map((entry) => entry.digest)).toEqual([incumbent]);
	});
});

describe('a successor this half cannot feed itself is said out loud rather than silently stalled', () => {
	it('tells the operator what must push the successor, because this half fetches nothing', async () => {
		const {successor, incumbent} = await aRestartWithAChangedProcessor();

		const notice = saidAtStartup.find((line) => line.includes(successor));
		expect(notice, `the startup said nothing about holding ${successor} beside ${incumbent}`).toBeDefined();
		// WHAT an operator has to know: nothing here fetches, so the successor advances
		// only from what a sender pushes for its own {source, config}
		expect(notice).toContain(incumbent);
		expect(notice).toContain('/ingest');
		expect(notice?.toLowerCase()).toContain('no chain call');
	});

	it('says nothing where the process holds no successor, so the line means something', async () => {
		const db = oneDatabase();
		const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
		const only = await anIndexOver(db, path);

		const canonical = (await canonicalOf(only)) as string;
		expect(canonical).toBeDefined();
		expect(saidAtStartup.some((line) => line.includes(canonical))).toBe(false);
	});
});
