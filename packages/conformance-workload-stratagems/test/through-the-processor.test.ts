/**
 * The workload driven through the shipped `EventProcessor`, not through a store
 * directly.
 *
 * `workload.test.ts` and `alpha1.test.ts` feed `replayIntoStore`, which composes
 * `forkPoint` / `groupByBlock` / `runBlockHandlers` / `applyBlock` itself so it
 * can keep the id LEDGER the projection needs. That is legitimate and it is not
 * the whole claim: a deployment does not call those, it hands a store and a
 * processor to `EntityEventProcessor` and lets the core drive `load` / `process`.
 * If those two paths could disagree, the golden state would be evidence about a
 * path nobody ships.
 *
 * So this runs the same fixture BOTH ways on the same backend and asserts they
 * land on the same state -- and that the state is still the one the ORIGINAL
 * stratagems `JSProcessor` computed, so "the same" is not "the same wrong". The
 * ledger comes from the replay run, which is what makes the comparison possible
 * at all: the seam has no unanchored "list everything" read and deliberately
 * never will (ADR-0021), so something has to know which business keys were
 * written.
 *
 * The fast fixture only. This is a question about the SHELL -- the cursor, the
 * lifecycle, the delegation -- and the shell does not get more interesting at
 * 31,332 events; what does is the processor, which `alpha1.test.ts` already asks
 * about on every backend.
 */
import type {LastSync} from '@etherfold/core';
import {EntityEventProcessor, SYNC_CURSOR_KEY, deserializeLastSync} from '@etherfold/processor-entities';
import {describe, expect, it} from 'vitest';
import {
	BASE_ABANDONED,
	canonical,
	firstDifferences,
	loadStream,
	projectToData,
	runWorkload,
	stratagemsProcessor,
} from '../src/index.js';
import type {StratagemsABI} from '../vendor/stratagems/abi.js';
import {BACKENDS} from './utils/backends.js';

const SOURCE = {chainId: '8453', contracts: []} as never;
const STREAM_CONFIG = {finality: 12};

function cursorAt(lastToBlock: number): LastSync<StratagemsABI> {
	return {
		context: {source: [{startBlock: 11_681_933, hash: 'h'}], config: 'cfg', processor: 'proc'},
		latestBlock: lastToBlock,
		lastFromBlock: 11_681_933,
		lastToBlock,
		unconfirmedBlocks: [],
	};
}

describe.each(BACKENDS)('the workload through EntityEventProcessor, on $name', (backend) => {
	it('lands on the same state as driving the store directly, and on the golden one', async () => {
		const direct = await runWorkload(backend.make, BASE_ABANDONED);

		const store = await backend.make(stratagemsProcessor.entities);
		const p = new EntityEventProcessor(store, stratagemsProcessor);
		await p.load(SOURCE, STREAM_CONFIG);

		const stream = loadStream(BASE_ABANDONED);
		await p.process(stream.eventStream, cursorAt(direct.report.tip));

		const state = canonical(await projectToData(store, direct.report.touched));
		const summary =
			state === direct.golden
				? direct.golden
				: `driving the workload through EntityEventProcessor produced a different state.\n` +
					firstDifferences(direct.golden, state).join('\n');
		expect(summary).toBe(direct.golden);
	});

	it('leaves a cursor a restart can resume from, at the block it actually reached', async () => {
		const store = await backend.make(stratagemsProcessor.entities);
		const p = new EntityEventProcessor(store, stratagemsProcessor);
		await p.load(SOURCE, STREAM_CONFIG);

		const stream = loadStream(BASE_ABANDONED);
		const tip = Math.max(...stream.eventStream.map((event) => event.blockNumber));
		await p.process(stream.eventStream, cursorAt(tip));

		const stored = await store.readCursor(SYNC_CURSOR_KEY);
		expect(deserializeLastSync<StratagemsABI>(stored as string).lastToBlock).toBe(tip);

		// and a fresh processor over the same store picks it up, which is what a
		// restart is on every backend that outlives its process
		const restarted = new EntityEventProcessor(store, stratagemsProcessor);
		expect((await restarted.load(SOURCE, STREAM_CONFIG))?.lastSync.lastToBlock).toBe(tip);
	});
});
