import {createDirectIngestion, LogFetcher, StreamBuilder, type IndexingSource} from '@etherfold/core';
import {EntityEventProcessor} from '@etherfold/processor-entities';
import {MemoryStateStore, type StateStore} from '@etherfold/state-store';
import {createClient} from '@libsql/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {describe, expect, it, vi} from 'vitest';
import {prepareIndexing} from '../src/index.js';
import type {Options} from '../src/types.js';
import {canonicalStoreIn} from './utils/reads.js';
import {
	abi,
	ALICE,
	BOB,
	CAROL,
	CONTRACT,
	entityModule,
	fakeChain,
	nftProcessor,
	START_BLOCK,
	transfer,
	ZERO,
} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// `etherfold build --store sqlite` RUNS AN ENTITY PROCESSOR INTO A STORE
// ---------------------------------------------------------------------------------------------------
// The server half of "one processor, everywhere": the same processor object a
// tab runs against IndexedDB, indexing on a server into versioned rows -- and
// through the SAME two components a split deployment uses, with the transport
// removed (`LogFetcher` -> `createDirectIngestion` -> `StreamBuilder`).
//
// The chain is a fake node rather than a mock of the pipeline: every piece below
// the provider is the shipped one, including the real libSQL database.
// ---------------------------------------------------------------------------------------------------

const SQLITE: Options = {
	processor: './nfts.js',
	nodeUrl: 'http://localhost:0',
	store: 'sqlite',
	db: ':memory:',
};

/** One in-memory libSQL database, shared by every handle a run asks for. */
function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/**
 * Two blocks: a pair of mints well below the finality window, and a later block
 * INSIDE it -- which is what makes the reorg below reachable at all.
 */
const A_100 = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 10, '0xa10', ZERO, BOB, 2n, 1),
	transfer(START_BLOCK + 90, '0xa90', ALICE, BOB, 1n),
	transfer(START_BLOCK + 90, '0xa90', BOB, CAROL, 2n, 1),
];
const A_TIP = START_BLOCK + 100;

async function indexOnce(options: Partial<Options>, chain: ReturnType<typeof fakeChain>, db: RemoteSQL) {
	const prepared = await prepareIndexing(
		'build',
		{...SQLITE, ...options},
		{
			importModule: async () => entityModule,
			provider: chain.provider,
			createDB: () => db,
			sleep: async () => {},
		},
	);
	await prepared.index();
	return prepared;
}

/** What the store holds, in the terms the processor wrote it. */
async function readState(store: StateStore) {
	const counter = await store.getCurrent<{value: number}>('counter', {name: 'transfers'});
	const owners: Record<string, string> = {};
	for (const id of [1n, 2n, 3n]) {
		const tokenID = id.toString().padStart(78, '0');
		const row = await store.getCurrent<{owner: string}>('nft', {tokenID});
		if (row) owners[id.toString()] = row.owner;
	}
	return {transfers: counter?.value, owners};
}

describe('--store sqlite', () => {
	it('indexes an entity processor into versioned rows, and stops at the tip', async () => {
		const chain = fakeChain().serve(A_100, A_TIP);
		const db = oneDatabase();

		const prepared = await indexOnce({}, chain, db);

		expect(prepared.store).toBeDefined();
		expect(await readState(prepared.store as StateStore)).toEqual({
			transfers: 4,
			owners: {'1': BOB, '2': CAROL},
		});
	});

	it('folds through the SAME StreamBuilder a split deployment receives into', async () => {
		const chain = fakeChain().serve(A_100, A_TIP);
		const prepared = await indexOnce({}, chain, oneDatabase());
		expect(prepared.streamBuilder).toBeInstanceOf(StreamBuilder);
	});

	it('lands on the state the same processor produces on another backend', async () => {
		// "the resulting rows are the ones the same processor produces elsewhere":
		// elsewhere is a MemoryStateStore, driven by the same components assembled by
		// hand -- the processor object is the one thing the two runs share.
		const chain = fakeChain().serve(A_100, A_TIP);
		const prepared = await indexOnce({}, chain, oneDatabase());

		const elsewhere = new MemoryStateStore(nftProcessor.entities);
		const source: IndexingSource<typeof abi> = {
			chainId: '1',
			contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
		};
		const otherChain = fakeChain().serve(A_100, A_TIP);
		const builder = new StreamBuilder(new EntityEventProcessor(elsewhere, nftProcessor), source);
		const fetcher = new LogFetcher(otherChain.provider, source, createDirectIngestion(builder));
		// cycles by hand, since this side has no host: the CLI's driver is what is
		// under test, so it is deliberately not reused here
		for (;;) {
			const outcome = await fetcher.fetchAndPush();
			if (outcome.status !== 'pushed' || outcome.toBlock >= outcome.latestBlock) break;
		}

		expect(await readState(elsewhere)).toEqual(await readState(prepared.store as StateStore));
	});

	it('reverts a reorg through the CLI path, including a counter that decreases', async () => {
		const db = oneDatabase();
		const chain = fakeChain().serve(A_100, A_TIP);
		await indexOnce({}, chain, db);
		expect(await readState(await storeOf(db))).toMatchObject({transfers: 4});

		// the same chain, reorged at the block that moved tokens 1 and 2: the
		// replacement carries FEWER events, so the counter must come DOWN (4 -> 3) and
		// both tokens must go back to the owners the surviving block gave them
		const reorged = [A_100[0], A_100[1], transfer(START_BLOCK + 90, '0xb90', ZERO, CAROL, 3n)];
		const after = fakeChain().serve(reorged, A_TIP + 1);
		const second = await indexOnce({}, after, db);

		expect(await readState(second.store as StateStore)).toEqual({
			transfers: 3,
			owners: {'1': ALICE, '2': BOB, '3': CAROL},
		});
	});

	it('takes a retention window and REPORTS it, and prunes nothing inside the index loop', async () => {
		const chain = fakeChain().serve(A_100, A_TIP);
		const prepared = await prepareIndexing(
			'build',
			{...SQLITE, retention: '500'},
			{
				importModule: async () => entityModule,
				provider: chain.provider,
				createDB: () => oneDatabase(),
				sleep: async () => {},
			},
		);
		const store = prepared.store as StateStore;
		expect(store.capabilities.retention).toEqual({kind: 'window', blocks: 500});

		// ADR-0022: pruning is a call the HOST schedules, never a side effect of a
		// write, because it costs time proportional to what it drops -- a prune inside
		// `process` stalls whichever block crosses the threshold.
		const prune = vi.spyOn(store, 'prune');
		await prepared.index();
		expect(prune).not.toHaveBeenCalled();
	});

	it('refuses a retention window below the finality a reorg can reach', async () => {
		// the window is checked against the STREAM's finality, resolved once from the
		// same config both halves of the wire hash, so nothing here restates it
		await expect(
			prepareIndexing(
				'build',
				{...SQLITE, retention: '3'},
				{
					importModule: async () => entityModule,
					provider: fakeChain().provider,
					createDB: () => oneDatabase(),
				},
			),
		).rejects.toThrow(/finality depth/);
	});
});

/**
 * A second store over the same database, for reading a previous run's rows back
 * -- through the CANONICAL POINTER, which is the only way to name a generation's
 * tables (ADR-0053).
 */
async function storeOf(db: RemoteSQL): Promise<StateStore> {
	return canonicalStoreIn(db, nftProcessor.entities);
}
