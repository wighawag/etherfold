import {describe, expect, it} from 'vitest';
import {createFetcherHost, resolveFetcherHostConfig} from '../src/index.js';
import {deployReceiver, ENDPOINT, fakeChain, INDEXER, SOURCE, TOKEN} from './harness.js';

// ---------------------------------------------------------------------------
// THE LEARNED RANGE, HANDED BACK TO THE NEXT RUN
// ---------------------------------------------------------------------------
// A fetcher discovers how wide a range its provider will answer by being
// refused, and it holds that knowledge in memory and nowhere else: the fetching
// half of ADR-0003 persists nothing, and inventing a store inside it for a
// performance hint would trade that property away (ADR-0074).
//
// So the hint travels the other way round. A run REPORTS it (on `/status`, from
// `LogFetcher.limits`), and an operator or a supervisor hands it back through
// `LEARNED_RANGE`, which is the only door it comes in by. A deployment that
// configures none rediscovers, exactly as it always did.
// ---------------------------------------------------------------------------

const complete = {
	INDEXING_SOURCE: JSON.stringify(SOURCE),
	ETH_NODE_URI: 'https://eth.example/v2/A-SECRET-API-KEY',
	INGEST_ENDPOINT: ENDPOINT,
	INDEXER_NAME: INDEXER,
	INGEST_TOKEN: TOKEN,
};

/** Exactly what a previous run's `/status` reported, pasted back verbatim. */
const REPORTED = {ceiling: 2000, safeSpan: 1999, nextSize: 1999};

describe('a range a previous run reported is configuration for the next one', () => {
	it('reads it from the environment as the report was written', () => {
		const config = resolveFetcherHostConfig({...complete, LEARNED_RANGE: JSON.stringify(REPORTED)});
		expect(config.learnedRange).toEqual(REPORTED);
	});

	it('carries no opinion at all when nothing is configured', () => {
		// the KEY and not merely a falsy value: what core receives must be
		// indistinguishable from what it received before this option existed
		expect('learnedRange' in resolveFetcherHostConfig(complete)).toBe(false);
	});

	it('reaches the fetcher, so the first request asks for what the last run learned', async () => {
		const receiver = await deployReceiver();
		const host = createFetcherHost(resolveFetcherHostConfig({...complete, LEARNED_RANGE: JSON.stringify(REPORTED)}), {
			provider: fakeChain().provider,
			fetch: receiver.fetch,
		});

		// read back off the surface a host reports from, which is the same value the
		// operator pasted in: the round trip is the feature
		expect(host.fetcher.limits.learnedRange).toEqual(REPORTED);
	});

	it('leaves a fetcher told nothing exactly as it was: rediscovering from the starting range', async () => {
		const receiver = await deployReceiver();
		const host = createFetcherHost(resolveFetcherHostConfig(complete), {
			provider: fakeChain().provider,
			fetch: receiver.fetch,
		});

		expect(host.fetcher.limits.learnedRange).toEqual({nextSize: 50});
	});

	it('accepts a PARTIAL range, because a deployment may know only its provider’s cap', () => {
		const config = resolveFetcherHostConfig({...complete, LEARNED_RANGE: '{"ceiling":2000}'});
		expect(config.learnedRange).toEqual({ceiling: 2000});
	});

	it('ignores a key it does not know, so a newer report can be pasted into an older build', () => {
		// Deliberately NOT a refusal. This value is copied out of a status page by a
		// human or a supervisor, and it is a performance hint: refusing to START over an
		// unrecognised key would turn a report that grew a field into an outage, which
		// is a worse trade than ignoring it. Unrecognised environment variables are
		// already ignored here for the same reason.
		const config = resolveFetcherHostConfig({
			...complete,
			LEARNED_RANGE: '{"ceiling":2000,"somethingAddedLater":42}',
		});
		expect(config.learnedRange).toEqual({ceiling: 2000});
	});

	it('refuses a value it cannot read at all, naming the variable', () => {
		// The other half of the trade: a value that is not a report is a
		// misconfiguration an operator can fix, and it is refused at startup rather
		// than quietly doing nothing, exactly as a malformed INDEXING_SOURCE is.
		expect(() => resolveFetcherHostConfig({...complete, LEARNED_RANGE: 'not json'})).toThrow(/LEARNED_RANGE/);
		expect(() => resolveFetcherHostConfig({...complete, LEARNED_RANGE: 'not json'})).toThrow(/not valid JSON/);
		expect(() => resolveFetcherHostConfig({...complete, LEARNED_RANGE: '[2000]'})).toThrow(/JSON object/);
		expect(() => resolveFetcherHostConfig({...complete, LEARNED_RANGE: '{"ceiling":"2000"}'})).toThrow(
			/LEARNED_RANGE.ceiling/,
		);
		expect(() => resolveFetcherHostConfig({...complete, LEARNED_RANGE: '{"nextSize":0}'})).toThrow(
			/positive whole number of blocks/,
		);
		expect(() => resolveFetcherHostConfig({...complete, LEARNED_RANGE: '{"safeSpan":-1}'})).toThrow(
			/positive whole number of blocks/,
		);
	});

	it('says at startup that it started from a remembered range, without quoting a credential', () => {
		const described = createFetcherHost(
			resolveFetcherHostConfig({...complete, LEARNED_RANGE: JSON.stringify(REPORTED)}),
			{
				provider: fakeChain().provider,
				target: {expectedFromBlock: async () => ({expectedFromBlock: 0}), send: async () => ({}) as never},
			},
		).describe();

		expect(described).toContain('learnedRange');
		expect(described).toContain('1999');
		expect(described).not.toContain(TOKEN);
		expect(described).not.toContain('A-SECRET-API-KEY');
	});
});
