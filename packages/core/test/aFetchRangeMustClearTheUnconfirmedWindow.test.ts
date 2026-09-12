import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {FetchRangeBelowFinalityError} from '../src/errors.js';
import {IndexerGeneration} from '../src/indexer.js';
import {fakeChain, fakeProcessor, FINALITY, makeLog, SOURCE} from './utils/streamCacheWorld.js';

/**
 * A FETCH RANGE NARROWER THAN THE UNCONFIRMED WINDOW IS REFUSED, RATHER THAN
 * WEDGING THE CURSOR FOR EVER.
 *
 * Every cycle rewinds by `stream.finality` before it fetches (`getFromBlock`
 * takes `min(lastToBlock + 1, latestBlock - finality)`), so a range CEILING at or
 * below that depth re-asks for blocks that are already folded and stops short of
 * the ones that are not. Nothing refused it and nothing said so: the fold simply
 * never advanced, while the indexer went on reporting `catching-up` truthfully --
 * measured at 50+ identical `eth_getLogs` ranges in three seconds against this
 * same fixture chain.
 *
 * It is refused at CONSTRUCTION because that is the first moment both numbers are
 * in hand, and because the alternative failure is invisible: a process that
 * starts cleanly, reports progress honestly and indexes nothing.
 */

const chainConfig = (maxBlocksPerFetch: number) => ({
	stream: {finality: FINALITY},
	fetch: {numBlocksToFetchAtStart: maxBlocksPerFetch, maxBlocksPerFetch},
});

function indexerWith(config: ReturnType<typeof chainConfig>) {
	const chain = fakeChain([makeLog(100, '0xa100')], 200);
	const processor = fakeProcessor();
	return new IndexerGeneration<Abi, string[]>(chain.provider, processor.processor, SOURCE, config);
}

describe('a fetch range that could never clear the unconfirmed window', () => {
	it('is REFUSED by type when the ceiling equals the finality depth', () => {
		const refused = (() => {
			try {
				indexerWith(chainConfig(FINALITY));
				return undefined;
			} catch (error) {
				return error;
			}
		})();

		expect(refused).toBeInstanceOf(FetchRangeBelowFinalityError);
		// Both numbers are CARRIED, not merely narrated, so a host can report them
		expect(refused).toMatchObject({maxBlocksPerFetch: FINALITY, finality: FINALITY});
		// ...and both appear in the sentence, with the two ways out named
		expect((refused as Error).message).toContain(`(${FINALITY})`);
		expect((refused as Error).message).toMatch(/maxBlocksPerFetch/);
		expect((refused as Error).message).toMatch(/stream\.finality/);
	});

	it('is REFUSED when the ceiling is below the finality depth', () => {
		expect(() => indexerWith(chainConfig(FINALITY - 1))).toThrow(FetchRangeBelowFinalityError);
	});

	it('ACCEPTS the narrowest width that can still reach the tip', () => {
		// Not vacuous: one block wider than the refused case is the narrowest range
		// that ends AT the tip rather than below it, and it must keep working -- a
		// refusal that took this with it would break every deployment on a node that
		// serves small ranges.
		expect(() => indexerWith(chainConfig(FINALITY + 1))).not.toThrow();
	});

	it('says nothing about a deployment that configures no ceiling at all', () => {
		// The default ceiling is far above any sane finality, so an unconfigured
		// deployment must not meet this refusal.
		const chain = fakeChain([makeLog(100, '0xa100')], 200);
		const processor = fakeProcessor();
		expect(
			() =>
				new IndexerGeneration<Abi, string[]>(chain.provider, processor.processor, SOURCE, {
					stream: {finality: FINALITY},
				}),
		).not.toThrow();
	});

	it('leaves a NARROW START alone, because the fetcher adapts that one upwards', () => {
		// Only the CEILING is permanent. `numBlocksToFetchAtStart` below the finality
		// depth is a slow first cycle, not a wedge, because the fetcher grows it
		// towards `maxBlocksPerFetch` -- so refusing it would refuse a legitimate
		// deployment that starts cautiously against an unfamiliar node.
		const chain = fakeChain([makeLog(100, '0xa100')], 200);
		const processor = fakeProcessor();
		expect(
			() =>
				new IndexerGeneration<Abi, string[]>(chain.provider, processor.processor, SOURCE, {
					stream: {finality: FINALITY},
					fetch: {numBlocksToFetchAtStart: 1, maxBlocksPerFetch: 1000},
				}),
		).not.toThrow();
	});
});
