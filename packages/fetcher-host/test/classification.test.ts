import {
	ArchiveRefusedError,
	IngestionRefusedError,
	IngestionUnavailableError,
	InvalidBatchError,
	NoFetchProgressError,
	SuspectedTruncationError,
	UnexpectedChainError,
	UnexpectedFromBlockError,
	WireContextMismatchError,
	type WireBatch,
} from '@etherfold/core';
import {describe, expect, it} from 'vitest';
import {
	COMMON_RESULT_CAP,
	createFetcherHost,
	delayForReport,
	FetcherConfigError,
	isRetryable,
	parseIndexingSource,
	resolveBackoff,
	resolveFetcherHostConfig,
	type CycleReport,
} from '../src/index.js';
import {abi, CONTRACT, deployReceiver, ENDPOINT, fakeChain, FINALITY, INDEXER, SOURCE, TOKEN} from './harness.js';

// ---------------------------------------------------------------------------
// WHAT THE HOST IS ALLOWED TO DECIDE, AND WHAT IT MUST BE TOLD
// ---------------------------------------------------------------------------

describe('retryability is read off the error and never re-derived', () => {
	// Asked of a REAL instance of every error `@etherfold/core` throws, so that a
	// new refusal type added there cannot quietly start being retried forever here:
	// this file has no list of names to forget to update, it has the errors
	// themselves.
	const context = {source: 'a', config: 'b'} as never;
	const cases: [string, Error, boolean][] = [
		['IngestionUnavailableError (a 5xx, or no answer at all)', new IngestionUnavailableError('down', 503), true],
		['IngestionRefusedError (401: the token is wrong)', new IngestionRefusedError(401, 'unauthorized', 'no'), false],
		['WireContextMismatchError (another indexer)', new WireContextMismatchError(context, context), false],
		['UnexpectedChainError (the wrong node)', new UnexpectedChainError('1', '137', 'before'), false],
		['SuspectedTruncationError (a cap that cannot be halved away)', new SuspectedTruncationError(1, 10000), false],
		['UnexpectedFromBlockError (the cursor refusal)', new UnexpectedFromBlockError(10, 5), false],
		['InvalidBatchError (a malformed envelope)', new InvalidBatchError('bad'), false],
		['NoFetchProgressError (a range fetcher going backwards)', new NoFetchProgressError(10, 5), false],
		[
			'ArchiveRefusedError (an endpoint that will not serve history at any range)',
			new ArchiveRefusedError(1, 1000, 'Archive requests require a personal token.'),
			false,
		],
	];

	for (const [what, error, retryable] of cases) {
		it(`${retryable ? 'retries' : 'stops on'} ${what}`, () => {
			expect(isRetryable(error)).toBe(retryable);
		});
	}

	it('retries an error that carries no opinion, which is what a node or a socket throws', () => {
		// deliberately the same default core takes: those are the errors nobody here
		// threw, and transience is the honest guess for them
		expect(isRetryable(new Error('socket hang up'))).toBe(true);
		expect(isRetryable(undefined)).toBe(true);
	});

	it('stops on a configuration error, which no amount of waiting fixes either', () => {
		expect(isRetryable(new FetcherConfigError('INGEST_ENDPOINT is unset'))).toBe(false);
	});

	it('classifies structurally, so an error from a second copy of core still stops the host', () => {
		// what an `instanceof` check gets wrong: same shape, different module instance
		const fromAnotherCopy = Object.assign(new Error('refused'), {name: 'IngestionRefusedError', retryable: false});
		expect(isRetryable(fromAnotherCopy)).toBe(false);
	});
});

// ---------------------------------------------------------------------------

