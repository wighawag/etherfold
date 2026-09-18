import {describe, expect, it} from 'vitest';
import type {Abi, IndexingSource, LogEvent} from '@etherfold/core';
import {IndexerGeneration} from '@etherfold/core';
import {createIndexerState, type EntityEventProcessorLike} from '../src/IndexerState.js';
import {generationOf} from './utils/fakeGeneration.js';
import {identityOf} from './utils/processorIdentity.js';

// chainId '1' as the 0x-hex the provider returns
const CHAIN_ID_HEX = '0x1';
// a *different* chain id, used to simulate a provider connected to another chain
const OTHER_CHAIN_ID_HEX = '0x5';

function makeProvider(chainIdHex: string = CHAIN_ID_HEX) {
	return {
		async request(args: {method: string; params?: any}): Promise<any> {
			switch (args.method) {
				case 'eth_chainId':
					return chainIdHex;
				case 'eth_blockNumber':
					return '0x0';
				case 'eth_getLogs':
					return [];
				default:
					throw new Error(`unexpected method ${args.method}`);
			}
		},
	} as any;
}

type State = {count: number};

/**
 * A fake fold, and the HANDLER SOURCES it reports.
 *
 * The arrival here is a MODULE a dev server handed the tab, which has no bytes to
 * hash, so it is named by its handler sources --
 * `moduleProcessorIdentity(processor)`, which is `getCodeFingerprint()` and
 * nothing else (ADR-0086,
 * `a-module-handed-to-a-tab-is-identified-by-its-handler-sources`). A fake has no
 * handlers to fingerprint, so the marker below stands in for them: two markers
 * are two folds and one marker is always the same fold, which is the only
 * property these cases need. The hook derives that identity ITSELF and takes
 * none from the caller, which is why `generationOf` is given no identity here
 * and one is never passed to `updateProcessor`.
 *
 * The marker is what MOVES to ask for a swap, so the swap is decided by what the
 * fold IS rather than by anything it declares.
 */
function makeProcessor(marker = 'the-handlers-as-served'): EntityEventProcessorLike<Abi, State, undefined> {
	return {
		// required on `EventProcessor`, and load-bearing HERE: it is the module
		// arrival's whole derivation, so a fake that answered `undefined` would be a
		// module with no readable source -- which is REFUSED, and is what
		// `aModuleIsIdentifiedByItsHandlerSources.test.ts` pins
		getCodeFingerprint: () => `fp-${marker}`,
		state: {count: 0},
		configure: () => {},
		load: async () => undefined,
		process: async () => ({count: 0}),
		reset: async () => {},
		clear: async () => {},
	};
}

const SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0}],
};

// a new source (e.g. a newly deployed contract) on the SAME chain so updateIndexer resets cleanly
const NEW_SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [
		{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0},
		{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000002', startBlock: 0},
	],
};

describe('createIndexerState - live reload (HIGH #1: async + error routing)', () => {
	it('updateIndexer returns an awaitable promise and routes core errors to $syncing.error', async () => {
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor(), identityOf('the-tab')));
		await indexer.init({provider: makeProvider(), source: SOURCE});

		// do an initial load so the indexer is in a stable state
		await indexer.indexMore();

		// Reconfigure with a provider connected to a DIFFERENT chain but no new source.
		// The core updateIndexer performs an async chainId check and rejects in this case.
		// The browser wrapper must (a) return a promise we can await/catch, and
		// (b) route the failure into $syncing.error rather than leaving an unhandled rejection.
		const result = indexer.updateIndexer({provider: makeProvider(OTHER_CHAIN_ID_HEX)});

		// It must be awaitable (a promise), not a synchronous void.
		expect(result).toBeInstanceOf(Promise);

		await expect(result).rejects.toBeTruthy();

		expect(indexer.syncing.$state.error).toBeDefined();
	});
});

describe('createIndexerState - live reload (HIGH #2: clear syncing state on reconfigure)', () => {
	it('clears $syncing.lastSync on updateIndexer so setupIndexing re-runs for the new config', async () => {
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor(), identityOf('the-tab')));
		await indexer.init({provider: makeProvider(), source: SOURCE});

		// initial load -> $syncing.lastSync becomes populated
		await indexer.indexMore();
		expect(indexer.syncing.$state.lastSync).toBeDefined();

		// reconfigure with a NEW source (new contract). The core indexer is re-init'd / reset.
		await indexer.updateIndexer({source: NEW_SOURCE});

		// The browser wrapper must clear its own stale lastSync so setupIndexing() does NOT
		// early-return with progress computed against the old configuration.
		expect(indexer.syncing.$state.lastSync).toBeUndefined();
	});

	it('does NOT clear $syncing.lastSync when the core reconfigure fails (option b)', async () => {
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor(), identityOf('the-tab')));
		await indexer.init({provider: makeProvider(), source: SOURCE});

		await indexer.indexMore();
		expect(indexer.syncing.$state.lastSync).toBeDefined();

		// A failing reconfigure (different chain, no new source) must leave the previous
		// valid progress intact while surfacing the error.
		await expect(indexer.updateIndexer({provider: makeProvider(OTHER_CHAIN_ID_HEX)})).rejects.toBeTruthy();

		expect(indexer.syncing.$state.lastSync).toBeDefined();
		expect(indexer.syncing.$state.error).toBeDefined();
	});
});

