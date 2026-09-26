import {describe, expect, it} from 'vitest';
import type {IndexingSource} from '../src/index.js';
import type {GenerationFolding, ReceivingIndexer} from '../src/receivingContainer.js';
import {identityOf} from './utils/processorIdentity.js';
import {
	abi,
	AT_101,
	batch,
	SOURCE,
	START_BLOCK,
	world,
	type MemoryStore,
	type TestABI,
	type World,
} from './utils/receivingWorld.js';

// ---------------------------------------------------------------------------------------------------
// A SUCCESSOR ON A NEW STREAM IS FETCHED, at the container seam (ADR-0087's amendment of 2026-09-26)
// ---------------------------------------------------------------------------------------------------
// What a host fetches is the container's answer (`fetchedStreams`): one entry per stream a
// registered generation it holds folds, each with its ONE writer. So the claims made here
// are about which streams are in that answer as the SLOTS move: a successor on a new
// stream joins it beside the incumbent's, a promotion onto it takes the incumbent's out,
// a replaced successor takes its own out, and a pending successor on a new stream is held
// from `open`. What a real `run` does with that answer -- one fetcher per stream, over a
// chain that counts what it is asked -- is
// `packages/cli/test/aSuccessorOnANewStreamIsFetchedByItsOwnWriter.test.ts`.
// ---------------------------------------------------------------------------------------------------

type Container = ReceivingIndexer<TestABI, string[], MemoryStore>;

/** ANOTHER CONTRACT, so another fetch filter and therefore another stream. */
const OTHER_SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: '0x0000000000000000000000000000000000000098', startBlock: START_BLOCK}],
};

/** A host's seam that names the source each stored generation carries, as a Node deployment's does. */
function instantiatingWith(w: World, sources: Map<string, IndexingSource<TestABI>>) {
	return async (id: {stream: string; processor: string}, bundle: Uint8Array) => ({
		...(await w.instantiateFromBundle(id, bundle)),
		source: sources.get(id.stream) ?? SOURCE,
	});
}

async function foldingOf(indexer: Container, marker: string): Promise<GenerationFolding> {
	const one = (await indexer.folding()).find((entry) => entry.generation.processor === identityOf(marker));
	if (!one) throw new Error(`no generation ${marker} is registered`);
	return one;
}

async function fetchedStreamsOf(indexer: Container): Promise<string[]> {
	return (await indexer.fetchedStreams()).map((one) => one.stream);
}

/**
 * An incumbent on `SOURCE`, and a successor on `OTHER_SOURCE` registered beside it, on a host
 * that FETCHES ITS OWN STREAMS (`fetchesItsOwnStreams`, as the CLI's `run` and `build` are)
 * unless told it is PUSH-FED (the split `index`, the server's receiving hosts).
 */
async function aSuccessorOnANewStream(host: 'fetching' | 'push-fed' = 'fetching') {
	const w = world();
	const incumbent = await w.open('v1', 1, {
		instantiateGeneration: w.instantiateFromBundle,
		...(host === 'fetching' ? {fetchesItsOwnStreams: true} : {}),
	});
	const successor = await incumbent.add({...w.specFor('v2', 1), source: OTHER_SOURCE});
	return {w, indexer: incumbent, oldStream: incumbent.streamDigest, newStream: successor.record.stream};
}

