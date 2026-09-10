import type {StateStore, WritableStateStore} from '@etherfold/state-store';
import {beforeEach, describe, expect, it} from 'vitest';
import {EntityEventProcessor, fromEntityProcessor, SYNC_CURSOR_KEY, type EntityProcessor} from '../src/index.js';
import {BACKENDS} from './utils/backends.js';
import {finality, lastSync, processor, SOURCE, transfer, type TestABI} from './utils/fixtures.js';

/**
 * The claim the storage seam was built to make, now reachable through a shipped
 * component: ONE processor definition, FOUR backends, the same state, and a
 * cursor that survives a restart on each of them.
 *
 * `two-backends.test.ts` next door already proves the ENGINE is neutral by
 * driving `applyEventStream` directly. What it cannot prove is that a
 * DEPLOYMENT is: until this class existed, the only `EventProcessor` over the
 * seam built its own SQLite store from a `RemoteSQL` and kept its cursor in a
 * SQL table, so "one processor, several backends" was true in a test suite and
 * reachable through nothing anyone could ship. So these cases go through the
 * `EventProcessor` contract the core actually drives -- `load`, `process`,
 * `reset` -- and never touch the store directly except to look.
 *
 * The processor object is IMPORTED, not written per backend. Nothing in it names
 * a backend, and that is the assertion underneath every case here.
 */

/** The declared fields only: the version columns are storage, not state. */
async function stateOf(store: StateStore, ids: string[]): Promise<Record<string, unknown>> {
	const state: Record<string, unknown> = {};
	for (const id of ids) {
		const token = await store.getCurrent<Record<string, unknown>>('token', {id});
		state[`token/${id}`] = token && {owner: token.owner, transferCount: token.transferCount};
	}
	const counter = await store.getCurrent<Record<string, unknown>>('counter', {name: 'transfers'});
	state['counter/transfers'] = counter && {value: counter.value};
	return state;
}

const IDS = ['1', '2', '3'];

/** A burst inside one block, then two more blocks. */
const STREAM = [
	transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
	transfer(100, '0xA', {from: '0x0', to: '0xzoe', id: 2n}),
	transfer(100, '0xA', {from: '0xalice', to: '0xbob', id: 1n}),
	transfer(101, '0xB', {from: '0xzoe', to: '0xcarol', id: 2n}),
	transfer(102, '0xC', {from: '0x0', to: '0xdan', id: 3n}),
];

const STREAM_CONFIG = {finality};

describe('one processor definition, every shipped backend', () => {
	const states: Record<string, Record<string, unknown>> = {};

	beforeEach(async () => {
		for (const backend of BACKENDS) {
			const store = await backend.open(processor.entities);
			const p = new EntityEventProcessor(store, processor);
			await p.load(SOURCE, STREAM_CONFIG);
			await p.process(STREAM, lastSync({latestBlock: 102, lastToBlock: 102, lastFromBlock: 88}));
			states[backend.name] = await stateOf(store, IDS);
		}
	});

	it('produces the same state on all four', () => {
		expect({
			sqlite: states['sqlite'],
			indexeddb: states['indexeddb'],
			patch: states['patch'],
		}).toEqual({sqlite: states['memory'], indexeddb: states['memory'], patch: states['memory']});
	});

	it('produces the state the handlers describe, so "the same" is not "the same wrong"', () => {
		expect(states['memory']).toEqual({
			// token 1 moved twice, both moves inside block 100
			'token/1': {owner: '0xbob', transferCount: 2},
			'token/2': {owner: '0xcarol', transferCount: 2},
			'token/3': {owner: '0xdan', transferCount: 1},
			// five transfers, three of them in one block: read-your-writes composed
			'counter/transfers': {value: 5},
		});
	});
});

