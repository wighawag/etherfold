import {expect} from 'vitest';
import {EntityEventProcessor, type EntityProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {openForWriting, type WritableStateStore} from '@etherfold/state-store';
import {createBrowserStateStore, createIndexerState} from '../../src/index.js';
import type {TestABI} from '../../browser/workload.js';

/**
 * The vehicle the STREAM tests drive: a processor that records what it applied.
 *
 * These suites are about the stream cache and the stream keeper, not about the
 * processor, so what they need from one is the smallest thing that makes a
 * replay observable -- WHICH events reached a handler, in chain order, and HOW
 * MANY TIMES each did.
 *
 * `times` is the load-bearing field. The question every case here asks is
 * whether a replayed block is applied ONCE, and a store that simply overwrote a
 * row would hide a double application behind an idempotent-looking write.
 *
 * The id starts with a constant `bucket` because the seam's only set read is a
 * PREFIX of the declared id (ADR-0021): the bucket is what makes "every event
 * this processor applied" a prefix, and `at` (block number then log index, both
 * fixed-width, so the lexicographic order is the chain's) is what makes the
 * listing come back in the order the events arrived.
 */
export function applyingProcessor(control: {failFromBlock?: number} = {}): EntityProcessor<TestABI> {
	return {
		version: '1.0.0',
		entities: [{name: 'applied', id: ['bucket', 'at'], fields: {key: 'text', times: 'integer'}}],
		async onTransfer(state, event) {
			if (control.failFromBlock !== undefined && event.blockNumber >= control.failFromBlock) {
				throw new Error('handler blew up');
			}
			const at = `${String(event.blockNumber).padStart(12, '0')}:${String(event.logIndex).padStart(6, '0')}`;
			const prior = await state.get<{times: number}>('applied', {bucket: 'all', at});
			state.set(
				'applied',
				{bucket: 'all', at},
				{key: `${event.blockHash}:${event.logIndex}`, times: (prior?.times ?? 0) + 1},
			);
		},
	};
}

/**
 * What the store says was applied, in chain order, with the count beside it.
 *
 * Typed on the READ it makes rather than on the handle it is usually given: the
 * hook's `EntityStateView` and a bare `StateStore` declare the same listing, and
 * a case that has to read the state of a store BEFORE building a hook over it
 * (a reload, checking what survived) is asking the same question of the same
 * rows.
 */
export async function appliedIn(view: Pick<EntityStateView, 'listCurrent'>): Promise<{key: string; times: number}[]> {
	const listing = await view.listCurrent<{key: string; times: number}>('applied', {bucket: 'all'}, 500);
	expect(listing.truncated).toBe(false);
	return listing.rows.map((row) => ({key: row.key, times: Number(row.times)}));
}

/** Just the keys, which is what a from-scratch run is compared against. */
export const keysOf = (rows: {key: string}[]) => rows.map((row) => row.key);

/**
 * A durable browser store under its own database name.
 *
 * The name is the IDENTITY of the state: reopening the same one is what a RELOAD
 * is here, and a fresh one is what DISCARDING the state is.
 */
export async function browserStore(name: string, definition: EntityProcessor<TestABI>): Promise<WritableStateStore> {
	// CLAIMED, because these cases INDEX: the ability to mutate is obtained by
	// claiming (ADR-0077), and `openForWriting` migrates on the way.
	return openForWriting(await createBrowserStateStore(definition.entities, {databaseName: name}));
}

/**
 * The hook over one store, with a stream keeper where a case wants one.
 *
 * The hook takes the FACTORIES a generation is built from, not a processor built
 * over a store: each generation folds into its own state, so the store arrives
 * through `createState`. These cases hand back a store the case itself opened,
 * because WHICH database it is is the thing under test (a reload reopens the
 * same one; a discard opens a fresh one).
 */
export function indexerOver(
	definition: EntityProcessor<TestABI>,
	store: WritableStateStore,
	keepers: {
		keepStream?: unknown;
		/**
		 * The published STREAM SEED to install at `init`, for the cases about the
		 * seeding surface. Untyped here for the same reason `keepStream` is: these
		 * helpers are shared by suites that do not name the option at all.
		 */
		seed?: unknown;
	} = {},
) {
	return createIndexerState<TestABI, EntityStateView>(
		{
			createState: () => store,
			createProcessor: (state) => new EntityEventProcessor<TestABI>(state, definition),
		},
		{
			...(keepers.keepStream ? {keepStream: keepers.keepStream as never} : {}),
			...(keepers.seed ? {seed: keepers.seed as never} : {}),
		},
	);
}
