import {
	BlockNotRetainedError,
	MemoryStateStore,
	openForWriting,
	type StateStore,
	type WritableStateStore,
} from '@etherfold/state-store';
import {PatchStateStore, RevertBeyondPatchHistoryError} from '@etherfold/state-store-patch';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {createClient} from '@libsql/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {beforeEach, describe, expect, it} from 'vitest';
import {applyEventStream} from '../src/index.js';
import {processor, transfer} from './utils/fixtures.js';

/**
 * The claim, extended to the backend that stores no versions at all.
 *
 * `two-backends.test.ts` asserts that one processor produces identical state on
 * versioned SQL rows and on versioned rows in a Map. Those two are different
 * substrates for the SAME model, so the interesting question is whether the seam
 * leaked SQL. This file asks the harder one: the patch store keeps a plain
 * object and a log of immer reverse patches, has no version, no range and no
 * as-of read, and the processor still runs on it UNCHANGED, producing the same
 * state and reverting the same way.
 *
 * It lives here rather than in `@etherfold/state-store-patch` because the
 * processor is here, and a store package must not depend on the indexer core
 * (ADR-0016). What that package's own tests keep is what only it can be asked:
 * the sparse stream, the pruned patch log, and the refusals.
 */

const backends = [
	{name: 'memory', make: (): Promise<WritableStateStore> => openForWriting(new MemoryStateStore(processor.entities))},
	{
		name: 'sqlite',
		make: (): Promise<WritableStateStore> =>
			openForWriting(new VersionedStateStore(new RemoteLibSQL(createClient({url: ':memory:'})), processor.entities)),
	},
	{
		name: 'patch',
		make: (): Promise<WritableStateStore> =>
			openForWriting(new PatchStateStore(processor.entities, {retention: 'revert-only'})),
	},
];

/** The declared fields only: versions, ranges and patches are storage, not state. */
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

/** A burst in one block, a later block, and nothing exotic. The same stream the other file uses. */
const STREAM = [
	transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
	transfer(100, '0xA', {from: '0x0', to: '0xzoe', id: 2n}),
	transfer(100, '0xA', {from: '0xalice', to: '0xbob', id: 1n}),
	transfer(101, '0xB', {from: '0xzoe', to: '0xcarol', id: 2n}),
	transfer(102, '0xC', {from: '0x0', to: '0xdan', id: 3n}),
];

describe('one processor, on versioned rows and on a patch log', () => {
	let states: Record<string, Record<string, unknown>>;

	beforeEach(async () => {
		states = {};
		for (const backend of backends) {
			const store = await backend.make();
			await applyEventStream(store, processor, STREAM, undefined);
			states[backend.name] = await stateOf(store, IDS);
		}
	});

	it('produces the same state on the patch store as on the SQLite one', () => {
		expect(states['patch']).toEqual(states['sqlite']);
		expect(states['patch']).toEqual(states['memory']);
	});

	it('produces the state the handlers describe, so "the same" is not "the same wrong"', () => {
		expect(states['patch']).toEqual({
			'token/1': {owner: '0xbob', transferCount: 2},
			'token/2': {owner: '0xcarol', transferCount: 2},
			'token/3': {owner: '0xdan', transferCount: 1},
			// five transfers, three of them in one block: read-your-writes composed
			'counter/transfers': {value: 5},
		});
	});
});

describe('the patch store under the processor', () => {
	let store: WritableStateStore;

	beforeEach(async () => {
		store = await openForWriting(
			new PatchStateStore(processor.entities, {retention: 'revert-only', finalityDepth: 64}),
		);
	});

	it('makes a counter DECREASE when the block that raised it is retracted', async () => {
		await applyEventStream(store, processor, STREAM, undefined);

		// the canonical reorg bug: block 102 is retracted with no replacement, and
		// `applyEventStream` turns that into one `revertTo(101)`.
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

	it('replaces a reorged height with the canonical branch', async () => {
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

	it('refuses the historical read the other two answer, instead of serving the tip', async () => {
		await applyEventStream(store, processor, STREAM, undefined);

		const answered = await openForWriting(new MemoryStateStore(processor.entities));
		await applyEventStream(answered, processor, STREAM, undefined);
		expect(await answered.getAsOf<{value: number}>('counter', {name: 'transfers'}, 100)).toMatchObject({value: 3});

		// the same question, on the deployment that cannot answer it: an error, and
		// NOT the tip's 5, which is what a light store with no history would say.
		await expect(store.getAsOf('counter', {name: 'transfers'}, 100)).rejects.toBeInstanceOf(BlockNotRetainedError);
		expect(await store.getCurrent<{value: number}>('counter', {name: 'transfers'})).toMatchObject({value: 5});
	});

	it('refuses a retraction deeper than the patches it still holds, rather than half-undoing it', async () => {
		// a sparse stream: a finality of 64 cannot reach the block before the tip,
		// which is the shape of every real contract (median 429 blocks apart).
		await applyEventStream(store, processor, [transfer(1_000, '0xA', {from: '0x0', to: '0xalice', id: 1n})], undefined);
		await applyEventStream(store, processor, [transfer(1_429, '0xB', {from: '0x0', to: '0xzoe', id: 2n})], undefined);
		await store.prune();

		await expect(
			applyEventStream(
				store,
				processor,
				[transfer(1_000, '0xA', {from: '0x0', to: '0xalice', id: 1n}, {removed: true})],
				undefined,
			),
		).rejects.toBeInstanceOf(RevertBeyondPatchHistoryError);

		// and the state is untouched, so the host can re-index rather than carry on
		// from a state that is half one branch and half the other.
		expect(await stateOf(store, ['1', '2'])).toEqual({
			'token/1': {owner: '0xalice', transferCount: 1},
			'token/2': {owner: '0xzoe', transferCount: 1},
			'counter/transfers': {value: 2},
		});
	});
});