describe.each(BACKENDS)('the sync cursor on $name', (backend) => {
	it('is absent before the first sync, so the core starts fresh', async () => {
		const store = await backend.open(processor.entities);
		const p = new EntityEventProcessor(store, processor);
		expect(await p.load(SOURCE, STREAM_CONFIG)).toBeUndefined();
	});

	it('survives a restart, and the run continues where the uninterrupted one is', async () => {
		// index, stop, reload, continue -- and land on the state a single run lands
		// on. The store is REOPENED for the backends that outlive their store object
		// (a new store over the same database), and the processor is new in every
		// case, because a processor holding the cursor in a field would pass this
		// test while failing every real restart.
		const store = await backend.open(processor.entities);
		const first = new EntityEventProcessor(store, processor);
		await first.load(SOURCE, STREAM_CONFIG);
		await first.process(STREAM.slice(0, 4), lastSync({latestBlock: 101, lastToBlock: 101, lastFromBlock: 88}));

		const reopened = await backend.reopen(store, processor.entities);
		const restarted = new EntityEventProcessor(reopened, processor);
		const loaded = await restarted.load(SOURCE, STREAM_CONFIG);

		expect(loaded?.lastSync.lastToBlock).toBe(101);
		expect(loaded?.lastSync.lastFromBlock).toBe(88);
		expect(loaded?.lastSync.context).toEqual(lastSync().context);
		// and the state the cursor points at came back with it
		expect(await loaded?.state.getCurrent<{owner: string}>('token', {id: '2'})).toMatchObject({owner: '0xcarol'});

		await restarted.process(STREAM.slice(4), lastSync({latestBlock: 102, lastToBlock: 102, lastFromBlock: 102}));

		const uninterrupted = await backend.open(processor.entities);
		const single = new EntityEventProcessor(uninterrupted, processor);
		await single.load(SOURCE, STREAM_CONFIG);
		await single.process(STREAM, lastSync({latestBlock: 102, lastToBlock: 102, lastFromBlock: 88}));

		expect(await stateOf(reopened, IDS)).toEqual(await stateOf(uninterrupted, IDS));
	});

	it('carries the BigInt args a real decoded event holds', async () => {
		// `unconfirmedBlocks` holds the actual LogEvents of the reorg window, and a
		// decoded `uint256` arg is a BigInt, which plain JSON.stringify REFUSES.
		// Found end to end against a real anvil on the SQLite path; it is the codec's
		// property, so it is asserted on every backend that stores the string.
		const store = await backend.open(processor.entities);
		const p = new EntityEventProcessor(store, processor);
		await p.load(SOURCE, STREAM_CONFIG);

		const unconfirmed = transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 7n});
		await p.process(
			[unconfirmed],
			lastSync({
				latestBlock: 100,
				lastToBlock: 100,
				unconfirmedBlocks: [{number: 100, hash: '0xAAA', events: [unconfirmed]}],
			}),
		);

		const restarted = new EntityEventProcessor(await backend.reopen(store, processor.entities), processor);
		const loaded = await restarted.load(SOURCE, STREAM_CONFIG);
		const arg = (loaded!.lastSync.unconfirmedBlocks[0].events[0] as {args: {id: bigint}}).args.id;
		expect(arg).toBe(7n);
		expect(typeof arg).toBe('bigint');
	});

	it('records a range that carried none of our logs, so a restart does not re-scan it', async () => {
		const store = await backend.open(processor.entities);
		const p = new EntityEventProcessor(store, processor);
		await p.load(SOURCE, STREAM_CONFIG);
		await p.process([], lastSync({latestBlock: 500, lastToBlock: 500, lastFromBlock: 400}));

		const restarted = new EntityEventProcessor(await backend.reopen(store, processor.entities), processor);
		expect((await restarted.load(SOURCE, STREAM_CONFIG))?.lastSync.lastToBlock).toBe(500);
	});

	it('is returned even when the stored context does not match, so the core can clear', async () => {
		// The reason there is ONE cursor key rather than one per context: the core's
		// discard-and-clear branch lives inside `if (loaded)`, so a cursor that
		// answered "nothing stored" after an upgrade would have the new run index on
		// top of the previous processor's rows. See `SYNC_CURSOR_KEY`.
		const store = await backend.open(processor.entities);
		const p = new EntityEventProcessor(store, processor);
		await p.load(SOURCE, STREAM_CONFIG);
		await p.process(STREAM.slice(0, 3), lastSync({latestBlock: 100, lastToBlock: 100}));

		const v2: EntityProcessor<TestABI> = {...processor, version: '2.0.0'};
		const upgraded = new EntityEventProcessor(store, v2);
		const loaded = await upgraded.load(SOURCE, STREAM_CONFIG);
		expect(loaded).toBeDefined();
		expect(loaded!.lastSync.context.processor).not.toBe(upgraded.getVersionHash());

		// ...and the core's response to that mismatch leaves nothing behind
		await upgraded.clear();
		expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
		expect(await store.readCursor(SYNC_CURSOR_KEY)).toBeUndefined();
		expect(await upgraded.load(SOURCE, STREAM_CONFIG)).toBeUndefined();
	});
});