describe('createIndexerState - live reload (MEDIUM #3: pause auto-indexing during reconfigure)', () => {
	it('pauses auto-indexing while a reconfigure is in flight and resumes it after', async () => {
		// Gate we resolve manually to keep the core updateIndexer "in flight".
		let releaseReconfigure!: () => void;
		const reconfigureGate = new Promise<void>((resolve) => (releaseReconfigure = resolve));

		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor(), identityOf('the-tab')), {
			// The fifth argument is the identity this generation was REGISTERED under, and
			// forwarding it is what keeps the engine answering to the name the registry
			// filed (ADR-0086).
			createIndexer: (provider, processor, source, config, processorIdentity) => {
				const real = new IndexerGeneration<Abi, State>(provider, processor, source, config, {processorIdentity});
				const realUpdateIndexer = real.updateIndexer.bind(real);
				real.updateIndexer = (async (update: any) => {
					// stay in flight until the test releases the gate
					await reconfigureGate;
					return realUpdateIndexer(update);
				}) as any;
				return real;
			},
		});
		await indexer.init({provider: makeProvider(), source: SOURCE});

		// start the auto-index loop (long interval so its timer does not interfere with this test)
		await indexer.startAutoIndexing(3600);
		expect(indexer.syncing.$state.autoIndexing).toBe(true);

		// kick off a reconfigure that stays in flight (gated)
		const reconfiguring = indexer.updateIndexer({source: NEW_SOURCE});
		// let the synchronous part of updateIndexer run up to the gate
		await Promise.resolve();

		// BUG (#3): auto-indexing keeps running during the reconfigure. With the fix it is paused
		// for the duration so a timer tick cannot race the mid-reinit core.
		expect(indexer.syncing.$state.autoIndexing).toBe(false);

		// release the reconfigure and let it complete
		releaseReconfigure();
		await reconfiguring;

		// auto-indexing should be resumed after the reconfigure
		expect(indexer.syncing.$state.autoIndexing).toBe(true);

		// cleanup: stop the loop so no timers leak
		indexer.stopAutoIndexing();
	});
});

// Helper: wrap a real IndexerGeneration so that updateIndexer/updateProcessor record an ordered
// trace of enter/exit and (optionally) block until a test-controlled gate is released. This lets
// us deterministically detect whether two overlapping reconfigure calls interleave.
function recordingIndexer() {
	const trace: string[] = [];
	const gates: {[key: string]: {promise: Promise<void>; release: () => void}} = {};

	function gate(key: string) {
		let release!: () => void;
		const promise = new Promise<void>((resolve) => (release = resolve));
		gates[key] = {promise, release};
		return gates[key];
	}

	// the fifth argument is the identity this generation was REGISTERED under, and
	// forwarding it is what keeps the engine answering to the name the registry
	// filed (ADR-0086)
	const createIndexer = (provider: any, processor: any, source: any, config: any, processorIdentity: string) => {
		const real = new IndexerGeneration<Abi, State>(provider, processor, source, config, {processorIdentity});

		const realUpdateIndexer = real.updateIndexer.bind(real);
		real.updateIndexer = (async (update: any) => {
			trace.push('updateIndexer:enter');
			if (gates['updateIndexer']) {
				await gates['updateIndexer'].promise;
			}
			const r = await realUpdateIndexer(update);
			trace.push('updateIndexer:exit');
			return r;
		}) as any;

		const realUpdateProcessor = real.updateProcessor.bind(real);
		// `opts` is forwarded rather than dropped: it carries the identity the MODULE
		// arrival derived for the processor being handed over (ADR-0086), and a wrapper
		// that swallowed it would make the engine see an unnamed fold that no deployment
		// ever hands it.
		real.updateProcessor = (async (p: any, opts: any) => {
			trace.push('updateProcessor:enter');
			if (gates['updateProcessor']) {
				await gates['updateProcessor'].promise;
			}
			const r = await realUpdateProcessor(p, opts);
			trace.push('updateProcessor:exit');
			return r;
		}) as any;

		return real;
	};

	return {createIndexer, trace, gate};
}