describe('a cycle outcome becomes one of five things a scheduler can do', () => {
	async function hostDriving(outcomes: (() => Promise<never> | Promise<any>)[]) {
		const chain = fakeChain();
		const receiver = await deployReceiver();
		const host = createFetcherHost(
			resolveFetcherHostConfig(
				{},
				{source: SOURCE, endpoint: ENDPOINT, indexer: INDEXER, token: TOKEN, nodeUrl: 'http://node.test'},
			),
			{provider: chain.provider, fetch: receiver.fetch},
		);
		let call = 0;
		(host.fetcher as unknown as {fetchAndPush: () => Promise<unknown>}).fetchAndPush = () => outcomes[call++]();
		return host;
	}

	it('reports a landed batch as progress, and says whether it reached the tip', async () => {
		const host = await hostDriving([
			async () => ({
				status: 'pushed',
				fromBlock: 100,
				toBlock: 110,
				latestBlock: 120,
				logs: 3,
				applied: 3,
				retracted: 0,
				expectedFromBlock: 108,
				corrections: 0,
			}),
		]);
		const report = await host.runCycle();
		expect(report.kind).toBe('progress');
		expect(report.kind === 'progress' && report.caughtUp).toBe(false);
	});

	it('reports up-to-date as idle rather than as a failure', async () => {
		const host = await hostDriving([async () => ({status: 'up-to-date', expectedFromBlock: 121, latestBlock: 120})]);
		expect((await host.runCycle()).kind).toBe('idle');
		expect(host.consecutiveFailures).toBe(0);
	});

	it('reports yielded as contention, counts the run, and does not treat it as a failure', async () => {
		const yielded = async () => ({status: 'yielded', expectedFromBlock: 130, latestBlock: 140, corrections: 3});
		const host = await hostDriving([yielded, yielded, yielded]);

		const first = await host.runCycle();
		expect(first.kind).toBe('contended');
		expect(first.kind === 'contended' && first.run).toBe(1);
		await host.runCycle();
		const third = await host.runCycle();
		// a single one is what redundant fetchers do to each other; a RUN is a signal
		expect(third.kind === 'contended' && third.run).toBe(3);
		expect(host.consecutiveFailures).toBe(0);
	});

	it('separates retry from fatal by the error alone, and escalates only the retries', async () => {
		const host = await hostDriving([
			async () => {
				throw new IngestionUnavailableError('the server is restarting', 503);
			},
			async () => {
				throw new IngestionUnavailableError('the server is restarting', 503);
			},
			async () => {
				throw new IngestionRefusedError(401, 'unauthorized', 'the token does not match');
			},
		]);

		expect((await host.runCycle()).kind).toBe('retry');
		const second = await host.runCycle();
		expect(second.kind === 'retry' && second.run).toBe(2);

		const third = await host.runCycle();
		expect(third.kind).toBe('fatal');
		expect(third.kind === 'fatal' && (third.error as IngestionRefusedError).status).toBe(401);
	});

	it('forgets a run of failures as soon as a cycle gets an answer', async () => {
		const host = await hostDriving([
			async () => {
				throw new IngestionUnavailableError('down');
			},
			async () => ({status: 'up-to-date', expectedFromBlock: 121, latestBlock: 120}),
		]);
		await host.runCycle();
		expect(host.consecutiveFailures).toBe(1);
		await host.runCycle();
		expect(host.consecutiveFailures).toBe(0);
	});
});

// ---------------------------------------------------------------------------

describe('how long a host waits, given what the cycle did', () => {
	const backoff = resolveBackoff({
		pollIntervalMs: 4000,
		catchUpDelayMs: 0,
		minRetryDelayMs: 1000,
		maxRetryDelayMs: 60000,
		jitter: 0,
		random: () => 0,
	});
	const report = (partial: Partial<CycleReport>) => ({summary: '', ...partial}) as CycleReport;

	it('does not wait at all while there is known work left', () => {
		expect(delayForReport(report({kind: 'progress', caughtUp: false}), backoff)).toBe(0);
	});

	it('polls once it has reached the tip, and when there was nothing to fetch', () => {
		expect(delayForReport(report({kind: 'progress', caughtUp: true}), backoff)).toBe(4000);
		expect(delayForReport(report({kind: 'idle'}), backoff)).toBe(4000);
	});

	it('escalates a run of retryable failures, and caps it', () => {
		expect(delayForReport(report({kind: 'retry', run: 1}), backoff)).toBe(1000);
		expect(delayForReport(report({kind: 'retry', run: 2}), backoff)).toBe(2000);
		expect(delayForReport(report({kind: 'retry', run: 3}), backoff)).toBe(4000);
		expect(delayForReport(report({kind: 'retry', run: 30}), backoff)).toBe(60000);
	});

	it('escalates contention too, because losing that race repeatedly means stop racing', () => {
		expect(delayForReport(report({kind: 'contended', run: 1}), backoff)).toBe(4000);
		expect(delayForReport(report({kind: 'contended', run: 3}), backoff)).toBe(16000);
	});

	it('jitters downwards, so redundant fetchers do not retry in lockstep', () => {
		const jittered = resolveBackoff({minRetryDelayMs: 1000, jitter: 0.2, random: () => 1});
		expect(delayForReport(report({kind: 'retry', run: 1}), jittered)).toBe(800);
	});

	it('jitters BY DEFAULT, because the lockstep it prevents is the default deployment', () => {
		// The default is the load-bearing value: redundant fetchers are the case the
		// docstring names, and they are the ones least likely to have configured a
		// jitter. Asserted separately because every other case here passes one
		// explicitly, so a default of 0 would go unnoticed.
		expect(resolveBackoff({}).jitter).toBe(0.2);
		const defaulted = resolveBackoff({minRetryDelayMs: 1000, random: () => 1});
		expect(delayForReport(report({kind: 'retry', run: 1}), defaulted)).toBe(800);
	});
});

