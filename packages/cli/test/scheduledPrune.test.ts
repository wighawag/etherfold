import type {WritableStateStore} from '@etherfold/processor-entities';
import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
	canonicalStateNamespaceIn,
	prepareIndexing,
	run,
	type RunDependencies,
	type RunningIndexer,
} from '../src/index.js';
import type {Options} from '../src/types.js';
import {ALICE, entityModule, fakeChain, nftProcessor, START_BLOCK, transfer, ZERO} from './utils/chain.js';
import {canonicalStoreIn} from './utils/reads.js';

// ---------------------------------------------------------------------------------------------------
// THE CLI SCHEDULES THE PRUNE ITS RETENTION IMPLIES
// ---------------------------------------------------------------------------------------------------
// Retention has two halves and only one of them used to run here. A configured
// window has always bounded what a READ may ask about (`assertRetained`, at the
// seam); `prune` is what bounds the BYTES, and ADR-0022 makes it an explicit
// call the HOST schedules -- so a CLI deployment that configured one got the
// refusals of a bounded store and the footprint of an unbounded one, which is
// strictly worse than either honest position.
//
// The host is this package and not `@etherfold/server`: the server constructs no
// state store at all (its dependencies do not include one), the store is built
// in `folding.ts`, and the recurring loop is `driveCycles`.
//
// Every assertion here is on VERSIONS STORED or on what a read ANSWERS, never on
// what the store claims: those two coming apart is the defect itself, so a test
// that asked `capabilities.retention` would be asking the wrong half.
// ---------------------------------------------------------------------------------------------------

const SQLITE: Options = {
	processor: './nfts.js',
	nodeUrl: 'http://localhost:0',
	store: 'sqlite',
	db: ':memory:',
};

/** The follower binds a port; 0 asks the OS for a free one. `build` refuses the flag. */
const RUNNING: Options = {...SQLITE, port: '0'};

/**
 * Eight blocks that each mint a NEW token and rewrite ONE counter.
 *
 * That shape is what makes the counts below readable. Each token is written once
 * and never revisited, so its version is LIVE and no prune may ever take it,
 * however far below the floor it was written. The counter is rewritten by every
 * event, so each write CLOSES the previous version, and those closed versions
 * are the only prunable rows in the database.
 */
const CHURN = [10, 20, 30, 40, 50, 60, 70, 80].map((offset, index) =>
	transfer(START_BLOCK + offset, `0xa${offset}`, ZERO, ALICE, BigInt(index)),
);
/** Above the last log by more than the finality depth, so the fold reaches every block of it. */
const TIP = START_BLOCK + 100;
/** The last block that carried a log, which is the tip the store measures its floor back from. */
const STORE_TIP = START_BLOCK + 80;

/**
 * What the workload leaves behind with nothing pruned: 8 live token versions and
 * 8 versions of the counter (7 closed, 1 live).
 */
const UNPRUNED = 16;

/**
 * The window a deployment writes, and what survives a prune at its floor.
 *
 * A floor of `1,000,080 - 20 = 1,000,060` puts the counter versions closed at
 * blocks 10 through 60 out of reach of every legal read -- five of them -- while
 * the ones closed at 70 and 80 are still the answer somewhere inside the window
 * and the eight live token versions are the current state.
 */
const WINDOW = '20';
const RETAINED = 11;

/**
 * `revert-only` states no window and still states a FLOOR, at the finality depth
 * (17 by default): superseded versions are kept only as long as reorg revert
 * needs them, and that is how long that is. Its floor here is 1,000,063, which
 * puts exactly the same five closed versions out of reach.
 */
const REVERT_ONLY_RETAINED = 11;

let running: RunningIndexer | undefined;

afterEach(async () => {
	await running?.stop().catch(() => undefined);
	running = undefined;
});

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

function depsFor(chain: ReturnType<typeof fakeChain>, db: RemoteSQL, extra: RunDependencies = {}): RunDependencies {
	return {
		importModule: async () => entityModule,
		provider: chain.provider,
		createDB: () => db,
		sleep: async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
		},
		handleSignals: false,
		log: () => {},
		...extra,
	};
}

/** Build to the tip against a fake chain, and hand back what the command assembled. */
async function buildOnce(options: Partial<Options>, chain = fakeChain().serve(CHURN, TIP), db = oneDatabase()) {
	const prepared = await prepareIndexing('build', {...SQLITE, ...options}, depsFor(chain, db));
	await prepared.index();
	return {prepared, db};
}

/**
 * HOW MANY VERSIONS THIS DATABASE HOLDS, counted through the canonical pointer.
 *
 * A count of rows is the only honest measure that a prune did something: the
 * sqlite finding records `navigator.storage.estimate()` reporting MORE space
 * used after a prune that dropped nothing, and this store does not `VACUUM`, so
 * the file does not shrink even where every prunable row is gone.
 */
async function versionsIn(db: RemoteSQL): Promise<number> {
	const namespace = await canonicalStateNamespaceIn(db);
	if (namespace === undefined) throw new Error(`no generation answers reads in this database`);
	let total = 0;
	for (const entity of ['nft', 'counter']) {
		const counted = await db.prepare(`SELECT COUNT(*) AS n FROM "${namespace}_${entity}"`).all<{n: number}>();
		total += Number(counted.results[0]?.n ?? 0);
	}
	return total;
}

/** What the state ANSWERS, read the way a reader over this database reads it. */
async function stateIn(db: RemoteSQL) {
	const store = await canonicalStoreIn(db, nftProcessor.entities);
	const owners: Record<string, string> = {};
	for (let id = 0n; id < 8n; id++) {
		const row = await store.getCurrent<{owner: string}>('nft', {tokenID: id.toString().padStart(78, '0')});
		if (row) owners[id.toString()] = row.owner;
	}
	const counter = await store.getCurrent<{value: number}>('counter', {name: 'transfers'});
	return {transfers: counter?.value, owners};
}