describe('createIndexerState - live reload (MEDIUM #4: overlapping reconfigure calls must serialize)', () => {
	it('updateProcessor started while updateIndexer is in flight must NOT interleave (source then processor)', async () => {
		const {createIndexer, trace, gate} = recordingIndexer();
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor()), {createIndexer});
		await indexer.init({provider: makeProvider(), source: SOURCE});
		await indexer.indexMore();

		// keep the first reconfigure (source change) in flight
		const g = gate('updateIndexer');
		const p1 = indexer.updateIndexer({source: NEW_SOURCE});
		await Promise.resolve();

		// while it is in flight, a processor change event arrives (user fixed handlers for new ABI)
		const p2 = indexer.updateProcessor(makeProcessor('the-handlers-after-the-save'));
		await Promise.resolve();

		// release the first; let both settle
		g.release();
		await Promise.allSettled([p1, p2]);

		// EXPECTED (serialized): updateIndexer fully completes before updateProcessor starts.
		// BUG (current): updateProcessor:enter appears before updateIndexer:exit -> interleaved.
		const idxExit = trace.indexOf('updateIndexer:exit');
		const procEnter = trace.indexOf('updateProcessor:enter');
		expect(idxExit).toBeGreaterThanOrEqual(0);
		expect(procEnter).toBeGreaterThan(idxExit);
	});

	it('updateIndexer started while updateProcessor is in flight must NOT interleave (processor then source)', async () => {
		const {createIndexer, trace, gate} = recordingIndexer();
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor()), {createIndexer});
		await indexer.init({provider: makeProvider(), source: SOURCE});
		await indexer.indexMore();

		// keep the processor change in flight
		const g = gate('updateProcessor');
		const p1 = indexer.updateProcessor(makeProcessor('the-handlers-after-the-save'));
		await Promise.resolve();

		// while it is in flight, the (slow) deploy completes and a source change arrives
		const p2 = indexer.updateIndexer({source: NEW_SOURCE});
		await Promise.resolve();

		g.release();
		await Promise.allSettled([p1, p2]);

		const procExit = trace.indexOf('updateProcessor:exit');
		const idxEnter = trace.indexOf('updateIndexer:enter');
		expect(procExit).toBeGreaterThanOrEqual(0);
		expect(idxEnter).toBeGreaterThan(procExit);
	});

	it('two updateIndexer calls in quick succession must serialize (not interleave)', async () => {
		const {createIndexer, trace, gate} = recordingIndexer();
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor()), {createIndexer});
		await indexer.init({provider: makeProvider(), source: SOURCE});
		await indexer.indexMore();

		const g = gate('updateIndexer');
		const p1 = indexer.updateIndexer({source: NEW_SOURCE});
		await Promise.resolve();
		const p2 = indexer.updateIndexer({source: SOURCE});
		await Promise.resolve();

		g.release();
		await Promise.allSettled([p1, p2]);

		// Expect strictly serialized: enter,exit,enter,exit (no two enters before an exit).
		const onlyIndexer = trace.filter((t) => t.startsWith('updateIndexer'));
		expect(onlyIndexer).toEqual([
			'updateIndexer:enter',
			'updateIndexer:exit',
			'updateIndexer:enter',
			'updateIndexer:exit',
		]);
	});
});

describe('createIndexerState - live reload (#5: updateProcessor force option passthrough)', () => {
	it('forwards the {force} option to the core updateProcessor', async () => {
		let receivedOptions: any;
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor()), {
			createIndexer: (provider, processor, source, config, processorIdentity) => {
				const real = new IndexerGeneration<Abi, State>(provider, processor, source, config, {processorIdentity});
				const realUpdateProcessor = real.updateProcessor.bind(real);
				real.updateProcessor = (async (p: any, opts: any) => {
					receivedOptions = opts;
					return realUpdateProcessor(p, opts);
				}) as any;
				return real;
			},
		});
		await indexer.init({provider: makeProvider(), source: SOURCE});
		await indexer.indexMore();

		// The SAME fold again -- same marker, so the same handler sources and the same
		// module identity -- plus `force: true`, which is what an integrator reaches for
		// when the fold changed in a way the source text does not carry. It must still be
		// forwarded so the core performs the swap it would otherwise decline.
		await indexer.updateProcessor(makeProcessor(), {force: true});

		// `{force}` reaches the core, beside the identity the hook derived for the module
		// itself -- which the hook takes from the processor and never from this caller
		// (ADR-0086), so it is asserted as what `makeProcessor` reports rather than as a
		// literal.
		expect(receivedOptions).toEqual({force: true, processorIdentity: makeProcessor().getCodeFingerprint()});
	});
});