describe('a successor on a NEW stream is fetched beside the incumbent', () => {
	it('names BOTH streams, each once, each with its own writer, and reports the successor HELD', async () => {
		const {indexer, oldStream, newStream} = await aSuccessorOnANewStream();
		expect(newStream).not.toBe(oldStream);

		const fetched = await indexer.fetchedStreams();
		expect(fetched.map((one) => one.stream)).toEqual([oldStream, newStream]);
		expect(fetched.map((one) => one.source)).toEqual([SOURCE, OTHER_SOURCE]);
		// ONE WRITER PER STREAM: two streams, two writers, and the wire resolves to exactly them
		expect(new Set(fetched.map((one) => one.writer)).size).toBe(2);
		expect(fetched.map((one) => one.writer.streamDigest)).toEqual([oldStream, newStream]);
		expect(await indexer.liveIngestions()).toEqual(fetched.map((one) => one.writer));
		expect(await foldingOf(indexer, 'v2')).toMatchObject({folding: 'held'});
	});

	it('takes the incumbent’s stream OUT at a promotion onto the new one, and a revert across it freezes', async () => {
		const {indexer, newStream} = await aSuccessorOnANewStream();
		const incumbent = indexer.generation;

		await indexer.promote({stream: newStream, processor: identityOf('v2')});

		expect(await fetchedStreamsOf(indexer)).toEqual([newStream]);
		expect(indexer.held().map((fold) => fold.record.processor)).toEqual([identityOf('v2')]);
		// retained as the way back, and reported as what a move onto it is
		expect((await indexer.slots()).predecessor).toMatchObject(incumbent);
		expect(await foldingOf(indexer, 'v1')).toMatchObject({folding: 'frozen', frozen: {reason: 'stream-not-fetched'}});

		// the revert moves the pointer and FREEZES (ADR-0057): it does not re-fetch the old stream
		await indexer.promote(incumbent);
		expect((await indexer.canonical())?.processor).toBe(identityOf('v1'));
		expect(await fetchedStreamsOf(indexer)).toEqual([newStream]);
	});

	it('on a PUSH-FED receiver, keeps folding the incumbent after that promotion, and its stream still accepts a push', async () => {
		const {indexer, oldStream, newStream} = await aSuccessorOnANewStream('push-fed');

		await indexer.promote({stream: newStream, processor: identityOf('v2')});

		// another process fetches these streams, so nothing here stops: both stay live
		expect(await fetchedStreamsOf(indexer)).toEqual([oldStream, newStream]);
		expect(indexer.held().map((fold) => fold.record.processor)).toEqual([identityOf('v1'), identityOf('v2')]);
		expect(await foldingOf(indexer, 'v1')).toMatchObject({folding: 'held'});
		// ...and a push onto the incumbent's stream still lands in it, and moves it on
		const oldWriter = indexer.ingestion;
		expect(oldWriter.streamDigest).toBe(oldStream);
		expect(await indexer.liveIngestions()).toContain(oldWriter);
		const fromBlock = await oldWriter.expectedFromBlock();
		await oldWriter.receive(batch(indexer, {toBlock: 105, latestBlock: 105, logs: [AT_101]}, fromBlock));
		expect(await oldWriter.expectedFromBlock()).toBeGreaterThan(fromBlock);
	});

	it('takes a REPLACED successor’s stream out with it', async () => {
		const {w, indexer, oldStream} = await aSuccessorOnANewStream();

		await indexer.add(w.specFor('v3', 1));

		expect(await fetchedStreamsOf(indexer)).toEqual([oldStream]);
	});
});

describe('a successor on a new stream still PENDING at a restart is fetched from `open`', () => {
	it('is instantiated on its own stream, held, and fetched beside the incumbent’s', async () => {
		const {w, oldStream, newStream} = await aSuccessorOnANewStream();

		// restarted with NOTHING configured (a `node`, ADR-0094): a start configured with the
		// canonical `v1` would DISCARD the pending `v2` rather than fetch it (ADR-0094's third
		// consequence, `aPendingSuccessorSurvivesARestart.test.ts`)
		const restarted = await w.openWithNothing({
			instantiateGeneration: instantiatingWith(w, new Map([[newStream, OTHER_SOURCE]])),
		});

		expect(restarted.held().map((fold) => fold.record.processor)).toEqual([identityOf('v1'), identityOf('v2')]);
		expect(await fetchedStreamsOf(restarted)).toEqual([oldStream, newStream]);
		expect(await foldingOf(restarted, 'v2')).toMatchObject({folding: 'held'});
	});
});
