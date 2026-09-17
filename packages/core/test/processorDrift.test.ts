import {describe, expect, it, vi} from 'vitest';
import type {Abi} from 'abitype';
import {IndexerGeneration} from '../src/indexer.js';
import {processorDriftReport} from '../src/processorDrift.js';
import {simple_hash} from '../src/utils/hash.js';
import type {ContextIdentifier, EventProcessor, IndexingSource, LastSync, ProcessorDriftReport} from '../src/types.js';
import {identityOf} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------
// PROCESSOR DRIFT: the identity says "unchanged", the code says otherwise
// ---------------------------------------------------------------------------
// A processor's identity used to be AUTHOR-DECLARED, so an author who edited a
// handler and forgot to bump `version` got state computed by the PREVIOUS logic,
// adopted silently and served forever. Under docs/adr/0008 it is worse: an
// identity change is what triggers the blue-green rebuild, so a missed bump means
// the rebuild never runs.
//
// The IDENTITIES here now come from the ARRIVAL (ADR-0086) because that is how
// this engine is told what a fold is called, but WHAT IS ASSERTED is unchanged:
// the check compares the FINGERPRINT on a persisted cursor against the one the
// running processor reports, at an identity that did not move. ADR-0086 is what
// eventually makes the condition unrepresentable rather than merely reported, and
// `the-declared-version-and-the-drift-report-are-deleted` removes this file with
// the fingerprint it is about.
//
// The fingerprint is the second opinion. It is compared HERE, in the core,
// rather than in each `EventProcessor` implementation, because drift is defined
// relative to the core's own adopt-or-discard decision ("version hash equal but
// code different"), and re-deriving that decision inside each implementation
// would duplicate the branch that `processor-sqlite/src/sync.ts` already had to
// reason about once.
// ---------------------------------------------------------------------------

