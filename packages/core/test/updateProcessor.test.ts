import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import {IndexerGeneration} from '../src/indexer.js';
import type {EventProcessor, IndexingSource} from '../src/types.js';
import {identityOf} from './utils/processorIdentity.js';

// Minimal provider: empty chain, no logs.
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

type Hooks = {clearGate?: Promise<void>; resetGate?: Promise<void>};

/**
 * A processor, plus the marker naming the synthetic BYTES it ARRIVED as.
 *
 * ADR-0086: a processor cannot state its own identity, so every construction and
 * every swap below hands the engine `identityOf(marker)` and the declared hash is
 * read by nobody.
 */
function makeProcessor(marker: string, hooks: Hooks = {}): EventProcessor<Abi, void> {
	return {
		getVersionHash: () => `declared-version-of-${marker}`,
		// required on `EventProcessor`: a fake that omits it is a fake that would
		// lose drift detection without anybody noticing
		getCodeFingerprint: () => undefined,
		load: async () => undefined,
		process: async () => undefined,
		reset: async () => {
			if (hooks.resetGate) await hooks.resetGate;
		},
		clear: async () => {
			if (hooks.clearGate) await hooks.clearGate;
		},
	} as any;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return {promise, resolve};
}

describe('IndexerGeneration.updateProcessor (core #5: align with updateIndexer)', () => {
	it('blocks the index action while an (identity-changing) updateProcessor is in flight (like updateIndexer)', async () => {
		// gate the OLD processor's clear() — that is what updateProcessor awaits before calling load(),
		// so during this window load() has NOT started yet and the only thing that should prevent a
		// racing indexMore is disableProcessing()/block().
		const gate = deferred();
		const original = makeProcessor('v1', {clearGate: gate.promise});
		const indexer = new IndexerGeneration<Abi, void>(
			makeProvider(),
			original,
			SOURCE,
			{},
			{processorIdentity: identityOf('v1')},
		);
		await indexer.load();

		const updating = indexer.updateProcessor(makeProcessor('v2'), {processorIdentity: identityOf('v2')});
		await Promise.resolve();

		// While reconfiguring, processing must be disabled so a racing indexMore cannot run
		// against the half-swapped indexer. updateIndexer guarantees this via disableProcessing();
		// updateProcessor must do the same.
		expect(() => indexer.indexMore()).toThrow('Blocked');

		gate.resolve();
		await updating;
	});

	it('re-enables processing after an identity-changing updateProcessor resolves', async () => {
		const indexer = new IndexerGeneration<Abi, void>(
			makeProvider(),
			makeProcessor('v1'),
			SOURCE,
			{},
			{processorIdentity: identityOf('v1')},
		);
		await indexer.load();

		await indexer.updateProcessor(makeProcessor('v2'), {processorIdentity: identityOf('v2')});

		// after the swap settles, indexMore must work again (processing re-enabled)
		await expect(indexer.indexMore()).resolves.toBeTruthy();
	});

	it('does not swap this.processor before deciding (no-op path must not replace the instance mid-flight)', async () => {
		const original = makeProcessor('v1');
		const indexer = new IndexerGeneration<Abi, void>(
			makeProvider(),
			original,
			SOURCE,
			{},
			{processorIdentity: identityOf('v1')},
		);
		await indexer.load();

		// An update carrying the SAME identity is a no-op: there is nothing to reset/reload, so
		// the running processor instance should not be silently replaced (which would swap
		// mid-flight before the identity check even decided anything needed to happen).
		const sameVersion = makeProcessor('v1');
		await indexer.updateProcessor(sameVersion, {processorIdentity: identityOf('v1')});

		expect((indexer as any).processor).toBe(original);
	});

	it('swaps a same-version processor when force:true is passed', async () => {
		const original = makeProcessor('v1');
		const indexer = new IndexerGeneration<Abi, void>(
			makeProvider(),
			original,
			SOURCE,
			{},
			{processorIdentity: identityOf('v1')},
		);
		await indexer.load();

		// The same identity -- the same bytes arrived -- but the caller explicitly forces the
		// swap, which is the one way a fold is replaced without its name moving.
		const sameVersionForced = makeProcessor('v1');
		await indexer.updateProcessor(sameVersionForced, {force: true, processorIdentity: identityOf('v1')});

		expect((indexer as any).processor).toBe(sameVersionForced);
	});

	it('force:true clears the old processor and reloads even when the identity is unchanged', async () => {
		let cleared = false;
		const original = makeProcessor('v1');
		(original as any).clear = async () => {
			cleared = true;
		};
		const indexer = new IndexerGeneration<Abi, void>(
			makeProvider(),
			original,
			SOURCE,
			{},
			{processorIdentity: identityOf('v1')},
		);
		await indexer.load();

		await indexer.updateProcessor(makeProcessor('v1'), {force: true, processorIdentity: identityOf('v1')});

		expect(cleared).toBe(true);
	});
});

