import 'fake-indexeddb/auto';
import {openForWriting} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {resolveStreamConfig, streamDigestOf, type SourceInvalidation} from '@etherfold/core';
import {createBrowserStateStore} from '../src/index.js';
import {
	APPENDED_ABOVE_BLOCK,
	APPENDED_BELOW_BLOCK,
	BRANCH_A,
	EXPECTED_A,
	FINALITY,
	fakeChain,
	indexerForProcessor,
	indexToTip,
	processor,
	readState,
	SOURCE_RANGED,
	SOURCE_RANGED_APPENDED_ABOVE,
	SOURCE_RANGED_APPENDED_BELOW,
	SOURCE_RANGED_EDITED_BELOW,
	SOURCE_RANGED_WITH_REDUNDANT_APPEND,
	START_BLOCK,
} from '../browser/workload.js';

/**
 * AN UPGRADE APPENDS AN ENTRY INSTEAD OF RE-FETCHING HISTORY.
 *
 * The headline is NOT that the state survives. An append is judged against the
 * kept event STREAM as well as against the state, so what it actually buys is
 * that NOTHING IS RE-FETCHED -- and state cannot tell you whether that happened,
 * because a re-index and a resume land on identical rows. So every claim here is
 * asserted on the RANGES the node was asked for, with `{stateDiscarded}` as the
 * second reading rather than the first.
 *
 * The fixture is the one `reconfigure.test.ts` drives: a real entity processor
 * over a real IndexedDB store against the recording fake chain. What is new is
 * that the source DECLARES the block ranges its events are live over, so an
 * upgraded implementation adding an event is an APPEND rather than a whole new
 * source hash.
 */

