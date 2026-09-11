import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {createReadSurface, declareEntities} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createPortReadSurface,
	serveIndexerHost,
	type IndexerHost,
	type IndexerPort,
} from '../src/index.js';
import {BRANCH_A_TIP, FINALITY, SOURCE, fakeChain, type TestABI} from '../browser/workload.js';
import {
	foldOnThisThread,
	heldChain,
	readEntities,
	readProcessor,
	readSurfaceCases,
	readWritableStore,
	type FixtureChain,
	type ReadFixtureSurface,
} from '../browser/readWorkload.js';
import {wire} from './utils/port.js';

/**
 * A TAB READING THE STORE ACROSS THE PORT, over a real `MessagePort`, in node.
 *
 * The claim is an EQUALITY and it is asserted as one: the same case list
 * (`browser/readWorkload.ts`) is run against the surface `createReadSurface`
 * generates over a store on THIS thread, and against the surface
 * `createPortReadSurface` generates over a port to a host holding its own store,
 * with both stores written by the same processor from the same captured logs. A
 * divergence is a failing case rather than a documented difference.
 *
 * What runs in a REAL browser with a REAL dedicated worker is
 * `browser/readsAcrossThePort.spec.ts`, which runs this same list in a page.
 * These are the same claims on every commit, because that run needs browser
 * binaries a clean checkout does not have.
 */

