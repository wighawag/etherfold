import {
	BlockNotRetainedError,
	openSnapshotAware,
	RevertBeyondSnapshotError,
	type Mutation,
	type StateSnapshot,
} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {
	bootstrapFromSnapshot,
	createSnapshot,
	EntityEventProcessor,
	openAndBootstrap,
	snapshotHead,
	SYNC_CURSOR_KEY,
	type SnapshotLocation,
} from '../src/index.js';
import {BACKENDS} from './utils/backends.js';
import {finality, lastSync, processor, SOURCE, timestampOf, transfer, type TestABI} from './utils/fixtures.js';

/**
 * A client that starts from state somebody else computed, instead of replaying
 * the chain from the start block.
 *
 * The free-form path has had this since it existed and the entity path would
 * otherwise have quietly lost it, so the cases below are written against the
 * behaviour that path actually ships: several published locations, the most
 * advanced one wins, an unreachable one is skipped rather than fatal, and local
 * state that is already further along is kept.
 *
 * The one thing with no free-form counterpart is the reason this is not a
 * mechanical port. A blob has no history to lie about; versioned rows do. A
 * snapshot of CURRENT rows carries nothing below its own block, so the store it
 * lands in must report that floor and refuse below it -- which is what
 * `openSnapshotAware` is for and what `openAndBootstrap` exists to keep on the
 * short path.
 */

const SNAPSHOT_BLOCK = 12_000;
const STREAM_CONFIG = {finality, alwaysFetchTimestamps: true};

function rowsAt(owner: string): Mutation[] {
	return [
		{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner, transferCount: 9}},
		{type: 'upsert', entity: 'counter', id: {name: 'transfers'}, values: {value: 9}},
	];
}

function published(at: number, over: {processor?: string; latestBlock?: number; owner?: string} = {}): StateSnapshot {
	return createSnapshot<TestABI>({
		takenAt: {number: at, hash: `0x${at.toString(16)}`, timestamp: timestampOf(at)},
		rows: rowsAt(over.owner ?? '0xalice'),
		lastSync: lastSync({
			lastToBlock: at,
			lastFromBlock: at - 10,
			latestBlock: over.latestBlock ?? at + 1_000,
		}),
		processor: over.processor ?? 'proc-v1',
		savedAt: '2026-08-24T00:00:00.000Z',
	});
}

/**
 * A network made of a map: a URL either has a body or throws.
 *
 * It also RECORDS what was asked for, which is how "the losing mirror was never
 * downloaded" and "an unreachable mirror was skipped" become assertions rather
 * than hopes.
 */
function network(routes: Record<string, unknown | Error>) {
	const asked: string[] = [];
	const fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		asked.push(url);
		const route = routes[url];
		if (route === undefined) throw new Error(`404 ${url}`);
		if (route instanceof Error) throw route;
		return {json: async () => route} as Response;
	}) as unknown as typeof globalThis.fetch;
	return {fetch, asked};
}

async function freshStore() {
	return openSnapshotAware(await BACKENDS[0].open(processor.entities));
}

describe('an indexer that starts from a snapshot', () => {
	it('resumes from the cursor the snapshot carried, rather than from the start block', async () => {
		const store = await freshStore();
		await store.bootstrap(published(SNAPSHOT_BLOCK), {processor: 'proc-v1'});

		const runtime = new EntityEventProcessor(store, processor);
		const loaded = await runtime.load(SOURCE, STREAM_CONFIG);

		// this is the whole capability: the core asks the processor where it is,
		// and the answer is the block somebody else indexed up to.
		expect(loaded?.lastSync.lastToBlock).toBe(SNAPSHOT_BLOCK);
		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice', transferCount: 9});
	});

	it('keeps indexing on top of the rows it adopted, as one state', async () => {
		const store = await freshStore();
		await store.bootstrap(published(SNAPSHOT_BLOCK), {processor: 'proc-v1'});

		const runtime = new EntityEventProcessor(store, processor);
		await runtime.load(SOURCE, STREAM_CONFIG);
		await runtime.process([transfer(SNAPSHOT_BLOCK + 1, '0xN', {from: '0xalice', to: '0xbob', id: 1n})], {
			...lastSync({lastToBlock: SNAPSHOT_BLOCK + 1, latestBlock: SNAPSHOT_BLOCK + 1}),
		});

		// the counter continued from the snapshot's 9 rather than starting at 1,
		// which is what "the rows are really the state" means.
		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob', transferCount: 10});
		expect(await store.getCurrent('counter', {name: 'transfers'})).toMatchObject({value: 10});
	});

	it('refuses a snapshot from another processor version, naming both', async () => {
		const store = await freshStore();

		await expect(
			store.bootstrap(published(SNAPSHOT_BLOCK, {processor: 'proc-v2'}), {processor: 'proc-v1'}),
		).rejects.toThrow(/proc-v2[\s\S]*proc-v1|proc-v1[\s\S]*proc-v2/);
	});
});