/**
 * What a reconfigure REPORTS, which is the half a caller holding a copy of the
 * state has to act on.
 *
 * The three verbs all end in one of two very different places -- the state
 * survives, or it is gone and being recomputed -- and used to say nothing about
 * which. `@etherfold/browser` needs the answer to re-seed the store it
 * publishes; anything else with its own copy needs it for the same reason. It is
 * REPORTED rather than inferred because the alternative is every caller
 * re-deriving this rule (the version hash, `force`, and the source hashes), and
 * a caller that derives it wrong fails silently.
 */
describe('IndexerGeneration reconfigure outcomes', () => {
	it('reports a discard when the processor IDENTITY changed', async () => {
		const indexer = new IndexerGeneration<Abi, void>(
			makeProvider(),
			makeProcessor('v1'),
			SOURCE,
			{},
			{processorIdentity: identityOf('v1')},
		);
		await indexer.load();

		expect(await indexer.updateProcessor(makeProcessor('v2'), {processorIdentity: identityOf('v2')})).toEqual({
			stateDiscarded: true,
		});
	});

	it('reports NO discard when the identity did not move, because the swap was skipped', async () => {
		const indexer = new IndexerGeneration<Abi, void>(
			makeProvider(),
			makeProcessor('v1'),
			SOURCE,
			{},
			{processorIdentity: identityOf('v1')},
		);
		await indexer.load();

		// the SAME bytes arrived again, so the identity says the fold did not change and
		// the running processor is kept
		expect(await indexer.updateProcessor(makeProcessor('v1'), {processorIdentity: identityOf('v1')})).toEqual({
			stateDiscarded: false,
		});
	});

	it('reports a discard when force is passed against an unchanged identity', async () => {
		const indexer = new IndexerGeneration<Abi, void>(
			makeProvider(),
			makeProcessor('v1'),
			SOURCE,
			{},
			{processorIdentity: identityOf('v1')},
		);
		await indexer.load();

		expect(
			await indexer.updateProcessor(makeProcessor('v1'), {force: true, processorIdentity: identityOf('v1')}),
		).toEqual({stateDiscarded: true});
	});

	it('reports a discard when the source changed, and none when it hashes the same', async () => {
		const indexer = new IndexerGeneration<Abi, void>(
			makeProvider(),
			makeProcessor('v1'),
			SOURCE,
			{},
			{processorIdentity: identityOf('v1')},
		);
		await indexer.load();

		// a DIFFERENT object carrying the same contents: the hash is over the
		// contents, so this is indistinguishable from no change at all
		const same: IndexingSource<Abi> = {
			chainId: '1',
			contracts: [{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0}],
		};
		expect(await indexer.updateIndexer({source: same})).toEqual({
			stateDiscarded: false,
			sourceInvalidation: {state: {valid: true}, stream: {valid: true}},
		});

		// a second contract: a different source, so the stored state cannot stand
		const changed: IndexingSource<Abi> = {
			chainId: '1',
			contracts: [
				{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0},
				{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000002', startBlock: 0},
			],
		};
		expect(await indexer.updateIndexer({source: changed})).toMatchObject({stateDiscarded: true});
	});

	it('always reports a discard from reset, because reset IS the discard', async () => {
		const indexer = new IndexerGeneration<Abi, void>(
			makeProvider(),
			makeProcessor('v1'),
			SOURCE,
			{},
			{processorIdentity: identityOf('v1')},
		);
		await indexer.load();

		expect(await indexer.reset()).toEqual({stateDiscarded: true});
	});
});

/**
 * THE VERDICT IS PUBLISHED, instead of being computed and dropped.
 *
 * `updateIndexer` has always asked `sourceInvalidationOf` whether the stored
 * data still describes the source now being run, and has always gone on to throw
 * the answer away: the two halves and the block each of them names reached a log
 * line and nothing else. `stateDiscarded` is the collapse of that answer into one
 * bit, and one bit cannot say WHICH half died or FROM WHICH BLOCK -- which is
 * exactly what a caller building a new generation beside the live one has to
 * know, and it lives browser-side, across the package boundary.
 *
 * So the verdict rides out on the outcome, in the shape `sourceInvalidationOf`
 * returns. What it is NOT is a second way to decide: `stateDiscarded` still says
 * what the verbs DID, and today they still discard exactly as they did before.
 */
describe('the invalidation verdict a reconfigure publishes', () => {
	it('reports both halves valid when the source did not move', async () => {
		const indexer = new IndexerGeneration<Abi, void>(
			makeProvider(),
			makeProcessor('v1'),
			SOURCE,
			{},
			{processorIdentity: identityOf('v1')},
		);
		await indexer.load();

		// a DIFFERENT object carrying the same contents, which is what a redeploy
		// behind a proxy hands over when the ABI did not move
		const same: IndexingSource<Abi> = {
			chainId: '1',
			contracts: [{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0}],
		};
		const outcome = await indexer.updateIndexer({source: same});

		expect(outcome.sourceInvalidation).toEqual({state: {valid: true}, stream: {valid: true}});
	});

	it('names the BLOCK and the REASON, which is what one bit could not say', async () => {
		const indexer = new IndexerGeneration<Abi, void>(
			makeProvider(),
			makeProcessor('v1'),
			SOURCE,
			{},
			{processorIdentity: identityOf('v1')},
		);
		await indexer.load();

		// a stream CONFIG change is the both-halves case: it is hashed into the wire
		// identity and describes how logs were fetched as much as what they meant
		const outcome = await indexer.updateIndexer({streamConfig: {finality: 42}});

		expect(outcome.sourceInvalidation).toEqual({
			state: {valid: false, invalidFromBlock: 0, reason: 'stream-config'},
			stream: {valid: false, invalidFromBlock: 0, reason: 'stream-config'},
		});
		// and the verb still did what it always did with that verdict
		expect(outcome.stateDiscarded).toBe(true);
	});

	it('carries no source verdict from the two verbs that ask no source question', async () => {
		const indexer = new IndexerGeneration<Abi, void>(
			makeProvider(),
			makeProcessor('v1'),
			SOURCE,
			{},
			{processorIdentity: identityOf('v1')},
		);
		await indexer.load();

		// A processor swap moves neither the fetch filter nor the decoding shape, and
		// `reset` is a discard by fiat that also CLEARS the stream. Reporting "both
		// halves valid" for either would be answering a question nobody asked, and for
		// `reset` it would read as "the stream stands" about a stream it just deleted.
		expect(
			(await indexer.updateProcessor(makeProcessor('v2'), {processorIdentity: identityOf('v2')})).sourceInvalidation,
		).toBeUndefined();
		expect((await indexer.reset()).sourceInvalidation).toBeUndefined();
	});
});
