/**
 * Replay a captured stream through the ported processor into a store, and
 * remember which entities it touched.
 *
 * The replay itself is `@etherfold/processor-entities` doing what it does for
 * any deployment: revert once at the fork point, then one block, one
 * `runBlockHandlers`, one `applyBlock`. Nothing here is a test harness's private
 * path -- that is the point of promoting the workload rather than keeping a
 * bespoke runner beside it.
 *
 * What IS here is the id LEDGER, and it exists because the seam has no "list
 * everything" read and deliberately never will: a listing is anchored at a key
 * by construction (ADR-0021), so an unanchored scan is not expressible. To
 * compare a whole state against a golden file, something has to know which
 * business keys the run wrote, and the mutations already say so exactly. Reading
 * each of them back through `getCurrent` afterwards is a STRONGER check than
 * enumerating live rows would be, because a key the processor DELETED must come
 * back `undefined`: a backend that leaves a deleted row live fails on the same
 * comparison as one that loses a written row.
 */
import type {Abi, LogEvent} from '@etherfold/core';
import {
	blockPointer,
	forkPoint,
	groupByBlock,
	runBlockHandlers,
	type EntityProcessor,
	type EntityId,
	type WritableStateStore,
} from '@etherfold/processor-entities';

/** Every business key the run wrote or deleted, per entity, deduplicated. */
export type TouchedIds = Map<string, Map<string, EntityId>>;

export type ReplayReport = {
	/** Events fed to the handlers, retractions included. */
	readonly events: number;
	/** Blocks applied, which is event-bearing blocks and not chain blocks. */
	readonly blocks: number;
	/** Mutations emitted, summed over the blocks. */
	readonly mutations: number;
	/** The last block applied, i.e. where the store's tip now is. */
	readonly tip: number;
	readonly touched: TouchedIds;
};

function remember(touched: TouchedIds, entity: string, id: EntityId): void {
	let byKey = touched.get(entity);
	if (!byKey) {
		byKey = new Map();
		touched.set(entity, byKey);
	}
	byKey.set(
		Object.keys(id)
			.sort()
			.map((column) => `${column}=${String(id[column])}`)
			.join('|'),
		id,
	);
}

/**
 * Apply a whole captured stream, one block at a time, exactly as the indexer
 * would.
 *
 * This mirrors `applyEventStream` and is composed out of the same exported
 * pieces rather than reimplementing any of them; the only difference is that it
 * keeps the mutations' ids on the way past, which `applyEventStream` has no
 * reason to return.
 */
export async function replayIntoStore<ABI extends Abi>(
	store: WritableStateStore,
	processor: EntityProcessor<ABI>,
	eventStream: readonly LogEvent<ABI>[],
): Promise<ReplayReport> {
	const fork = forkPoint(eventStream);
	if (fork !== undefined) {
		await store.revertTo(fork);
	}

	const touched: TouchedIds = new Map();
	const blocks = groupByBlock(eventStream);
	let mutationCount = 0;
	let tip = fork ?? 0;

	for (const block of blocks) {
		const mutations = await runBlockHandlers(store, processor, block.events, undefined);
		await store.applyBlock(blockPointer(block), mutations);
		for (const mutation of mutations) {
			remember(touched, mutation.entity, mutation.id);
		}
		mutationCount += mutations.length;
		tip = block.number;
	}

	return {events: eventStream.length, blocks: blocks.length, mutations: mutationCount, tip, touched};
}