describe('a reorg that reaches below the snapshot, through the runtime that would perform it', () => {
	it('is refused loudly by the revert rather than half-performed', async () => {
		const store = await freshStore();
		await store.bootstrap(published(SNAPSHOT_BLOCK), {processor: 'proc-v1'});
		const runtime = new EntityEventProcessor(store, processor);
		await runtime.load(SOURCE, STREAM_CONFIG);

		// a retraction AT the snapshot block forks below it: the canonical chain
		// diverges from a block whose predecessor state this store never received.
		const retracted = transfer(SNAPSHOT_BLOCK, '0xDEAD', {from: '0x0', to: '0xmallory', id: 1n}, {removed: true});

		await expect(
			runtime.process([retracted], lastSync({lastToBlock: SNAPSHOT_BLOCK, latestBlock: SNAPSHOT_BLOCK})),
		).rejects.toBeInstanceOf(RevertBeyondSnapshotError);

		// and nothing moved: a host that catches this still holds the state it had,
		// which is what makes re-bootstrapping from a newer snapshot a real option.
		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice', transferCount: 9});
		expect(store.snapshotOrigin).toBe(SNAPSHOT_BLOCK);
	});

	it('names the block asked for and the floor, so the message says what to do', async () => {
		const store = await freshStore();
		await store.bootstrap(published(SNAPSHOT_BLOCK), {processor: 'proc-v1'});

		const refusal = await store.revertTo(SNAPSHOT_BLOCK - 5).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(RevertBeyondSnapshotError);
		expect((refusal as RevertBeyondSnapshotError).keepUpTo).toBe(SNAPSHOT_BLOCK - 5);
		expect((refusal as RevertBeyondSnapshotError).snapshotOrigin).toBe(SNAPSHOT_BLOCK);
		expect((refusal as Error).message).toContain('finality depth');
	});
});

describe.each(BACKENDS.filter((backend) => backend.durable))('the floor on $name, across a reload', (backend) => {
	it('is still there when the store is reopened, so the second run is as honest as the first', async () => {
		const first = await backend.open(processor.entities);
		const aware = await openSnapshotAware(first);
		await aware.bootstrap(published(SNAPSHOT_BLOCK), {processor: 'proc-v1'});

		// what a restart is for this backend: a new store object over the same
		// storage. A floor held only in the previous handle would be gone.
		const second = await openSnapshotAware(await backend.reopen(first, processor.entities));

		expect(second.snapshotOrigin).toBe(SNAPSHOT_BLOCK);
		expect(second.capabilities.retention.kind).toBe('window');
		await expect(second.getAsOf('token', {id: '1'}, SNAPSHOT_BLOCK - 1)).rejects.toBeInstanceOf(BlockNotRetainedError);
		expect(await second.getAsOf('token', {id: '1'}, SNAPSHOT_BLOCK)).toMatchObject({owner: '0xalice'});
	});
});