/** Poll something the running process changes until it says what we are waiting for. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe('a CLI deployment with a retention floor reclaims what falls below it', () => {
	it('drops the versions a window no longer covers, and answers exactly as an unbounded one', async () => {
		const unbounded = await buildOnce({});
		const windowed = await buildOnce({retention: WINDOW});

		expect(await versionsIn(unbounded.db)).toBe(UNPRUNED);
		expect(await versionsIn(windowed.db)).toBe(RETAINED);
		// the count fell and the answers did not, which is what makes the reclamation
		// free: what a windowed deployment reads is what an unbounded one reads
		expect(await stateIn(windowed.db)).toEqual(await stateIn(unbounded.db));
		expect(await stateIn(windowed.db)).toMatchObject({transfers: CHURN.length});
	});

	/**
	 * The case a binary window-or-not implementation gets wrong.
	 *
	 * `retentionFloor` returns a floor for `revert-only` too wherever a finality
	 * depth is stated, and the CLI always states one (the stream's own). Reading
	 * the trigger as "a window is set" would leave a `revert-only` deployment
	 * refusing every historical read while retaining every version for ever --
	 * the exact worst-of-both this exists to kill.
	 */
	it('prunes a revert-only deployment, because a stated finality depth IS a floor', async () => {
		const {db} = await buildOnce({retention: 'revert-only'});

		expect(await versionsIn(db)).toBe(REVERT_ONLY_RETAINED);
		expect(await stateIn(db)).toMatchObject({transfers: CHURN.length});
	});

	/**
	 * The property a prune written as "drop what is older than the floor"
	 * destroys, and the normal case rather than an edge one: on the real measured
	 * stream event-bearing blocks are median 429 apart and rows are written once
	 * and never revisited.
	 */
	it('keeps the live version of every row written far below the floor', async () => {
		const {db} = await buildOnce({retention: WINDOW});

		const state = await stateIn(db);
		// token 0 was written at block 1,000,010, fifty blocks below the floor, and
		// is still the current state
		expect(state.owners['0']).toBe(ALICE.toLowerCase());
		expect(Object.keys(state.owners)).toHaveLength(CHURN.length);
	});

	/** The default, and probably most deployments: no floor, nothing deleted, and no read refused. */
	it('deletes nothing where the deployment stated no floor', async () => {
		const {db} = await buildOnce({retention: 'unbounded'});

		expect(await versionsIn(db)).toBe(UNPRUNED);
		const store = await canonicalStoreIn(db, nftProcessor.entities);
		expect(await store.getAsOf('counter', {name: 'transfers'}, START_BLOCK + 20)).toMatchObject({value: 2});
	});

	/**
	 * The follower is the shape this spec is about: a long-running host, where the
	 * store grows for as long as the process stays up.
	 *
	 * It prunes on the CYCLE and not at exit -- `run` has no exit -- so the
	 * assertion is that the count FALLS while the process keeps running and keeps
	 * answering.
	 */
	it('prunes on the cycle in a run that follows the chain, and goes on answering', async () => {
		const db = oneDatabase();
		const chain = fakeChain().serve(CHURN, TIP);

		running = await run({...RUNNING, retention: WINDOW}, depsFor(chain, db));

		await until(
			() => versionsIn(db),
			(versions) => versions === RETAINED,
			'the store to reach its retention floor',
		);
		expect(await stateIn(db)).toMatchObject({transfers: CHURN.length});
		expect((await fetch(`${running.url}/status`)).status).toBe(200);
	});
});

/**
 * ADR-0022's guarantee, asserted rather than trusted: an indexing cycle's cost
 * does not silently include a delete proportional to history.
 *
 * A prune inside `applyBlock` would stall whichever block happened to cross a
 * threshold, for work that block did not cause -- 1.1 s at 62,553 versions
 * against a block carrying a median of 7 mutations.
 */
describe('the fold never deletes', () => {
	it('reaches a prune only from the host, never from the path that applies a block', async () => {
		const db = oneDatabase();
		const prepared = await prepareIndexing(
			'build',
			{...SQLITE, retention: WINDOW},
			depsFor(fakeChain().serve(CHURN, TIP), db),
		);
		const store = prepared.store as WritableStateStore;

		let applying = 0;
		let prunesDuringAnApply = 0;
		let blocksApplied = 0;
		const applyBlock = store.applyBlock.bind(store);
		vi.spyOn(store, 'applyBlock').mockImplementation(async (...args) => {
			blocksApplied++;
			applying++;
			try {
				return await applyBlock(...args);
			} finally {
				applying--;
			}
		});
		const prune = store.prune.bind(store);
		const pruneSpy = vi.spyOn(store, 'prune').mockImplementation(async (...args) => {
			if (applying > 0) prunesDuringAnApply++;
			return prune(...args);
		});

		await prepared.index();

		// it did prune and it did fold, or the claim below would be vacuous
		expect(pruneSpy).toHaveBeenCalled();
		expect(blocksApplied).toBe(CHURN.length);
		expect(prunesDuringAnApply).toBe(0);
		expect(await versionsIn(db)).toBe(RETAINED);
	});
});

/** The tip the floor is measured back from is the last block that carried a log, not the chain's. */
it('measures its floor from the last block it applied', async () => {
	const {prepared} = await buildOnce({retention: WINDOW});

	expect(await (prepared.store as WritableStateStore).prune()).toMatchObject({
		tip: STORE_TIP,
		floor: STORE_TIP - Number(WINDOW),
		versionsDeleted: 0,
		complete: true,
	});
});