// ---------------------------------------------------------------------------

describe('configuration a deployment gets wrong', () => {
	const complete = {
		INDEXING_SOURCE: JSON.stringify(SOURCE),
		INGEST_ENDPOINT: ENDPOINT,
		INDEXER_NAME: INDEXER,
		INGEST_TOKEN: TOKEN,
		ETH_NODE_URI: 'https://eth.example/v2/A-SECRET-API-KEY',
	};

	it('names the missing variable, and only the variable', () => {
		expect(() => resolveFetcherHostConfig({...complete, ETH_NODE_URI: undefined})).toThrow(/ETH_NODE_URI is unset/);
		expect(() => resolveFetcherHostConfig({...complete, INDEXING_SOURCE: undefined})).toThrow(/INDEXING_SOURCE/);
	});

	it('leaves the WIRE variables to the host, which is where it is known whether there is one', () => {
		// A combined deployment feeds a stream-builder in its own process and has no
		// URL to give. Whether `INGEST_ENDPOINT` is required therefore depends on
		// something the environment cannot say, so resolving succeeds here...
		const config = resolveFetcherHostConfig({...complete, INGEST_ENDPOINT: undefined, INGEST_TOKEN: undefined});
		expect(config.endpoint).toBeUndefined();

		// ...and building a host that WOULD have pushed over HTTP is what refuses,
		// naming both variables and the way out for a host that has no wire on purpose
		expect(() => createFetcherHost(config, {provider: fakeChain().provider})).toThrow(
			/INGEST_ENDPOINT and INGEST_TOKEN are unset/,
		);
		expect(() => createFetcherHost(config, {provider: fakeChain().provider})).toThrow(/createDirectIngestion/);
	});

	it('refuses a source that would index nothing, or the wrong shape of chainId', () => {
		expect(() => parseIndexingSource('{"chainId":"1","contracts":[]}')).toThrow(/empty/);
		expect(() => parseIndexingSource('{"chainId":1,"contracts":[]}')).toThrow(/decimal string/);
		expect(() => parseIndexingSource(`{"chainId":"1","contracts":[{"abi":[],"address":"nope"}]}`)).toThrow(
			/0x address/,
		);
		expect(() => parseIndexingSource('not json')).toThrow(/not valid JSON/);
	});

	it('accepts the source it will actually be given', () => {
		const source = parseIndexingSource<typeof abi>(JSON.stringify(SOURCE));
		expect(source.chainId).toBe('1');
		expect((source.contracts as unknown as {address: string}[])[0].address).toBe(CONTRACT);
	});

	describe('the two result-count knobs, which are the sharpest edge here', () => {
		it('defaults the suspect count to the common cap, not to what this fetcher asks for', () => {
			const config = resolveFetcherHostConfig({...complete, MAX_EVENTS_PER_FETCH: '500'});
			// core would default `suspectResultCount` to `maxEventsPerFetch` if told
			// nothing. Lowering how much this fetcher ASKS for (the only lever a host has
			// over batch size) must not lower what it treats as a SILENTLY CAPPED answer:
			// that would make every fetch landing on 500 re-fetch a halved range for
			// nothing, and a single block holding exactly 500 stop the fetcher outright.
			expect(config.maxEventsPerFetch).toBe(500);
			expect(config.suspectResultCount).toBe(COMMON_RESULT_CAP);
		});

		it(`takes the node's real cap when a deployment states it`, () => {
			expect(resolveFetcherHostConfig({...complete, SUSPECT_RESULT_COUNT: '5000'}).suspectResultCount).toBe(5000);
		});

		it('refuses a suspect count that is not a positive whole number of logs', () => {
			expect(() => resolveFetcherHostConfig({...complete, SUSPECT_RESULT_COUNT: '0'})).toThrow(/positive whole number/);
			expect(() => resolveFetcherHostConfig({...complete, SUSPECT_RESULT_COUNT: 'lots'})).toThrow(/must be a number/);
		});

		it('passes both of them to the fetcher, independently', async () => {
			const receiver = await deployReceiver();
			const chain = fakeChain();
			const host = createFetcherHost(
				resolveFetcherHostConfig({...complete, MAX_EVENTS_PER_FETCH: '500', SUSPECT_RESULT_COUNT: '5000'}),
				{provider: chain.provider, fetch: receiver.fetch},
			);
			const inner = host.fetcher as unknown as {suspectResultCount: number};
			expect(inner.suspectResultCount).toBe(5000);
		});
	});

	it('never puts a credential in the line an operator reads at startup', () => {
		const config = resolveFetcherHostConfig(complete);
		const described = createFetcherHost(config, {
			provider: fakeChain().provider,
			target: {expectedFromBlock: async () => ({expectedFromBlock: 0}), send: async () => ({}) as never},
		}).describe();

		expect(described).not.toContain(TOKEN);
		expect(described).not.toContain('A-SECRET-API-KEY');
		// an RPC URL is a credential at every hosted provider: `.../v2/<key>`
		expect(described).toContain('https://eth.example');
		expect(described).toContain('/…');
		// and the thing an operator most needs to see IS said, in full
		expect(described).toContain('suspectResultCount=10000');
		expect(described).toMatch(/REAL eth_getLogs cap/);
	});
});