let counter = 0;
const freshName = () => `event-ranges-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** Index the captured branch to the tip against a source that declares ranges. */
async function indexedWithRanges(databaseName = freshName(), chain = fakeChain()) {
	const store = await openForWriting(await createBrowserStateStore(processor.entities, {databaseName}));
	const indexer = indexerForProcessor(store, processor);
	await indexer.init({provider: chain.provider, source: SOURCE_RANGED, config: {stream: {finality: FINALITY}}});
	await indexToTip(indexer);
	return {store, indexer, chain, databaseName};
}

describe('an entry appended ABOVE the cursor', () => {
	it('re-fetches nothing, which is the claim the state cannot make', async () => {
		const {indexer, chain} = await indexedWithRanges();
		const rangesBefore = chain.ranges.length;

		// the upgraded implementation emits an event the old one could not have
		await indexer.updateIndexer({source: SOURCE_RANGED_APPENDED_ABOVE as never});
		await indexToTip(indexer);

		// it RESUMED: every range asked for after the upgrade is above the start
		// block, so no block already indexed was fetched a second time
		const askedAfter = chain.ranges.slice(rangesBefore);
		for (const range of askedAfter) {
			expect(range.from).toBeGreaterThan(START_BLOCK);
		}

		indexer.dispose();
	});

	it('keeps the state, and the rows are the ones that were already there', async () => {
		const {indexer} = await indexedWithRanges();

		const outcome = await indexer.updateIndexer({source: SOURCE_RANGED_APPENDED_ABOVE as never});

		expect(outcome.stateDiscarded).toBe(false);
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);

		indexer.dispose();
	});

	/**
	 * THE REGRESSION GUARD, and the reason the verdict is published as a verdict.
	 *
	 * A stream is IDENTIFIED by the digest of its filter, and appending an entry
	 * adds a `streamHash` to that filter set -- so the digest MOVES here, on the one
	 * reconfigure ADR-0034 made free. Anything that read digest inequality as "this
	 * reconfigure invalidates something" would re-fetch the whole history for an
	 * upgrade that costs nothing today.
	 *
	 * The two answer different questions and both are needed: the VERDICT decides
	 * WHETHER anything is invalid, the DIGEST decides WHICH stream a result belongs
	 * to. Asserted across the package boundary, on the published type, because that
	 * is where the caller who could get this wrong lives.
	 */
	it('is decided by the VERDICT and not by the stream digest, which moves while the append stays free', async () => {
		const {indexer, chain} = await indexedWithRanges();
		const rangesBefore = chain.ranges.length;

		const streamConfig = resolveStreamConfig({finality: FINALITY});
		expect(streamDigestOf(SOURCE_RANGED_APPENDED_ABOVE as never, streamConfig)).not.toBe(
			streamDigestOf(SOURCE_RANGED, streamConfig),
		);

		const outcome = await indexer.updateIndexer({source: SOURCE_RANGED_APPENDED_ABOVE as never});
		await indexToTip(indexer);

		// the digest moved and the verdict did not: nothing is invalid, on either half
		const verdict: SourceInvalidation | undefined = outcome.sourceInvalidation;
		expect(verdict).toEqual({state: {valid: true}, stream: {valid: true}});

		// and the pair that proves it COST nothing: nothing discarded, nothing
		// re-fetched below the cursor
		expect(outcome.stateDiscarded).toBe(false);
		for (const range of chain.ranges.slice(rangesBefore)) {
			expect(range.from).toBeGreaterThan(START_BLOCK);
		}
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);

		indexer.dispose();
	});

	it('survives a RELOAD once the cursor has moved past it, because the kept state adopted the new ranges', async () => {
		// The state SURVIVED a source it was not computed under, so its persisted
		// context has to say so. Left carrying the old list, the very same append is
		// re-judged on the next load against a cursor that has since moved past the
		// appended entry -- so an upgrade that cost nothing today would cost a full
		// re-index on the next page load, which is the worst possible time to find out.
		const {indexer, chain, databaseName} = await indexedWithRanges();
		await indexer.updateIndexer({source: SOURCE_RANGED_APPENDED_ABOVE as never});

		// the chain moves on well past the appended entry's own block
		chain.serve(BRANCH_A, APPENDED_ABOVE_BLOCK * 2);
		const lastSync = await indexToTip(indexer);
		expect(lastSync.lastToBlock).toBeGreaterThan(APPENDED_ABOVE_BLOCK);
		indexer.dispose();

		// a new tab, the same IndexedDB database, the upgraded source
		const store = await openForWriting(await createBrowserStateStore(processor.entities, {databaseName}));
		const reloaded = indexerForProcessor(store, processor);
		await reloaded.init({
			provider: chain.provider,
			source: SOURCE_RANGED_APPENDED_ABOVE as never,
			config: {stream: {finality: FINALITY}},
		});
		const rangesBefore = chain.ranges.length;
		await indexToTip(reloaded);

		for (const range of chain.ranges.slice(rangesBefore)) {
			expect(range.from).toBeGreaterThan(START_BLOCK);
		}
		expect(await readState(reloaded.state.$state)).toEqual(EXPECTED_A);

		reloaded.dispose();
	});
});

describe('a redundant entry a generator could not recognise as a rollback', () => {
	it('re-fetches nothing and discards nothing, because the normalised coverage did not move', async () => {
		const {indexer, chain} = await indexedWithRanges();
		await indexer.updateIndexer({source: SOURCE_RANGED_APPENDED_ABOVE as never});
		await indexToTip(indexer);
		const rangesBefore = chain.ranges.length;

		// `[A@a, B@b, A@c]`: the third entry says nothing the first does not
		const outcome = await indexer.updateIndexer({source: SOURCE_RANGED_WITH_REDUNDANT_APPEND as never});
		await indexToTip(indexer);

		expect(outcome.stateDiscarded).toBe(false);
		for (const range of chain.ranges.slice(rangesBefore)) {
			expect(range.from).toBeGreaterThan(START_BLOCK);
		}
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);

		indexer.dispose();
	});
});

describe('an entry appended AT or BELOW the cursor', () => {
	it('discards the state and re-indexes from the start block', async () => {
		// Those blocks were indexed without that event in the filter, so they may be
		// missing logs and nothing after the fact can tell.
		const {indexer, chain} = await indexedWithRanges();
		const rangesBefore = chain.ranges.length;

		const outcome = await indexer.updateIndexer({source: SOURCE_RANGED_APPENDED_BELOW as never});
		await indexToTip(indexer);

		expect(outcome.stateDiscarded).toBe(true);
		// and the published verdict says WHICH half and FROM WHERE, which is the half
		// `stateDiscarded` cannot carry: the filter grew at a block already indexed, so
		// the stream dies with the state rather than being replayed
		expect(outcome.sourceInvalidation).toEqual({
			state: {valid: false, invalidFromBlock: APPENDED_BELOW_BLOCK, reason: 'entry-added'},
			stream: {valid: false, invalidFromBlock: APPENDED_BELOW_BLOCK, reason: 'entry-added'},
		});
		expect(chain.ranges.slice(rangesBefore)[0].from).toBe(START_BLOCK);
		expect(APPENDED_BELOW_BLOCK).toBeLessThan(chain.ranges[chain.ranges.length - 1].to);
		// and the rebuild lands on the same rows, which is exactly why the ranges
		// above are the assertion that matters
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);

		indexer.dispose();
	});
});

describe('an entry already below the cursor that was EDITED', () => {
	it('discards, though the list length did not change', async () => {
		const {indexer, chain} = await indexedWithRanges();
		const rangesBefore = chain.ranges.length;

		const outcome = await indexer.updateIndexer({source: SOURCE_RANGED_EDITED_BELOW as never});
		await indexToTip(indexer);

		expect(outcome.stateDiscarded).toBe(true);
		expect(chain.ranges.slice(rangesBefore)[0].from).toBe(START_BLOCK);

		indexer.dispose();
	});
});