describe('choosing between published locations', () => {
	const A = 'https://a.example/state.json';
	const B = 'https://b.example/state.json';
	const C = 'https://c.example/state.json';

	it('uses the one that has got furthest', async () => {
		const store = await freshStore();
		const {fetch} = network({
			[A]: published(11_000),
			[B]: published(13_000),
			[C]: published(12_000),
		});

		const outcome = await bootstrapFromSnapshot(store, [A, B, C], {processor: 'proc-v1', fetch});

		expect(outcome).toEqual({status: 'bootstrapped', at: 13_000, from: B});
		expect(store.snapshotOrigin).toBe(13_000);
	});

	it('fails over to the next when a mirror is unreachable, rather than dying', async () => {
		const store = await freshStore();
		const {fetch} = network({
			[A]: new Error('connection reset'),
			[B]: published(12_500),
		});

		const outcome = await bootstrapFromSnapshot(store, [A, B], {processor: 'proc-v1', fetch});

		expect(outcome).toMatchObject({status: 'bootstrapped', at: 12_500});
	});

	it('falls past the WINNER too, when its payload cannot be downloaded', async () => {
		// the free-form keeper tries the winner and then exactly one more (its own
		// source says `// TODO more than 2`); this walks every remaining candidate.
		const store = await freshStore();
		const {fetch} = network({
			[A]: snapshotHead(published(14_000)),
			[B]: snapshotHead(published(13_000)),
			[C]: published(12_000),
			'https://a.example/body.json': new Error('gone'),
			'https://b.example/body.json': new Error('gone'),
		});

		const outcome = await bootstrapFromSnapshot(
			store,
			[{url: 'https://a.example/body.json', head: A}, {url: 'https://b.example/body.json', head: B}, C],
			{processor: 'proc-v1', fetch},
		);

		expect(outcome).toMatchObject({status: 'bootstrapped', at: 12_000});
	});

	it('reads only the HEAD of each mirror when one is published, and downloads only the winner', async () => {
		const store = await freshStore();
		const {fetch, asked} = network({
			'https://a.example/head.json': snapshotHead(published(11_000)),
			'https://b.example/head.json': snapshotHead(published(13_000)),
			'https://b.example/state.json': published(13_000),
		});

		const locations: SnapshotLocation[] = [
			{url: 'https://a.example/state.json', head: 'https://a.example/head.json'},
			{url: 'https://b.example/state.json', head: 'https://b.example/head.json'},
		];
		await bootstrapFromSnapshot(store, locations, {processor: 'proc-v1', fetch});

		expect(asked).toEqual([
			'https://a.example/head.json',
			'https://b.example/head.json',
			'https://b.example/state.json',
		]);
	});

	it('keeps local state when local is already ahead, and downloads nothing', async () => {
		const store = await freshStore();
		await store.bootstrap(published(13_000), {processor: 'proc-v1'});
		const {fetch, asked} = network({[A]: published(12_000)});

		const outcome = await bootstrapFromSnapshot(store, [A], {processor: 'proc-v1', fetch});

		expect(outcome).toEqual({status: 'kept-local', at: 13_000});
		// the head was read to compare; the payload never was.
		expect(asked).toEqual([A]);
		expect(store.snapshotOrigin).toBe(13_000);
	});

	it('ignores a snapshot computed by another processor version rather than adopting it', async () => {
		const store = await freshStore();
		const {fetch} = network({[A]: published(13_000, {processor: 'proc-v2'})});

		const outcome = await bootstrapFromSnapshot(store, [A], {processor: 'proc-v1', fetch});

		expect(outcome).toEqual({status: 'not-bootstrapped', reason: 'processor-mismatch'});
		expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
	});

	it('declines a snapshot taken inside the reorg window, where a revert could not be undone', async () => {
		const store = await freshStore();
		// taken 10 blocks behind the tip its producer had seen, under a finality of 64
		const {fetch} = network({[A]: published(13_000, {latestBlock: 13_010})});

		const outcome = await bootstrapFromSnapshot(store, [A], {
			processor: 'proc-v1',
			finalityDepth: 64,
			fetch,
		});

		expect(outcome).toEqual({status: 'not-bootstrapped', reason: 'inside-reorg-window'});
	});

	it('accepts one taken behind the finality depth', async () => {
		const store = await freshStore();
		const {fetch} = network({[A]: published(13_000, {latestBlock: 13_100})});

		const outcome = await bootstrapFromSnapshot(store, [A], {
			processor: 'proc-v1',
			finalityDepth: 64,
			fetch,
		});

		expect(outcome).toMatchObject({status: 'bootstrapped', at: 13_000});
	});

	it('tells an UNREADABLE document from an unreachable host, because the remedies differ', async () => {
		// These were one reason until ADR-0071, and an app renders this to a user. A
		// host that did not answer may answer next time, or another mirror may, so
		// retrying is right. A document this build cannot read means the app or the
		// publisher is out of date, and retrying never helps -- so calling it "the
		// mirror is down" sends the user to do the one thing that cannot work.
		const store = await freshStore();
		const {fetch} = network({[A]: {not: 'a snapshot envelope'} as never});

		const outcome = await bootstrapFromSnapshot(store, [A], {processor: 'proc-v1', fetch});

		expect(outcome).toEqual({status: 'not-bootstrapped', reason: 'unreadable-format'});
	});

	it('still says UNREACHABLE when the host genuinely did not answer', async () => {
		const store = await freshStore();
		const {fetch} = network({});

		expect(await bootstrapFromSnapshot(store, [A], {processor: 'proc-v1', fetch})).toEqual({
			status: 'not-bootstrapped',
			reason: 'unreachable',
		});
	});

	it('reports that no location was given rather than pretending it tried', async () => {
		const store = await freshStore();
		expect(await bootstrapFromSnapshot(store, [], {processor: 'proc-v1'})).toEqual({
			status: 'not-bootstrapped',
			reason: 'no-locations',
		});
	});
});

describe('the boot path', () => {
	it('bootstraps a store that has never synced, and opens it snapshot-aware', async () => {
		const {fetch} = network({'https://a.example/state.json': published(SNAPSHOT_BLOCK)});

		const {store, outcome} = await openAndBootstrap(
			await BACKENDS[0].open(processor.entities),
			'https://a.example/state.json',
			{processor: 'proc-v1', fetch},
		);

		expect(outcome).toMatchObject({status: 'bootstrapped', at: SNAPSHOT_BLOCK});
		expect(store.snapshotOrigin).toBe(SNAPSHOT_BLOCK);
		expect(await store.readCursor(SYNC_CURSOR_KEY)).toBeDefined();
	});

	it('asks the network nothing on a store that has already synced', async () => {
		const inner = await BACKENDS[0].open(processor.entities);
		await inner.migrate();
		await inner.writeCursor(SYNC_CURSOR_KEY, JSON.stringify(lastSync({lastToBlock: 5})));
		const {fetch, asked} = network({'https://a.example/state.json': published(SNAPSHOT_BLOCK)});

		const {outcome} = await openAndBootstrap(inner, 'https://a.example/state.json', {
			processor: 'proc-v1',
			fetch,
		});

		expect(outcome).toEqual({status: 'kept-local', at: 5});
		expect(asked).toEqual([]);
	});
});
