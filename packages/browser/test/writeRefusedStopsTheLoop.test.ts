import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {openForWriting} from '@etherfold/state-store';
import {createBrowserStateStore} from '../src/index.js';
import {FINALITY, SOURCE, fakeChain, indexerFor, processor} from '../browser/workload.js';

/**
 * A REFUSAL WAITING CANNOT FIX STOPS THE LOOP, INSTEAD OF BEING RETRIED FOR EVER.
 *
 * The auto-index loop swallows a failure and comes back a few seconds later,
 * which is right for a rate limit, a dropped socket or a node hiccup. It is
 * catastrophic for a refusal the store will repeat identically: the loop
 * re-fetches the whole range from the node every cycle in order to be refused
 * again, with the cursor pinned where it was and nothing reporting a failure.
 * The work is invisible precisely because each attempt merely fails again.
 *
 * The case here is the one that produced it, and it is NOT the demotion case
 * beside it: this tab's store was moved far ahead by another writer BEFORE this
 * tab ever wrote. So the writer guard passes -- a store that has never claimed
 * CLAIMS on its first write -- and it is the TIP check that refuses. That
 * refusal says the CALLER is wrong (revert first, or stop), where a demotion
 * says the caller lost a race and should become a reader. Both stop the loop and
 * an app must be able to tell them apart, which is why this asserts the absence
 * of a demotion as hard as the presence of the error.
 *
 * Nothing here sleeps to prove a negative: the loop is given a very short
 * interval so that a version which kept re-arming would fetch MANY more ranges,
 * and the assertion is on the fetch count holding still.
 */

let counter = 0;
const freshName = () => `write-refused-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** Far above every height the fake chain serves, so every write this tab offers is below the tip. */
const AHEAD_BLOCK = {number: 400, hash: '0x400', timestamp: 1_700_000_000 + 400 * 12};

/** Wait for a condition the auto-index loop reaches on its own, or fail saying it never did. */
async function until(reached: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!reached()) {
		if (Date.now() > deadline) {
			throw new Error(`the auto-index loop never reached the expected state within ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe('a write the store will refuse for ever', () => {
	it('stops the auto-index loop rather than re-fetching the chain on a timer', async () => {
		const databaseName = freshName();
		const chain = fakeChain();

		// another writer moved this storage far ahead FIRST, which is what makes the
		// tip -- and not the writer guard -- the thing that refuses below.
		const ahead = await createBrowserStateStore(processor.entities, {databaseName});
		await ahead.applyBlock(AHEAD_BLOCK, []);

		const store = await openForWriting(await createBrowserStateStore(processor.entities, {databaseName}));
		const indexer = indexerFor(store);
		await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});

		await indexer.startAutoIndexing(0.01);
		await until(() => indexer.syncing.$state.autoIndexing === false);

		// it stopped for the RIGHT reason, and said so where an app is listening
		expect(indexer.syncing.$state.error?.id).toBe('WriteRefused');
		expect(indexer.syncing.$state.error?.message).toContain('is not above the recorded tip');

		// and it is NOT a demotion: this writer did not lose a race, it is offering
		// something the store will never accept
		expect(indexer.syncing.$state.demotion).toBeUndefined();

		// the loop is not re-armed. This is the assertion the whole file exists for:
		// the failure it replaces was measured at ~90 `eth_getLogs` per second.
		const fetched = chain.ranges.length;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(chain.ranges.length).toBe(fetched);

		indexer.dispose();
	});

	it('still retries a TRANSIENT failure, so the fix did not turn a hiccup into a stop', async () => {
		const databaseName = freshName();
		const chain = fakeChain();
		let failures = 2;
		const flaky = {
			async request(args: {method: string; params?: unknown}): Promise<unknown> {
				// an error carrying no `retryable` flag is the ordinary node failure, and
				// transience is the honest default for it
				if (args.method === 'eth_getLogs' && failures-- > 0) {
					throw new Error('rate limited');
				}
				return chain.provider.request(args as never);
			},
		};

		const store = await openForWriting(await createBrowserStateStore(processor.entities, {databaseName}));
		const indexer = indexerFor(store);
		await indexer.init({provider: flaky as never, source: SOURCE, config: {stream: {finality: FINALITY}}});

		await indexer.startAutoIndexing(0.01);

		// it gets past the failures on its own and keeps indexing
		await until(() => (indexer.syncing.$state.lastSync?.lastToBlock ?? 0) > 0);
		expect(indexer.syncing.$state.error?.id).not.toBe('WriteRefused');

		indexer.dispose();
	});
});
