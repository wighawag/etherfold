import {serializeWireBatch, type LogEvent, type WireBatch} from '@etherfold/core';
import type {RunningFetcher} from '@etherfold/platform-nodejs-fetcher';
import {afterEach, describe, expect, it} from 'vitest';
import {
	canonicalStateNamespaceIn,
	index,
	fetch as startFetch,
	type IndexDependencies,
	type RunningReceiver,
} from '../src/index.js';
import type {StoreCursorReport} from '../src/cursorReport.js';
import type {Options} from '../src/types.js';
import {abi, ALICE, BOB, entityModule, fakeChain, SOURCE, START_BLOCK, transfer, ZERO} from './utils/chain.js';
import {INDEXER} from './utils/receiver.js';

// ---------------------------------------------------------------------------------------------------
// `etherfold index`: THE RECEIVING HALF, AS A COMMAND
// ---------------------------------------------------------------------------------------------------
// The half a split deployment was missing. `fetch` has been runnable all along;
// what nothing assembled was a server that HOLDS a processor, so a pushed batch
// met a `501` and a split deployment had a sender and no receiver.
//
// It is driven here THE WAY THE SUBCOMMAND DRIVES IT -- `index(options, deps)`
// is what the registered action reaches through `indexMain` -- and everything
// below it is the shipped thing: a real libSQL database, a real HTTP server on a
// real port, the real `StreamBuilder` -> `EntityEventProcessor` ->
// `VersionedStateStore` chain, and on the other end of the wire the real
// `etherfold fetch` command pushing over a real socket. Only the NODE is fake,
// and it is fake on the SENDER's side, which is the only side that has one.
//
// ## The structural claim this file rests on: there is no chain here
//
// `IndexDependencies` has no `provider`, because this command's path constructs
// none: it builds no `LogFetcher` and no fetcher host, and its source can only
// be an explicit one. That is asserted below in the two places it is
// observable -- `-n` is refused by name, and a source that could only be read
// out of a processor module (which costs an `eth_chainId` call) is refused
// naming both explicit forms -- rather than left to inspection.
// ---------------------------------------------------------------------------------------------------

/** The shared secret of the wire, under the same name on both sides. */
const TOKEN = 'a-shared-secret';

/**
 * The OPERATOR's secret, which is deliberately NOT the wire's: the pointer
 * surface fails closed under its own `ADMIN_TOKEN` (ADR-0057), so a sender's
 * credential opens nothing there.
 */
const ADMIN_TOKEN = 'an-operator-secret';

