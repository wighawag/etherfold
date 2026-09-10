import {createClient} from '@libsql/client';
import {
	MemoryStateStore,
	openForWriting,
	type RetentionOptions,
	type RetentionSetting,
	type StateStore,
	type StateStoreBackend,
	type WritableStateStore,
} from '@etherfold/state-store';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {beforeEach, describe, expect, it} from 'vitest';
import {applyEventStream, type EntityProcessor} from '../src/index.js';
import {processor, transfer, type TestABI} from './utils/fixtures.js';

/**
 * The claim this whole seam exists to make: ONE processor, several backends,
 * identical state.
 *
 * Both backends here are real. The SQLite one is a real local libSQL database
 * behind `remote-sql`, never a mock, because the properties that matter (a
 * re-applied block raising, the DELETE-before-reopen ordering inside `revertTo`)
 * are properties of an engine. The other keeps versioned rows in a Map and owes
 * nothing to SQL, which is what makes the equality below worth asserting: if the
 * seam had leaked SQL semantics, this is where it would show.
 *
 * The processor object is imported, not written twice. Nothing in it names a
 * backend.
 */

/** What a deployment sets about the store, in the one spelling both backends take. */
type StoreOptions = RetentionOptions & {retention?: RetentionSetting};

type Backend = {name: string; make(options?: StoreOptions): StateStoreBackend};

const backends: Backend[] = [
	{name: 'memory', make: (options) => new MemoryStateStore(processor.entities, options)},
	{
		name: 'sqlite',
		make: (options) =>
			new VersionedStateStore(new RemoteLibSQL(createClient({url: ':memory:'})), processor.entities, options),
	},
];

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

/** A stream with a burst in one block, a later block, and nothing exotic. */
const STREAM = [
	transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
	transfer(100, '0xA', {from: '0x0', to: '0xzoe', id: 2n}),
	transfer(100, '0xA', {from: '0xalice', to: '0xbob', id: 1n}),
	transfer(101, '0xB', {from: '0xzoe', to: '0xcarol', id: 2n}),
	transfer(102, '0xC', {from: '0x0', to: '0xdan', id: 3n}),
];

describe('one processor, several backends', () => {
	let states: Record<string, Record<string, unknown>>;

	beforeEach(async () => {
		states = {};
		for (const backend of backends) {
			const store = await openForWriting(backend.make());
			await applyEventStream(store, processor, STREAM, undefined);
			states[backend.name] = await stateOf(store, IDS);
		}
	});

	it('produces the same state on every backend', () => {
		expect(states['sqlite']).toEqual(states['memory']);
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

describe.each(backends)('the seam behaves the same on $name', (backend) => {
	let store: WritableStateStore;

	beforeEach(async () => {
		// `openForWriting` migrates on the way, so claiming is the whole of the open.
		store = await openForWriting(backend.make());
	});

	it('composes two events in one block through read-your-writes', async () => {
		await applyEventStream(store, processor, STREAM.slice(0, 3), undefined);
		expect(await stateOf(store, ['1'])).toEqual({
			'token/1': {owner: '0xbob', transferCount: 2},
			'counter/transfers': {value: 3},
		});
	});

	it('answers as of an earlier block', async () => {
		await applyEventStream(store, processor, STREAM, undefined);
		expect(await store.getAsOf<{value: number}>('counter', {name: 'transfers'}, 100)).toMatchObject({value: 3});
		expect(await store.getAsOf<{owner: string}>('token', {id: '3'}, 101)).toBeUndefined();
	});

	it('makes a counter DECREASE when the block that raised it is reverted', async () => {
		await applyEventStream(store, processor, STREAM, undefined);
		// the canonical reorg bug: block 102 is retracted with no replacement
		await applyEventStream(
			store,
			processor,
			[transfer(102, '0xC', {from: '0x0', to: '0xdan', id: 3n}, {removed: true})],
			undefined,
		);

		expect(await stateOf(store, IDS)).toEqual({
			'token/1': {owner: '0xbob', transferCount: 2},
			'token/2': {owner: '0xcarol', transferCount: 2},
			'token/3': undefined,
			'counter/transfers': {value: 4},
		});
	});

	it('replaces a reorged height with the canonical branch, on both', async () => {
		await applyEventStream(store, processor, [transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})], undefined);
		await applyEventStream(
			store,
			processor,
			[
				transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}, {removed: true}),
				transfer(100, '0xBBB', {from: '0x0', to: '0xcarol', id: 1n}),
			],
			undefined,
		);
		expect(await stateOf(store, ['1'])).toEqual({
			'token/1': {owner: '0xcarol', transferCount: 1},
			'counter/transfers': {value: 1},
		});
	});

	it('raises when the same block is applied twice, rather than double-writing versions', async () => {
		await applyEventStream(store, processor, STREAM.slice(0, 3), undefined);
		await expect(applyEventStream(store, processor, STREAM.slice(0, 3), undefined)).rejects.toThrow();
	});

	it('carries an untouched field through `update` and clears it through `set`', async () => {
		// Worth running against the REAL engine and not only the reference store: a
		// SQL `SELECT *` hands back `_lower` / `_upper` alongside the declared
		// fields, and `update` spreads what `get` returned. If the version columns
		// rode along into the write, this is where it would show.
		const partial: EntityProcessor<TestABI> = {
			...processor,
			async onTransfer(state, event) {
				const id = event.args.id.toString();
				if (event.args.from === '0x0') {
					state.set('token', {id}, {owner: event.args.to, transferCount: 1});
				} else {
					// only the owner changes; transferCount is not mentioned
					await state.update('token', {id}, {owner: event.args.to});
				}
			},
		};

		await applyEventStream(store, partial, [transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n})], undefined);
		await applyEventStream(store, partial, [transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n})], undefined);

		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob', transferCount: 1});

		// and the primitive still writes a WHOLE row: `set` without transferCount nulls it
		// (annotated, not inlined: the handler map MAPS over the ABI's event names, so
		// `TestABI` is not inferrable from an object LITERAL and the handler arguments
		// would be implicitly `any`.)
		const wholeRow: EntityProcessor<TestABI> = {
			...processor,
			async onTransfer(state, event) {
				state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
			},
		};

		await applyEventStream(store, processor, [transfer(102, '0xC', {from: '0x0', to: '0xcarol', id: 2n})], undefined);
		await applyEventStream(store, wholeRow, [transfer(103, '0xD', {from: '0xcarol', to: '0xdan', id: 2n})], undefined);
		expect(await store.getCurrent('token', {id: '2'})).toMatchObject({owner: '0xdan', transferCount: null});
	});

	it('reports its capabilities before anything is read', () => {
		// Nothing was configured, so both keep everything and say so. The RETENTION
		// half is what a deployment writes and is therefore the same on both;
		// `singleWriter` is a fact about the STORAGE and honestly differs, which is
		// why it is asserted per backend rather than expected to match.
		expect(store.capabilities.retention).toEqual({kind: 'unbounded'});
		expect(store.capabilities.asOf).toBe(true);
	});
});