// ---------------------------------------------------------------------------

describe('the host holds nothing that outlives it', () => {
	it('starts every run with no cursor, and never gains a way to keep one', async () => {
		const receiver = await deployReceiver();
		const chain = fakeChain();
		const host = createFetcherHost(
			resolveFetcherHostConfig(
				{},
				{source: SOURCE, endpoint: ENDPOINT, indexer: INDEXER, token: TOKEN, nodeUrl: 'http://node.test'},
			),
			{provider: chain.provider, fetch: receiver.fetch},
		);

		expect(host.fetcher.cursorHint).toBeUndefined();
		expect(host.cyclesRun).toBe(0);
		// PINNED, in the same spirit as core's source scan: no behavioural test fails
		// when a host gains a field, and the field that must never appear here is one
		// holding a block number. `failureRun`, `contentionRun` and `cycles` are facts
		// about this RUN (they drive a delay and a warning) and are reset or discarded;
		// a fourth one wanting to survive a restart is the split brain ADR-0004 removes.
		expect(Object.keys(host).sort()).toEqual(['config', 'contentionRun', 'cycles', 'failureRun', 'fetcher']);
	});

	it('sends a batch through the real wire without either half being mocked', async () => {
		const receiver = await deployReceiver();
		const chain = fakeChain();
		const seen: WireBatch<never>[] = [];
		const host = createFetcherHost(
			resolveFetcherHostConfig(
				{},
				{
					source: SOURCE,
					endpoint: ENDPOINT,
					indexer: INDEXER,
					token: TOKEN,
					nodeUrl: 'http://node.test',
					stream: {finality: FINALITY},
				},
			),
			{
				provider: chain.provider,
				fetch: async (url, init) => {
					if (init.body) {
						seen.push(JSON.parse(init.body));
					}
					return receiver.fetch(url, init);
				},
			},
		);
		chain.serve([], 120);
		await host.runCycle();

		expect(seen[0]).toMatchObject({fromBlock: 100, toBlock: 120});
	});

	it('stops when its stream config does not match the receiver, before fetching a log', async () => {
		const receiver = await deployReceiver();
		const chain = fakeChain();
		chain.serve([], 120);
		const host = createFetcherHost(
			resolveFetcherHostConfig(
				{},
				{
					source: SOURCE,
					endpoint: ENDPOINT,
					indexer: INDEXER,
					token: TOKEN,
					nodeUrl: 'http://node.test',
					// the receiver runs a finality of FINALITY: same source, DIFFERENT config, so
					// this is a different indexer by identity. `stream` is configuration a
					// deployment gets to set and therefore gets to set WRONG.
					stream: {finality: FINALITY + 1},
				},
			),
			{provider: chain.provider, fetch: receiver.fetch},
		);

		const report = await host.runCycle();

		expect(report.kind).toBe('fatal');
		// caught at ask-time, so no log was fetched and nothing was pushed
		expect(chain.calls).not.toContain('eth_getLogs');
		expect(receiver.requests.map((request) => request.path)).toEqual([`/${INDEXER}/ingest/expected-from-block`]);
	});
});