let counter = 0;
const freshName = () => `tab-reads-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** A host over `access`, folding the read fixture into its own store. */
function hostOver(
	access: ReturnType<typeof wire>['host'],
	databaseName: string,
	chain: FixtureChain = fakeChain(),
): IndexerHost {
	return serveIndexerHost<TestABI, EntityStateView>(
		{
			// THE HOST IS THE WRITER. Nothing the tab can name reaches this handle.
			createState: () => readWritableStore({databaseName}),
			createProcessor: (store) => new EntityEventProcessor<TestABI>(store, readProcessor),
			provider: chain.provider,
			source: SOURCE,
			config: {stream: {finality: FINALITY}},
			tipIntervalInSeconds: 0.05,
		},
		access,
	);
}

/**
 * Ask until the host's fold is level with a NAMED block.
 *
 * Named rather than inferred from equality: a container that has loaded and not
 * yet fetched publishes `0` for both numbers, so `lastToBlock === latestBlock`
 * is true before a single log has been asked for.
 */
async function untilFoldedTo(port: IndexerPort, block: number, attempts = 400): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const progress = await port.progress();
		if (progress.failure) {
			throw new Error(`the host stopped: ${progress.failure.name}: ${progress.failure.message}`);
		}
		if (progress.latestBlock === block && progress.lastToBlock === block) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`the fold did not reach block ${block}`);
}

/** One host, folded to the fixture's tip, with the tab's typed surface over it. */
async function foldedHost(): Promise<{surface: ReadFixtureSurface; port: IndexerPort; close: () => void}> {
	const ends = wire();
	const host = hostOver(ends.host, freshName());
	const port = connectToIndexerHost(ends.tab);
	const surface = createPortReadSurface(port, readEntities);
	await untilFoldedTo(port, BRANCH_A_TIP);
	return {
		surface,
		port,
		close: () => {
			host.dispose();
			port.close();
			ends.close();
		},
	};
}

/** The same workload, folded on THIS thread, read through the generated surface. */
async function sameThreadSurface(): Promise<ReadFixtureSurface> {
	const store = await readWritableStore({databaseName: freshName()});
	await foldOnThisThread(store, fakeChain());
	return createReadSurface(store, readEntities);
}

describe('the four reads, across the port and on this thread', () => {
	/**
	 * ONE case list, TWO surfaces, registered as a test each.
	 *
	 * The vitest registration is a thin adapter over the case data, which is
	 * `@etherfold/state-store-conformance`'s shape: a failure is reported as the
	 * behaviour that broke rather than as one opaque red suite, and the same list
	 * runs in a browser page where there is no runner at all.
	 */
	describe('a surface over a store on this thread', () => {
		for (const one of readSurfaceCases) {
			it(`${one.group}: ${one.name}`, async () => {
				await one.run(await sameThreadSurface());
			});
		}
	});

	describe('a surface over a port to a host holding the store', () => {
		for (const one of readSurfaceCases) {
			it(`${one.group}: ${one.name}`, async () => {
				const held = await foldedHost();
				try {
					await one.run(held.surface);
				} finally {
					held.close();
				}
			});
		}
	});
});

describe('what the port hands a tab', () => {
	it('carries the rows BYTE FOR BYTE, so a row read across the port is a row read here', async () => {
		const held = await foldedHost();
		try {
			const here = await sameThreadSurface();

			expect(await held.surface.token.getCurrent({id: '1'})).toEqual(await here.token.getCurrent({id: '1'}));
			expect(await held.surface.token.getAsOf({id: '2'}, 100)).toEqual(await here.token.getAsOf({id: '2'}, 100));
			expect(await held.surface.transfer.listCurrent({blockNumber: 104}, 10)).toEqual(
				await here.transfer.listCurrent({blockNumber: 104}, 10),
			);
			expect(await held.surface.transfer.listAsOf({blockNumber: 100}, 102, 10)).toEqual(
				await here.transfer.listAsOf({blockNumber: 100}, 102, 10),
			);
		} finally {
			held.close();
		}
	});

	it('hands the tab four reads per entity and NOTHING that could mutate the store', async () => {
		const held = await foldedHost();
		try {
			expect(Object.keys(held.surface).sort()).toEqual(['token', 'transfer']);
			expect(Object.keys(held.surface.token).sort()).toEqual(['getAsOf', 'getCurrent', 'listAsOf', 'listCurrent']);

			// the writer/reader split as a fact of the TYPE: there is no store on this
			// side at all, so there is no mutating verb to reach for. `pnpm typecheck`
			// runs the other half of this claim.
			const reads = held.surface.token as unknown as Record<string, unknown>;
			for (const mutating of ['applyBlock', 'revertTo', 'writeCursor', 'clearCursor', 'prune', 'set', 'delete']) {
				expect(reads[mutating]).toBeUndefined();
			}
			const port = held.port as unknown as Record<string, unknown>;
			for (const mutating of ['applyBlock', 'revertTo', 'writeCursor', 'clearCursor', 'prune', 'token']) {
				expect(port[mutating]).toBeUndefined();
			}
		} finally {
			held.close();
		}
	});

	/**
	 * READING WHILE THE FOLD IS RUNNING, which is what makes an app usable during
	 * a first sync rather than after it.
	 *
	 * The chain is HELD at block 102 rather than raced: the host folds what the
	 * node admits to and stops there with a cursor, the tab reads rows that exist
	 * at that point, and only then does the chain grow. Nothing here depends on a
	 * read landing inside a window that closes in milliseconds.
	 */
	it('answers while the fold is still running, not only once it has finished', async () => {
		const ends = wire();
		const chain = heldChain(102);
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const surface = createPortReadSurface(port, readEntities);
		try {
			await untilFoldedTo(port, 102);
			const progress = await port.progress();
			expect(progress.indexing).toBe(true);
			expect(progress.lastToBlock).toBeLessThan(BRANCH_A_TIP);

			// the rows the fold has written SO FAR, read across the port
			expect((await surface.token.getCurrent({id: '1'}))?.owner).toBe('0x0000000000000000000000000000000000000022');
			expect(await surface.token.getCurrent({id: '3'})).toBeUndefined();
			expect((await surface.transfer.listCurrent({blockNumber: 102}, 10)).rows).toHaveLength(1);

			chain.release(BRANCH_A_TIP);
			await untilFoldedTo(port, BRANCH_A_TIP);

			// ...and the same surface answers the rest once the fold reaches it
			expect((await surface.token.getCurrent({id: '3'}))?.owner).toBe('0x0000000000000000000000000000000000000044');
			expect((await surface.transfer.listCurrent({blockNumber: 104}, 10)).rows).toHaveLength(2);
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});
});

describe('a read the declarations do not describe', () => {
	it('REFUSES an entity the store was not built with, naming it and what it was built with', async () => {
		const held = await foldedHost();
		try {
			// the typed surface cannot express it (`pnpm typecheck` runs that half),
			// so this is the untyped handle the surface is generated over -- what a
			// JavaScript caller, or a surface built from another app's declarations,
			// reaches the host with.
			const refused = await held.port.reads.getCurrent('ghost', {id: '1'}).catch((error: unknown) => error);

			expect((refused as Error).name).toBe('UnknownEntityError');
			expect((refused as Error).message).toMatch(/ghost/);
			// and it says what IS declared, so an app can act on it rather than guess
			expect((refused as Error).message).toMatch(/token/);
		} finally {
			held.close();
		}
	});

	it('REFUSES a surface generated from a declaration the host does not share', async () => {
		const held = await foldedHost();
		try {
			// the same refusal the same-thread surface makes at CONSTRUCTION, made at
			// the first read instead: a port cannot compare declarations
			// synchronously, and a surface typed off a stale copy would project rows
			// to `null` -- a plausible wrong answer.
			const renamed = createPortReadSurface(
				held.port,
				declareEntities([{name: 'token', id: 'id', fields: {holder: 'text'}}]),
			);
			const refused = await renamed.token.getCurrent({id: '1'}).catch((error: unknown) => error);

			expect((refused as Error).message).toMatch(/token/);
			expect((refused as Error).message).toMatch(/holder/);
		} finally {
			held.close();
		}
	});
});
