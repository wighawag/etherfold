import {STREAM_FIXTURE_FORMAT, replayFixtureInto, type StreamFixture} from '@etherfold/core';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor} from '../src/index.js';
import {BACKENDS} from './utils/backends.js';
import {CONTEXT, finality, processor, SOURCE, transfer, type TestABI} from './utils/fixtures.js';

/**
 * WHY THERE ARE TWO REFUSALS AND NOT ONE (ADR-0073).
 *
 * `@etherfold/core` now refuses a timestampless log at the FETCH BOUNDARY,
 * naming the NODE, one round trip in. `blockPointer` refuses the same absence
 * at the FOLD, naming the BLOCK. That looks like one check written twice, and a
 * later reader deleting either as a duplicate is the failure this file exists to
 * prevent.
 *
 * They are not redundant because they sit on DIFFERENT ENTRY POINTS: **a stream
 * can reach a fold without passing a fetcher at all.** A seed install writes
 * through the keeper seam (ADR-0063) and a fixture reader replays a captured
 * stream (ADR-0059); neither makes a chain call, so no fetch-boundary check can
 * ever see them. This replays a captured stream, which is the cheaper of the two
 * to state and the same claim.
 *
 * The refusal it lands on is the one that has always been here, unchanged by the
 * fetch-boundary work: it names the BLOCK, because at the fold the node is long
 * gone and the block is what the caller holds.
 */

/** A capture whose logs carry NO `blockTimestamp`: a pre-`#639` node's answer, committed. */
function fixtureWithoutTimestamps(): StreamFixture<TestABI> {
	const eventStream = [
		transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}, {blockTimestamp: undefined}),
		transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n}, {blockTimestamp: undefined}),
	];
	return {
		format: STREAM_FIXTURE_FORMAT,
		provenance: {capturedAt: '2026-01-01T00:00:00.000Z', chainId: '1', fromBlock: 100, toBlock: 101},
		source: SOURCE,
		lastSync: {context: CONTEXT, latestBlock: 101, lastFromBlock: 100, lastToBlock: 101, unconfirmedBlocks: []},
		eventStream,
	};
}

describe('a stream that reached the fold without passing a fetcher', () => {
	it('is still refused at the fold, naming the block, with no node in the loop', async () => {
		const store = await BACKENDS[0].open(processor.entities);
		const folding = new EntityEventProcessor(store, processor);

		const refusal = await replayFixtureInto(folding as any, fixtureWithoutTimestamps(), {finality}).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(refusal).toBeInstanceOf(Error);
		const message = (refusal as Error).message;
		// the BLOCK, which is what this half names -- the fetch-boundary refusal names
		// the node, and neither message is the other's
		expect(message).toContain('block 100');
		expect(message).toContain('0xA');
		expect(message).toContain('execution-apis#639');
		// ...and it does NOT send the operator to a flag that no longer exists. It used
		// to recommend `stream: {alwaysFetchTimestamps: true}` as the escape hatch;
		// that flag and the fallback under it are DELETED (ADR-0073), so advice to set
		// it would be advice to set nothing. It still REFUSES rather than guessing.
		expect(message).not.toContain('alwaysFetchTimestamps');
		expect(message).toContain('refuses to guess');
	});

	it('folds the same stream once the capture carries the timestamps a node would have put on it', async () => {
		// The other half of the claim: the fold-time refusal is about an ABSENT
		// timestamp and about nothing else, so a fixture from a compliant node
		// replays exactly as it always did.
		const store = await BACKENDS[0].open(processor.entities);
		const folding = new EntityEventProcessor(store, processor);
		const fixture = fixtureWithoutTimestamps();
		fixture.eventStream = [
			transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
			transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n}),
		];

		await replayFixtureInto(folding as any, fixture, {finality});

		expect(await store.getCurrent<{owner: string}>('token', {id: '1'})).toMatchObject({owner: '0xbob'});
	});
});
