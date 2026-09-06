import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {main, prepareIndexing, type IndexingDependencies} from '../src/index.js';
import type {Options} from '../src/types.js';
import {ALICE, BOB, entityModule, fakeChain, nftProcessor, START_BLOCK, transfer, ZERO} from './utils/chain.js';
import {canonicalStoreIn} from './utils/reads.js';

// ---------------------------------------------------------------------------------------------------
// THE ONE-SHOT: IT STOPS AT THE TIP, IT EXITS ON ITS CODE, AND IT RESUMES
// ---------------------------------------------------------------------------------------------------
// `runFetcherLoop` follows the tip forever, so the one-shot is that loop plus an
// `AbortController` aborted from `onReport`, which is the driver behind
// `etherfold build`. What a CI job depends on is the exit code, so the two ends of it are asserted
// here rather than described: 0 at the tip, non-zero on a refusal no waiting
// fixes.
//
// The resume case is also what proves the fetcher holds no cursor of its own: it
// is a different `LogFetcher` object, in a different run, asking the store where
// it got to.
// ---------------------------------------------------------------------------------------------------

const SQLITE: Options = {
	processor: './nfts.js',
	nodeUrl: 'http://localhost:0',
	store: 'sqlite',
	db: ':memory:',
};

/** Logs every 10 blocks, so a bounded fetch range takes several cycles to cover them. */
const SPREAD = [10, 20, 30, 40, 50, 60, 70, 80].map((offset, index) =>
	transfer(START_BLOCK + offset, `0xa${offset}`, index === 0 ? ZERO : ALICE, index === 0 ? ALICE : BOB, BigInt(index)),
);
const TIP = START_BLOCK + 100;

/** Bounded fetch ranges, read from the environment the way every fetcher host reads them. */
const SMALL_RANGES = {MAX_BLOCKS_PER_FETCH: '20'};

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/** What a produced artifact answers: the canonical generation's tables (ADR-0053). */
async function transfersIn(db: RemoteSQL): Promise<number | undefined> {
	const store = await canonicalStoreIn(db, nftProcessor.entities);
	return (await store.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value;
}

function depsFor(chain: ReturnType<typeof fakeChain>, db: RemoteSQL, extra: IndexingDependencies = {}) {
	return {
		importModule: async () => entityModule,
		provider: chain.provider,
		createDB: () => db,
		sleep: async () => {},
		env: SMALL_RANGES,
		...extra,
	} satisfies IndexingDependencies;
}

describe('the one-shot', () => {
	it('stops at the tip instead of following the chain', async () => {
		const chain = fakeChain().serve(SPREAD, TIP);
		const prepared = await prepareIndexing('build', SQLITE, depsFor(chain, oneDatabase()));
		const summary = await prepared.index();

		expect(summary.stoppedBecause).toBe('stopped');
		expect(summary.lastReport?.kind).toBe('progress');
		// the report that ended it is the one that reached the tip it observed
		expect(summary.lastReport).toMatchObject({caughtUp: true});
	});

	it('exits 0 when it reaches the tip', async () => {
		const chain = fakeChain().serve(SPREAD, TIP);
		const exits: number[] = [];
		const logged: string[] = [];
		await main(SQLITE, {
			build: async (options) => {
				const prepared = await prepareIndexing('build', options, depsFor(chain, oneDatabase()));
				return prepared.index();
			},
			exit: (code) => exits.push(code),
			log: (...args) => logged.push(args.join(' ')),
			error: () => {},
		});
		expect(exits).toEqual([0]);
		expect(logged).toContain('DONE');
	});

	it('exits non-zero on a fatal report, so CI can depend on the code', async () => {
		// a node that caps its results silently is indistinguishable from one that
		// answered completely, so a count landing exactly on the cap is treated as
		// suspect; a single block that still lands on it has nothing left to halve and
		// is a `SuspectedTruncationError`, which no waiting fixes
		const dense = [
			transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n, 0),
			transfer(START_BLOCK + 10, '0xa10', ZERO, BOB, 2n, 1),
		];
		const chain = fakeChain().serve(dense, TIP);
		const exits: number[] = [];
		const errors: unknown[] = [];
		await main(SQLITE, {
			build: async (options) => {
				const prepared = await prepareIndexing(
					'build',
					options,
					depsFor(chain, oneDatabase(), {env: {...SMALL_RANGES, SUSPECT_RESULT_COUNT: '2'}}),
				);
				return prepared.index();
			},
			exit: (code) => exits.push(code),
			log: () => {},
			error: (...args) => errors.push(...args),
		});

		expect(exits).toEqual([1]);
		expect((errors[0] as Error).name).toBe('SuspectedTruncationError');
	});
});

describe('stop and resume', () => {
	it('continues from the cursor in the store rather than from the start block', async () => {
		const db = oneDatabase();
		const interrupted = fakeChain().serve(SPREAD, TIP);

		// the kill: the run is stopped from outside after its first landed batch,
		// exactly as a signal handler would stop it
		const killer = new AbortController();
		const first = await prepareIndexing(
			'build',
			SQLITE,
			depsFor(interrupted, db, {
				signal: killer.signal,
				onReport: (report) => {
					if (report.kind === 'progress') killer.abort();
				},
			}),
		);
		await first.index();

		const stoppedAt = await transfersIn(db);
		expect(stoppedAt).toBeGreaterThan(0);
		expect(stoppedAt).toBeLessThan(SPREAD.length);

		// a NEW run, with a new fetcher that has never been told anything
		const resumed = fakeChain().serve(SPREAD, TIP);
		const second = await prepareIndexing('build', SQLITE, depsFor(resumed, db));
		await second.index();

		// it asked the store where it was: the first range of the second run starts
		// above the start block, so nothing between them was fetched twice from scratch
		expect(resumed.logRanges[0].from).toBeGreaterThan(START_BLOCK);

		// ...and it lands where a run that was never interrupted lands
		const uninterrupted = oneDatabase();
		const straight = await prepareIndexing('build', SQLITE, depsFor(fakeChain().serve(SPREAD, TIP), uninterrupted));
		await straight.index();

		expect(await transfersIn(db)).toBe(SPREAD.length);
		expect(await transfersIn(db)).toBe(await transfersIn(uninterrupted));
	});
});