/**
 * What a DEPLOYMENT writes, and what each backend then claims about itself.
 *
 * That a claim is HONOURED is no longer asserted here: the shared suite
 * (`@etherfold/state-store-conformance`) reads a store's report and tests its
 * behaviour against it, on every backend and under each of the three claims. So
 * what is left is the half the suite cannot see, because the suite is handed a
 * store rather than the options it was built from: that one spelling of the
 * retention setting means the same thing to both backends, and produces the same
 * report from both.
 */
describe.each(backends)('a retention setting is written the same way on $name', (backend) => {
	it('rejects a window below the finality depth where it is CONFIGURED', () => {
		// not at the first read it would have answered wrongly: both numbers are
		// known at construction, so that is where the two are compared.
		expect(() => backend.make({retention: {blocks: 32}, finalityDepth: 64})).toThrow(/finality/i);
	});

	it('refuses a retention that is not a distance in block numbers', () => {
		expect(() => backend.make({retention: {seconds: 3_600} as never})).toThrow(/block/i);
		expect(() => backend.make({retention: {updates: 100} as never})).toThrow(/block/i);
	});

	it('turns a window into the same claim on both, and enforces it on both', async () => {
		const store = await openForWriting(backend.make({retention: {blocks: 128}, finalityDepth: 64}));
		await applyEventStream(store, processor, STREAM, undefined);

		expect(store.capabilities.retention).toEqual({kind: 'window', blocks: 128});
		expect(store.capabilities.asOf).toBe(true);
		// inside the window (the tip is block 102, so 100 is well inside it) both
		// answer, and both keep answering after a prune has run.
		expect(await store.getAsOf<{value: number}>('counter', {name: 'transfers'}, 100)).toMatchObject({value: 3});
		expect(await store.prune()).toMatchObject({tip: 102, floor: 0, versionsDeleted: 0});
		expect(await store.getAsOf<{value: number}>('counter', {name: 'transfers'}, 100)).toMatchObject({value: 3});
	});

	it('turns `revert-only` into the same claim on both, and the processor still runs on it', async () => {
		const store = await openForWriting(backend.make({retention: 'revert-only'}));
		await applyEventStream(store, processor, STREAM, undefined);

		expect(store.capabilities.retention).toEqual({kind: 'revert-only'});
		expect(store.capabilities.asOf).toBe(false);
		// the tip is not a historical read: a processor does not need history to run,
		// which is what makes `revert-only` a usable deployment rather than a crippled one
		expect(await store.getCurrent<{value: number}>('counter', {name: 'transfers'})).toMatchObject({value: 5});
	});
});