const AUTHENTICATED = {Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json'};

/**
 * What a RECEIVER's deployment configures through the environment: what it
 * indexes, and the secret it authenticates pushes with.
 *
 * There is no node URL here and no endpoint to push to, which is the whole shape
 * of this command. The fetch bounds and the waits are the SENDER's, and are
 * carried in the same record only because one host runs both sides in this test.
 */
const DEPLOYMENT = {
	INDEXING_SOURCE: JSON.stringify(SOURCE),
	INGEST_TOKEN: TOKEN,
	// the NAMED INDEXER this process registers, and the one a sender addresses:
	// both halves read it under the same name (ADR-0036)
	INDEXER_NAME: INDEXER,
	MAX_BLOCKS_PER_FETCH: '20',
	POLL_INTERVAL_MS: '5',
	CATCH_UP_DELAY_MS: '0',
	MIN_RETRY_DELAY_MS: '5',
};

/** The flags: a processor to fold, a database to own, and a port to receive on. */
const RECEIVING: Options = {
	processor: './nfts.js',
	store: 'sqlite',
	db: ':memory:',
	// 0 asks the OS for a free port, which is what makes the suite runnable on a
	// machine that is already serving something on 2000
	port: '0',
};

/** Logs every 10 blocks, so a bounded fetch range takes several cycles to cover them. */
const SPREAD = [10, 20, 30, 40, 50, 60, 70, 80].map((offset, order) =>
	transfer(START_BLOCK + offset, `0xa${offset}`, order === 0 ? ZERO : ALICE, order === 0 ? ALICE : BOB, BigInt(order)),
);
const TIP = START_BLOCK + 100;

let running: RunningReceiver | undefined;
let sender: RunningFetcher<typeof abi> | undefined;

afterEach(async () => {
	await sender?.stop().catch(() => undefined);
	sender = undefined;
	await running?.stop().catch(() => undefined);
	running = undefined;
});

function depsFor(extra: IndexDependencies = {}): IndexDependencies {
	return {
		importModule: async () => entityModule,
		// the test runner's process is not this command's to install handlers on
		handleSignals: false,
		log: () => {},
		env: DEPLOYMENT,
		...extra,
	};
}

/** The real `etherfold fetch`, pushing over a real socket at the receiver's real port. */
async function senderAgainst(
	receiver: RunningReceiver,
	chain: ReturnType<typeof fakeChain>,
	token = TOKEN,
): Promise<RunningFetcher<typeof abi>> {
	return startFetch<typeof abi>(
		{nodeUrl: 'http://localhost:0', indexer: INDEXER, ingestEndpoint: receiver.url, ingestToken: token},
		{provider: chain.provider, handleSignals: false, env: DEPLOYMENT},
	);
}

/** What `/status` says about the cursor, over real HTTP, exactly as an operator would read it. */
async function statusCursor(url: string): Promise<StoreCursorReport | undefined> {
	const res = await globalThis.fetch(`${url}/status`);
	const body = (await res.json()) as {cursor?: {reported: boolean; value?: StoreCursorReport}};
	return body.cursor?.reported ? body.cursor.value : undefined;
}

async function transfersIn(receiver: RunningReceiver): Promise<number> {
	return (await receiver.store.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value ?? 0;
}

async function ownerOf(receiver: RunningReceiver, id: bigint): Promise<string | undefined> {
	return (await receiver.store.getCurrent<{owner: string}>('nft', {tokenID: id.toString().padStart(78, '0')}))?.owner;
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

/** A batch in the shape the wire takes, asserting the identity this receiver indexes. */
function batchFor(receiver: RunningReceiver, fromBlock: number, toBlock: number): string {
	return serializeWireBatch({
		context: receiver.streamBuilder.context,
		fromBlock,
		toBlock,
		latestBlock: TIP,
		logs: [] as LogEvent<typeof abi>[],
	} as WireBatch<typeof abi>);
}

// ---------------------------------------------------------------------------------------------------

describe('the receiver runs, folds what is pushed to it, and keeps running', () => {
	it('lands every pushed log in the database it owns, and reports a cursor that ADVANCES', async () => {
		running = await index(RECEIVING, depsFor());
		const chain = fakeChain().serve(SPREAD, TIP);

		// it is answering before anything has been pushed, and it says so honestly
		// rather than inventing a block 0
		expect((await globalThis.fetch(`${running.url}/status`)).status).toBe(200);
		expect(await statusCursor(running.url)).toBeUndefined();

		sender = await senderAgainst(running, chain);

		const landed = await until(
			() => statusCursor(running!.url),
			(cursor) => cursor?.lastToBlock === TIP,
			'the cursor to reach the tip',
		);
		expect(landed!.latestBlock).toBe(TIP);
		expect(await transfersIn(running)).toBe(SPREAD.length);
		expect(await ownerOf(running, 0n)).toBe(ALICE.toLowerCase());

		// a receiver does not terminate: the sender is at the tip and this process is
		// still up, still answering, still holding the cursor
		expect((await globalThis.fetch(`${running.url}/status`)).status).toBe(200);
	});

	it('hosts the ingestion CAPABILITY, so the wire routes work rather than answering 501', async () => {
		running = await index(RECEIVING, depsFor());

		const asked = await globalThis.fetch(`${running.url}/${INDEXER}/ingest/expected-from-block`, {
			method: 'POST',
			headers: AUTHENTICATED,
		});

		expect(asked.status).toBe(200);
		const answer = (await asked.json()) as {contexts: {expectedFromBlock: number; context: unknown}[]};
		// ONE PAIR PER LIVE WIRE CONTEXT, and this command holds one fold. Nothing has
		// been folded, so the answer is the earliest block this source can have
		// anything to say about -- and it came from a stream-builder this server HOSTS,
		// which is the difference between `index` and every other command
		expect(answer.contexts).toEqual([{expectedFromBlock: START_BLOCK, context: running.streamBuilder.context}]);
	});

	it('registers exactly the NAME it was given, and refuses every other rather than defaulting', async () => {
		// one indexer per process here, and it is still NAMED: a sender configured with
		// another name is refused (404) instead of quietly feeding the only stream-builder
		// this host holds
		running = await index(RECEIVING, depsFor());

		const elsewhere = await globalThis.fetch(`${running.url}/another-name/ingest/expected-from-block`, {
			method: 'POST',
			headers: AUTHENTICATED,
		});

		expect(elsewhere.status).toBe(404);
		expect(((await elsewhere.json()) as {error: string}).error).toBe('unknown-indexer');
		// and the UNNAMESPACED pair the old wire used is gone rather than left live
		for (const path of ['/ingest', '/ingest/expected-from-block']) {
			expect(
				(await globalThis.fetch(`${running.url}${path}`, {method: 'POST', headers: AUTHENTICATED, body: '{}'})).status,
			).toBe(404);
		}
	});

	it('resolves its NAME to a generation container, so the pointer surface answers here', async () => {
		// The name resolves to a container over a durable registry rather than to a bare
		// receiver, so this half can answer the two OPTIONAL questions a registry entry
		// may hold: what there is to point AT, and the move itself (ADR-0057). A host
		// holding one fold and no registry answers `501 generations-not-held` to both,
		// which is what this command used to do.
		process.env.ADMIN_TOKEN = ADMIN_TOKEN;
		try {
			running = await index(RECEIVING, depsFor());

			const listed = await globalThis.fetch(`${running.url}/${INDEXER}/admin/canonical-generation`, {
				headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
			});
			expect(listed.status).toBe(200);
			const body = (await listed.json()) as {
				indexer: string;
				canonical?: {generation: string; stream: string; processor: string};
				generations: {generation: string; canonical: boolean}[];
			};

			// ONE fold, registered as ONE generation, and the pointer names it: the first
			// generation registered takes the pointer, which is the registry's own rule
			expect(body.indexer).toBe(INDEXER);
			expect(body.generations).toHaveLength(1);
			expect(body.generations[0]).toMatchObject({canonical: true});
			expect(body.canonical).toMatchObject({
				stream: running.streamBuilder.generation.stream,
				processor: running.streamBuilder.generation.processor,
			});
			// ...and it is the generation the container holds, not a second opinion about it
			expect((await running.container.generations()).map((record) => record.processor)).toEqual([
				running.streamBuilder.generation.processor,
			]);

			// the guard is the ADMIN one and fails closed: it is deliberately not the ingest
			// credential, so a sender's token opens nothing here
			expect(
				(await globalThis.fetch(`${running.url}/${INDEXER}/admin/canonical-generation`, {headers: AUTHENTICATED}))
					.status,
			).toBe(401);
		} finally {
			delete process.env.ADMIN_TOKEN;
		}
	});

	it('answers no query API beyond /status, because that is the whole query surface', async () => {
		running = await index(RECEIVING, depsFor());

		expect((await globalThis.fetch(`${running.url}/status`)).status).toBe(200);
		for (const route of ['/graphql', '/query', '/sql', '/entities/nft', '/nft/1']) {
			expect((await globalThis.fetch(`${running.url}${route}`)).status).toBe(404);
			expect(
				(await globalThis.fetch(`${running.url}${route}`, {method: 'POST', headers: AUTHENTICATED, body: '{}'})).status,
			).toBe(404);
		}
	});
});

// ---------------------------------------------------------------------------------------------------
// THE RECEIVER AUTHENTICATES, OR IT REFUSES EVERYONE
// ---------------------------------------------------------------------------------------------------

describe('a push nobody authenticated is refused', () => {
	it('refuses the wrong secret with a 401 that names the variable, applying nothing', async () => {
		running = await index(RECEIVING, depsFor());

		const pushed = await globalThis.fetch(`${running.url}/${INDEXER}/ingest`, {
			method: 'POST',
			headers: {Authorization: 'Bearer not-the-token', 'Content-Type': 'application/json'},
			body: batchFor(running, START_BLOCK, START_BLOCK + 10),
		});

		expect(pushed.status).toBe(401);
		expect(JSON.stringify(await pushed.json())).toMatch(/INGEST_TOKEN/);
		// the same guard covers the question as well as the write: this surface is the
		// fetcher's private API, and one rule for all of it is one rule to get wrong
		expect(
			(await globalThis.fetch(`${running.url}/${INDEXER}/ingest/expected-from-block`, {method: 'POST'})).status,
		).toBe(401);
		expect(await transfersIn(running)).toBe(0);
	});

	it('refuses to START at all with no secret configured, rather than opening a write endpoint', async () => {
		let started = 0;
		const {INGEST_TOKEN, ...noSecret} = DEPLOYMENT;

		await expect(
			index(
				RECEIVING,
				depsFor({
					env: noSecret,
					startServer: async () => {
						started++;
						throw new Error('a receiver with no secret must never reach a port');
					},
				}),
			),
		).rejects.toThrow(/--ingest-token \(INGEST_TOKEN\) is required by `etherfold index`/);
		expect(started).toBe(0);
	});

	it('checks the secret this COMMAND resolved, so a flag beats an ambient variable', async () => {
		// The command resolves the secret through the shared configuration path and
		// hands it to the host, rather than leaving the host to read whatever
		// `INGEST_TOKEN` the machine happens to carry. On a host running both halves
		// side by side that is the difference between authenticating the sender you
		// configured and authenticating the one the environment did.
		process.env.INGEST_TOKEN = 'the-ambient-one';
		try {
			running = await index({...RECEIVING, ingestToken: 'the-one-that-was-typed'}, depsFor());

			const ambient = await globalThis.fetch(`${running.url}/${INDEXER}/ingest/expected-from-block`, {
				method: 'POST',
				headers: {Authorization: 'Bearer the-ambient-one'},
			});
			expect(ambient.status).toBe(401);

			const typed = await globalThis.fetch(`${running.url}/${INDEXER}/ingest/expected-from-block`, {
				method: 'POST',
				headers: {Authorization: 'Bearer the-one-that-was-typed'},
			});
			expect(typed.status).toBe(200);
		} finally {
			delete process.env.INGEST_TOKEN;
		}
	});

	it('fails CLOSED: a sender with the wrong secret lands nothing and exits on the refusal', async () => {
		running = await index(RECEIVING, depsFor());
		const chain = fakeChain().serve(SPREAD, TIP);

		const wrong = await senderAgainst(running, chain, 'not-the-token').catch((err) => err);
		if (!(wrong instanceof Error)) {
			sender = wrong;
			await until(
				async () => wrong.host.cyclesRun,
				(cycles) => cycles > 0,
				'the sender to try once',
			);
		}

		expect(await transfersIn(running)).toBe(0);
	});
});

// ---------------------------------------------------------------------------------------------------
// THE CURSOR IS THE IDEMPOTENCY KEY, AND A SENDER THAT FELL BEHIND IS CORRECTED
// ---------------------------------------------------------------------------------------------------

describe('the pushed-batch path is idempotent by cursor', () => {
	it('refuses a replayed batch with a 409 carrying where to resume, applying nothing twice', async () => {
		running = await index(RECEIVING, depsFor());
		const chain = fakeChain().serve(SPREAD, TIP);
		sender = await senderAgainst(running, chain);

		await until(
			() => statusCursor(running!.url),
			(cursor) => cursor?.lastToBlock === TIP,
			'the cursor to reach the tip',
		);
		const folded = await transfersIn(running);

		// the lost-acknowledgement case and the restarted-sender case in one: a batch
		// that starts where the FIRST one started, long after the cursor moved past it
		const replayed = await globalThis.fetch(`${running.url}/${INDEXER}/ingest`, {
			method: 'POST',
			headers: AUTHENTICATED,
			body: batchFor(running, START_BLOCK, START_BLOCK + 10),
		});

		expect(replayed.status).toBe(409);
		const refusal = (await replayed.json()) as {error: string; expectedFromBlock: number};
		expect(refusal.error).toBe('unexpected-fromBlock');
		expect(refusal.expectedFromBlock).toBeGreaterThan(START_BLOCK);
		expect(await transfersIn(running)).toBe(folded);

		// ...and the refusal is RESUMABLE: re-sending from the block it named is
		// accepted, which is the whole correction protocol and needs no operator
		const corrected = await globalThis.fetch(`${running.url}/${INDEXER}/ingest`, {
			method: 'POST',
			headers: AUTHENTICATED,
			body: batchFor(running, refusal.expectedFromBlock, TIP),
		});
		expect(corrected.status).toBe(200);
		expect(await transfersIn(running)).toBe(folded);
	});
});

// ---------------------------------------------------------------------------------------------------
// ONE DATABASE, BUILT ONCE
// ---------------------------------------------------------------------------------------------------

describe('the state store and the server share ONE database handle', () => {
	it('builds it once and hands the same object to both', async () => {
		const {createClient} = await import('@libsql/client');
		const {RemoteLibSQL} = await import('remote-sql-libsql');
		const db = new RemoteLibSQL(createClient({url: ':memory:'}));
		let built = 0;

		running = await index(
			RECEIVING,
			depsFor({
				createDB: () => {
					built++;
					return db;
				},
			}),
		);

		expect(built).toBe(1);
		expect(running.db).toBe(db);

		// ...and it cannot pass by accident, which is why this reads the SERVER's own
		// fixed table through the handle the STORE folds into: the server applies that
		// schema at startup, and a server that had opened `:memory:` for itself would
		// not even be talking to this database
		const meta = await db.prepare(`SELECT value FROM _meta WHERE key = 'schemaVersion'`).all<{value: string}>();
		expect(meta.results.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------------------------------
// NO CHAIN CALL, WHICH IS WHAT CONSTRAINS HOW IT RESOLVES ITS SOURCE
// ---------------------------------------------------------------------------------------------------

describe('the receiver is chain-free, and its refusals say so', () => {
	it('accepts no node URL, naming what this command is instead', async () => {
		let started = 0;
		await expect(
			index({...RECEIVING, nodeUrl: 'http://localhost:8545'}, depsFor({startServer: async () => started++ as never})),
		).rejects.toThrow(/--node-url \(ETH_NODE_URI\) is not accepted by `etherfold index`/);
		expect(started).toBe(0);
	});

	it('refuses a source it could only read by asking a node, naming both explicit forms', async () => {
		let built = 0;
		let started = 0;
		const {INDEXING_SOURCE, ...noSource} = DEPLOYMENT;

		const refused = index(
			RECEIVING,
			depsFor({
				env: noSource,
				createDB: () => {
					built++;
					throw new Error('a refused configuration must never open a database');
				},
				startServer: async () => {
					started++;
					throw new Error('a refused configuration must never reach a port');
				},
			}),
		);

		await expect(refused).rejects.toThrow(/--deployments \(INDEXING_SOURCE\) is required by `etherfold index`/);
		await expect(refused).rejects.toThrow(/NO chain call/);
		await expect(refused).rejects.toThrow(/INDEXING_SOURCE as JSON/);
		expect(built).toBe(0);
		expect(started).toBe(0);
	});

	it('folds a module that keys its contracts per chain, from the source it was GIVEN', async () => {
		// `entityModule` carries `contractsDataPerChain`, which is exactly the shape
		// that would cost an `eth_chainId` call to resolve. It is never consulted,
		// because the source was given explicitly.
		running = await index(RECEIVING, depsFor());
		const chain = fakeChain().serve(SPREAD, TIP);
		sender = await senderAgainst(running, chain);

		await until(
			() => transfersIn(running!),
			(transfers) => transfers === SPREAD.length,
			'every pushed log to be folded',
		);
	});
});

/**
 * THE RECEIVER RECLAIMS WHAT ITS RETENTION NO LONGER COVERS.
 *
 * `--retention` is `optional` on `index` exactly as it is on `run`
 * (`config.ts`), and the flag's own help text promises that what falls outside
 * the window is "both refused on read and DROPPED from storage". The refusal
 * half always worked. The storage half did not: `run` and `build` prune in the
 * gap their cycle already waits, and a receiver has no cycle, so a bounded
 * `index` deployment got the answers of a windowed store and the footprint of an
 * unbounded one. That is the worst-of-both `a-configured-window-is-actually-pruned`
 * exists to kill, and it was reachable from a documented flag.
 *
 * The schedule is a TIMER because a receiver has nothing else. ADR-0022 forbids
 * a prune as a side effect of a write, and ingest is the only other thing that
 * happens here, so "between batches" would be that side effect renamed. A clock
 * is host-owned, which is what the ADR asks for.
 */
describe('the receiver prunes what its retention no longer covers', () => {
	/** Every version row the canonical generation holds, across both entities. */
	async function versionsIn(receiver: RunningReceiver): Promise<number> {
		const namespace = await canonicalStateNamespaceIn(receiver.db);
		if (namespace === undefined) throw new Error(`no generation answers reads in this database`);
		let total = 0;
		for (const entity of ['nft', 'counter']) {
			const counted = await receiver.db
				.prepare(`SELECT COUNT(*) AS n FROM "${namespace}_${entity}"`)
				.all<{n: number}>();
			total += Number(counted.results[0]?.n ?? 0);
		}
		return total;
	}

	it('drops the versions below its floor, on its own schedule, with no cycle to hide in', async () => {
		// a floor of 20 blocks behind a tip of START_BLOCK + 100 leaves the counter
		// versions closed early well below it, while every token's LIVE version
		// survives however old it is
		running = await index(
			{...RECEIVING, retention: '20'},
			// fast enough to observe without waiting a minute; a deployment uses the default
			depsFor({pruneIntervalSeconds: 0.05}),
		);
		const chain = fakeChain().serve(SPREAD, TIP);
		sender = await senderAgainst(running, chain);

		await until(
			() => statusCursor(running!.url),
			(cursor) => cursor?.lastToBlock === TIP,
			'the cursor to reach the tip',
		);

		// the count FALLS, which is the whole claim: a statement that retention is
		// configured is not evidence that anything was reclaimed
		const settled = await until(
			() => versionsIn(running!),
			(count) => count < SPREAD.length * 2,
			'the scheduled prune to drop the versions below the floor',
		);
		expect(settled).toBeLessThan(SPREAD.length * 2);

		// and it went on answering correctly from what it kept: the live version of
		// every token is current state however far below the floor it was written
		expect(await transfersIn(running)).toBe(SPREAD.length);
		expect(await ownerOf(running, 0n)).toBe(ALICE.toLowerCase());
	});

	it('deletes nothing where the deployment stated no floor, which is the default', async () => {
		running = await index(RECEIVING, depsFor({pruneIntervalSeconds: 0.05}));
		const chain = fakeChain().serve(SPREAD, TIP);
		sender = await senderAgainst(running, chain);

		await until(
			() => statusCursor(running!.url),
			(cursor) => cursor?.lastToBlock === TIP,
			'the cursor to reach the tip',
		);
		const unbounded = await versionsIn(running);

		// several ticks pass with no floor to prune to, and the store is untouched
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(await versionsIn(running)).toBe(unbounded);
	});
});