function makeProvider() {
	return {
		async request(args: {method: string; params?: any}): Promise<any> {
			switch (args.method) {
				case 'eth_chainId':
					return '0x1';
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

const SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0}],
};

/** A context the core will ACCEPT (source and stream config match the defaults). */
function storedContext(processorHash: string, processorFingerprint?: string): ContextIdentifier {
	return {
		source: [{startBlock: 0, hash: simple_hash(SOURCE)}],
		config: simple_hash({finality: 17}),
		processor: processorHash,
		...(processorFingerprint === undefined ? {} : {processorFingerprint}),
	};
}

function storedLastSync(context: ContextIdentifier): LastSync<Abi> {
	return {context, latestBlock: 100, lastFromBlock: 0, lastToBlock: 100, unconfirmedBlocks: []};
}

/** A processor that hands back a persisted cursor, as a keeper-backed one would. */
function makeProcessor(
	marker: string,
	options: {stored?: ContextIdentifier; fingerprint?: string} = {},
): EventProcessor<Abi, void> & {cleared: boolean} {
	const processor = {
		cleared: false,
		// The DECLARED path, still on the seam until the contract task removes it:
		// `indexerWith` hands the engine `identityOf(marker)` instead.
		getVersionHash: () => `declared-version-of-${marker}`,
		getCodeFingerprint: () => options.fingerprint,
		load: async () => (options.stored ? {state: undefined, lastSync: storedLastSync(options.stored)} : undefined),
		process: async () => undefined,
		reset: async () => {},
		clear: async () => {
			processor.cleared = true;
		},
	} as any;
	return processor;
}

function indexerWith(
	processor: EventProcessor<Abi, void>,
	config: {strictProcessorDrift?: boolean} = {},
	marker = 'v1',
) {
	const reports: ProcessorDriftReport[] = [];
	const indexer = new IndexerGeneration<Abi, void>(makeProvider(), processor, SOURCE, config, {
		processorIdentity: identityOf(marker),
	});
	indexer.onProcessorDrift = (report) => reports.push(report);
	return {indexer, reports};
}

describe('processor drift detection', () => {
	it('reports when the version hash is unchanged but the handler code is not', async () => {
		const processor = makeProcessor('v1', {
			stored: storedContext(identityOf('v1'), 'fingerprint-A'),
			fingerprint: 'fingerprint-B',
		});
		const {indexer, reports} = indexerWith(processor);

		await indexer.load();

		expect(reports).toHaveLength(1);
		expect(reports[0].previousFingerprint).toBe('fingerprint-A');
		expect(reports[0].currentFingerprint).toBe('fingerprint-B');
		// WHICH question this answers: the BOOT one, "the persisted state was computed by
		// different logic" -- and never the reload one, which compares a re-imported
		// module with the fold that is running and can disagree with this
		expect(reports[0].compared).toBe('persisted-state');
		// the report NAMES which processor drifted, by the identity both sides agree on
		expect(reports[0].processorHash).toBe(identityOf('v1'));
		expect(reports[0].message).toContain(identityOf('v1'));
	});

	it('does not halt on drift by default: the state is still adopted', async () => {
		// The false positive is real (a re-minification changes handler source without
		// changing behaviour), so the default cannot be a refusal to start.
		const processor = makeProcessor('v1', {
			stored: storedContext(identityOf('v1'), 'fingerprint-A'),
			fingerprint: 'fingerprint-B',
		});
		const {indexer, reports} = indexerWith(processor);

		const lastSync = await indexer.load();

		expect(reports).toHaveLength(1);
		expect(lastSync.lastToBlock).toBe(100);
		expect(processor.cleared).toBe(false);
	});

	it('refuses to start under strictProcessorDrift', async () => {
		const processor = makeProcessor('v1', {
			stored: storedContext(identityOf('v1'), 'fingerprint-A'),
			fingerprint: 'fingerprint-B',
		});
		const {indexer, reports} = indexerWith(processor, {strictProcessorDrift: true});

		await expect(indexer.load()).rejects.toThrow(/PROCESSOR DRIFT/);
		// ...and the host still learns WHY: the report goes out before the throw
		expect(reports).toHaveLength(1);
	});

	it('says nothing when the fingerprint matches', async () => {
		const processor = makeProcessor('v1', {
			stored: storedContext(identityOf('v1'), 'fingerprint-A'),
			fingerprint: 'fingerprint-A',
		});
		const {indexer, reports} = indexerWith(processor);

		await indexer.load();

		expect(reports).toEqual([]);
	});

	it('says nothing when the IDENTITY moved, code change or not', async () => {
		// A deliberate change is never a drift. The state is discarded on the identity,
		// which is the mechanism this whole check exists to back up, not replace.
		const processor = makeProcessor('v2', {
			stored: storedContext(identityOf('v1'), 'fingerprint-A'),
			fingerprint: 'fingerprint-B',
		});
		const {indexer, reports} = indexerWith(processor, {}, 'v2');

		await indexer.load();

		expect(reports).toEqual([]);
		expect(processor.cleared).toBe(true);
	});

	it('says nothing for a cursor persisted BEFORE fingerprints existed', async () => {
		// Absence means "unknown", never "drifted". Otherwise every existing
		// deployment reports drift exactly once on upgrade, and a report that cried
		// wolf on day one is a report nobody reads on day two.
		const legacy = storedContext(identityOf('v1'));
		expect('processorFingerprint' in legacy).toBe(false);
		const processor = makeProcessor('v1', {stored: legacy, fingerprint: 'fingerprint-B'});
		const {indexer, reports} = indexerWith(processor);

		await indexer.load();

		expect(reports).toEqual([]);
	});

	it('says nothing when the processor cannot fingerprint itself', async () => {
		// `getCodeFingerprint` is REQUIRED on `EventProcessor`, but it may ANSWER
		// `undefined`: a processor whose handlers are all bound or proxied has no
		// readable source. "Cannot tell" is not "changed", so nothing is reported.
		const processor = makeProcessor('v1', {stored: storedContext(identityOf('v1'), 'fingerprint-A')});
		const {indexer, reports} = indexerWith(processor);

		await indexer.load();

		expect(reports).toEqual([]);
	});

	it('says nothing when there is no persisted state to be stale', async () => {
		const processor = makeProcessor('v1', {fingerprint: 'fingerprint-B'});
		const {indexer, reports} = indexerWith(processor);

		await indexer.load();

		expect(reports).toEqual([]);
	});

	it('reports again on the NEXT boot, rather than going quiet after being seen once', async () => {
		// The stored fingerprint describes the code that computed the state, so it is
		// not refreshed when the drift is reported: the condition lasts until the
		// author bumps `version`, and so does the report.
		const stored = storedContext(identityOf('v1'), 'fingerprint-A');
		const first = indexerWith(makeProcessor('v1', {stored, fingerprint: 'fingerprint-B'}));
		await first.indexer.load();
		const second = indexerWith(makeProcessor('v1', {stored, fingerprint: 'fingerprint-B'}));
		await second.indexer.load();

		expect(first.reports).toHaveLength(1);
		expect(second.reports).toHaveLength(1);
	});

	it('records the CURRENT fingerprint on a fresh cursor, so the next boot can compare', async () => {
		const processor = makeProcessor('v1', {fingerprint: 'fingerprint-B'});
		const {indexer} = indexerWith(processor);

		const lastSync = await indexer.load();

		expect(lastSync.context.processorFingerprint).toBe('fingerprint-B');
	});

	it('survives a listener that throws, because a drift report must not break loading', async () => {
		const processor = makeProcessor('v1', {
			stored: storedContext(identityOf('v1'), 'fingerprint-A'),
			fingerprint: 'fingerprint-B',
		});
		const indexer = new IndexerGeneration<Abi, void>(
			makeProvider(),
			processor,
			SOURCE,
			{},
			{
				processorIdentity: identityOf('v1'),
			},
		);
		indexer.onProcessorDrift = () => {
			throw new Error('listener blew up');
		};

		await expect(indexer.load()).resolves.toBeTruthy();
	});

	it('is never silent: it logs at ERROR even with no listener set', async () => {
		// A callback nobody sets would be a silent detector; a log nobody can route
		// would be hard to alert on. It does both, and the log level is `error`
		// because "the state you are serving was computed by code that no longer
		// exists" is not an info.
		const {logs} = await import('named-logs');
		const namedLogger = logs('@etherfold/core');
		const spy = vi.spyOn(namedLogger, 'error').mockImplementation(() => {});
		try {
			const processor = makeProcessor('v1', {
				stored: storedContext(identityOf('v1'), 'fingerprint-A'),
				fingerprint: 'fingerprint-B',
			});
			const indexer = new IndexerGeneration<Abi, void>(
				makeProvider(),
				processor,
				SOURCE,
				{},
				{
					processorIdentity: identityOf('v1'),
				},
			);

			await indexer.load();

			expect(spy).toHaveBeenCalledWith(expect.stringContaining('PROCESSOR DRIFT'));
		} finally {
			spy.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------------------------------
// THE COMPARISON ITSELF, WHICH FOUR SURFACES SHARE
// ---------------------------------------------------------------------------------------------------
// Two of them are in this package (both engines that adopt a cursor) and one is
// not: the RELOAD question can only be asked where a module is re-imported, which
// is the CLI's reconfigure endpoint. So the builder is published, and these are
// the rules it holds every caller to -- one phrase to grep for, one shape to
// route, and absence that is never read as drift.
// ---------------------------------------------------------------------------------------------------

describe('processorDriftReport', () => {
	it('answers the RELOAD question in the same vocabulary, naming both fingerprints and the action', () => {
		const report = processorDriftReport({
			processorHash: 'v1',
			compared: 'reloaded-module',
			previousFingerprint: 'fp-running',
			currentFingerprint: 'fp-on-disk',
		});

		expect(report?.compared).toBe('reloaded-module');
		expect(report?.previousFingerprint).toBe('fp-running');
		expect(report?.currentFingerprint).toBe('fp-on-disk');
		// ONE phrase for an operator to grep, whichever question was asked
		expect(report?.message).toContain('PROCESSOR DRIFT');
		expect(report?.message).toContain('fp-running');
		expect(report?.message).toContain('fp-on-disk');
		expect(report?.message).toContain('version');
		// phrased as a QUESTION for the author rather than a verdict, because the
		// fingerprint does not survive a minifier, a transpiler change or a comment edit
		expect(report?.message).toContain('advisory');
	});

	it('says which question was asked, because the two are not interchangeable', () => {
		const boot = processorDriftReport({
			processorHash: 'v1',
			compared: 'persisted-state',
			previousFingerprint: 'fp-A',
			currentFingerprint: 'fp-B',
		});
		const reload = processorDriftReport({
			processorHash: 'v1',
			compared: 'reloaded-module',
			previousFingerprint: 'fp-A',
			currentFingerprint: 'fp-B',
		});

		// the same pair of values, two different things to tell an operator: one is
		// about the STATE being served, the other about the MODULE just read
		expect(boot?.message).not.toBe(reload?.message);
		expect(boot?.message).toContain('persisted state');
		expect(reload?.message).toContain('re-read');
	});

	it('is silent when the two agree, and silent when either side cannot answer', () => {
		const same = {processorHash: 'v1', compared: 'reloaded-module'} as const;
		expect(processorDriftReport({...same, previousFingerprint: 'fp-A', currentFingerprint: 'fp-A'})).toBeUndefined();
		// "cannot tell" is not "changed", on either side and on either question
		expect(processorDriftReport({...same, previousFingerprint: undefined, currentFingerprint: 'fp-B'})).toBeUndefined();
		expect(processorDriftReport({...same, previousFingerprint: 'fp-A', currentFingerprint: undefined})).toBeUndefined();
		expect(
			processorDriftReport({
				processorHash: 'v1',
				compared: 'persisted-state',
				previousFingerprint: undefined,
				currentFingerprint: undefined,
			}),
		).toBeUndefined();
	});
});