describe.each(BACKENDS)('a reorg through the component on $name', (backend) => {
	let store: WritableStateStore;
	let p: EntityEventProcessor<TestABI>;

	beforeEach(async () => {
		store = await backend.open(processor.entities);
		p = new EntityEventProcessor(store, processor);
		await p.load(SOURCE, STREAM_CONFIG);
		await p.process(STREAM, lastSync({latestBlock: 102, lastToBlock: 102, lastFromBlock: 88}));
	});

	it('makes a counter DECREASE when the block that raised it is retracted', async () => {
		// the canonical bug this design exists to make impossible: block 102 is
		// retracted with no replacement, and `transfers` must go from 5 back to 4.
		await p.process(
			[transfer(102, '0xC', {from: '0x0', to: '0xdan', id: 3n}, {removed: true})],
			lastSync({latestBlock: 102, lastToBlock: 101, lastFromBlock: 90}),
		);

		expect(await stateOf(store, IDS)).toEqual({
			'token/1': {owner: '0xbob', transferCount: 2},
			'token/2': {owner: '0xcarol', transferCount: 2},
			'token/3': undefined,
			'counter/transfers': {value: 4},
		});
	});

	it('moves the cursor BACK with the retraction, so the next run refetches the fork', async () => {
		await p.process(
			[transfer(102, '0xC', {from: '0x0', to: '0xdan', id: 3n}, {removed: true})],
			lastSync({latestBlock: 102, lastToBlock: 101, lastFromBlock: 90}),
		);

		const restarted = new EntityEventProcessor(await backend.reopen(store, processor.entities), processor);
		expect((await restarted.load(SOURCE, STREAM_CONFIG))?.lastSync.lastToBlock).toBe(101);
	});

	it('replaces a reorged height with the canonical branch', async () => {
		await p.process(
			[
				transfer(102, '0xC', {from: '0x0', to: '0xdan', id: 3n}, {removed: true}),
				transfer(102, '0xCCC', {from: '0x0', to: '0xerin', id: 3n}),
			],
			lastSync({latestBlock: 102, lastToBlock: 102, lastFromBlock: 90}),
		);

		expect(await stateOf(store, IDS)).toEqual({
			'token/1': {owner: '0xbob', transferCount: 2},
			'token/2': {owner: '0xcarol', transferCount: 2},
			'token/3': {owner: '0xerin', transferCount: 1},
			'counter/transfers': {value: 5},
		});
	});
});

describe('the component itself', () => {
	it('refuses a version-less processor at construction, naming itself', async () => {
		const store = await BACKENDS[0].open(processor.entities);
		// Every VARIANT here is annotated. The handler map MAPS over the ABI's event
		// names, so `ABI` is not inferrable from an object LITERAL: a bare spread
		// widens to the `Abi` constraint and the handlers it just copied stop matching.
		const {version, ...rest} = processor;
		const noVersion = rest as EntityProcessor<TestABI>;
		expect(() => new EntityEventProcessor(store, noVersion)).toThrow(/EntityEventProcessor/);
	});

	it('refuses to process before load, because finality is not known yet', async () => {
		const store = await BACKENDS[0].open(processor.entities);
		const p = new EntityEventProcessor(store, processor);
		await expect(p.process(STREAM, lastSync())).rejects.toThrow(/load\(\) must be called/);
	});

	it('hashes the declarations and the config, and NOT the backend', async () => {
		// The same declarations on two backends are the same state, which is the
		// whole claim: hashing the store in would discard state for moving a
		// deployment from a server to a browser and back.
		const sqlite = new EntityEventProcessor(await BACKENDS[1].open(processor.entities), processor);
		const indexeddb = new EntityEventProcessor(await BACKENDS[2].open(processor.entities), processor);
		expect(sqlite.getVersionHash()).toBe(indexeddb.getVersionHash());

		const renamed: EntityProcessor<TestABI> = {
			...processor,
			entities: [{name: 'token', id: ['id'], fields: {holder: 'text'}}, processor.entities[1]],
		};
		const changed = new EntityEventProcessor(await BACKENDS[0].open(processor.entities), renamed);
		expect(changed.getVersionHash()).not.toBe(sqlite.getVersionHash());
	});

	it('is built by a factory that takes the STORE, which is the deployment choice', async () => {
		const make = fromEntityProcessor(processor);
		const p = make(await BACKENDS[0].open(processor.entities));
		await p.load(SOURCE, STREAM_CONFIG);
		await p.process(STREAM.slice(0, 1), lastSync({latestBlock: 100, lastToBlock: 100}));
		expect(await p.state.getCurrent<{owner: string}>('token', {id: '1'})).toMatchObject({owner: '0xalice'});
	});
});
