import {describe, expect, it} from 'vitest';
import {generationDigestOf} from '../src/generation/identity.js';
import {openReceivingIndexer, type ReceivingIndexer} from '../src/receivingContainer.js';
import type {StateApplied, StateMoved} from '../src/stateMoved.js';
import type {LogEvent} from '../src/types.js';
import {
	AT_101,
	AT_106,
	DEAD_104,
	FINALITY,
	REORGED_104,
	REPORTED_ENTITY,
	SOURCE,
	batch,
	transfer,
	world,
	type MemoryStore,
	type TestABI,
	type World,
} from './utils/receivingWorld.js';
import {identityOf} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------------------------------
// THE RECEIVING CONTAINER PUBLISHES WHAT IT APPLIED
// ---------------------------------------------------------------------------------------------------
// There are TWO things in this system that apply blocks, and the one asserted in
// `theFoldPublishesWhatItJustChanged.test.ts` is the CHAIN-FACING one, which a
// browser runs. Every server and CLI deployment folds through THIS container
// instead -- `ReceivingIndexer`, chain-free, fed wire batches by a fetcher
// elsewhere -- and it published nothing at all before ADR-0083 said both must.
//
// So these cases ask the receiving container the questions the chain-facing file
// asks its twin, and the answer that matters is that it is the SAME answer from
// the SAME assembly (`StateMovedPublisher`) rather than a second implementation:
// only the CANONICAL fold publishes, a retraction rotates the token as it
// publishes, and a POINTER MOVE rotates it and publishes nothing.
//
// The ENTITY NAMES are the layer below's and are asserted against a real
// processor over the real workload, on this container, in
// `@etherfold/conformance-workload-stratagems`'s
// `theReceivingContainerPublishesWhatItApplied.test.ts`. The folds here report a
// name of their own (`REPORTED_ENTITY`), because what a container does with the
// set is relay it.
//
// The world -- the durable registry substrate, the stored stream with its REORG
// and its quiet range, and a store per generation namespace -- is
// `utils/receivingWorld.ts`, shared with the rebuild and the way-back cases so
// that what a reorg MEANS here has one definition.
// ---------------------------------------------------------------------------------------------------

/** The notifications as APPENDS, REFUSING one that is not. Same helper, same reasoning, as the twin's. */
function appendsIn(moved: readonly StateMoved[]): StateApplied[] {
	return moved.map((notification) => {
		if (notification.kind !== 'applied') {
			throw new Error(`expected an applied-block notification, got '${notification.kind}'`);
		}
		return notification;
	});
}

/** ONE PUSH, as a fetcher makes one: the receiver says where the range starts. */
function pushTo(indexer: ReceivingIndexer<TestABI, string[], MemoryStore>) {
	return async (over: {toBlock: number; latestBlock: number; logs: LogEvent<TestABI>[]}) => {
		const fromBlock = await indexer.ingestion.expectedFromBlock();
		await indexer.ingestion.receive(batch(indexer, over, fromBlock));
	};
}

/**
 * A container with a subscriber attached BEFORE anything folds, and the fixture's
 * three batches still to come.
 *
 * Deliberately not `anIncumbentThatHasFolded`, which folds before it hands the
 * container over: a subscriber that attached afterwards would be told nothing,
 * because this is a SIGNAL and there is nothing held to replay to it.
 */
async function aContainerBeingFed(): Promise<{
	w: World;
	incumbent: ReceivingIndexer<TestABI, string[], MemoryStore>;
	moved: StateMoved[];
	push: ReturnType<typeof pushTo>;
	/** The rendered generation a fold built from `bundleBytes(marker)` publishes under. */
	digestOf: (marker: string) => string;
}> {
	const w = world();
	const incumbent = await w.open('v1', 1);
	const moved: StateMoved[] = [];
	incumbent.onStateMoved((notification) => moved.push(notification));
	return {
		w,
		incumbent,
		moved,
		push: pushTo(incumbent),
		digestOf: (marker: string) => generationDigestOf({stream: incumbent.streamDigest, processor: identityOf(marker)}),
	};
}

/** Drive the follower to level, which under the default policy is what moves the pointer. */
async function catchUp(indexer: ReceivingIndexer<TestABI, string[], MemoryStore>): Promise<void> {
	for (let guard = 0; guard < 50; guard++) {
		const [report] = await indexer.rebuildMore({maxEmissions: 1});
		if (!report) throw new Error('no follower to advance');
		if (report.complete) return;
	}
	throw new Error('the rebuild never reported itself complete');
}

describe('the receiving container publishes what it applied', () => {
	it('publishes ONE notification per applied block, naming the block, the generation and the entities', async () => {
		const {moved, push, digestOf} = await aContainerBeingFed();
		await push({toBlock: 105, latestBlock: 105, logs: [AT_101, DEAD_104]});

		const appends = appendsIn(moved);
		expect(appends.map((notification) => notification.block)).toEqual([101, 104]);
		expect(appends.every((notification) => notification.generation === digestOf('v1'))).toBe(true);
		expect(appends.every((notification) => notification.entities)).toBeTruthy();
		expect(appends[0].entities).toEqual([REPORTED_ENTITY]);
	});

	it('carries ONE unchanged token while nothing invalidates, and NONE for a range that applied nothing', async () => {
		const {moved, push} = await aContainerBeingFed();
		await push({toBlock: 105, latestBlock: 105, logs: [AT_101, DEAD_104]});
		const afterTheHistory = moved.length;
		expect(afterTheHistory).toBeGreaterThan(1);
		expect(new Set(moved.map((notification) => notification.coherence)).size).toBe(1);

		// the QUIET range: the unconfirmed window is re-delivered unchanged and nothing
		// new arrives, so the cursor moves and the coverage claim moves and NO block was
		// applied -- there is no block to name, and nothing is published
		await push({toBlock: 120, latestBlock: 120, logs: [DEAD_104]});
		expect(moved.length).toBe(afterTheHistory);
	});

	it('publishes a RETRACTION naming the fork point, with the token ROTATED as it publishes', async () => {
		// The reorg is CAUSED, by the fixture's own second batch: block 104 comes back
		// with a different hash, which is a contradiction the receiver derives. Nothing
		// here hand-builds a retraction.
		const {moved, push} = await aContainerBeingFed();
		await push({toBlock: 105, latestBlock: 105, logs: [AT_101, DEAD_104]});
		const beforeTheReorg = moved.length;
		const tokenBefore = moved[beforeTheReorg - 1].coherence;

		await push({toBlock: 106, latestBlock: 106, logs: [REORGED_104, AT_106]});

		const published = moved.slice(beforeTheReorg);
		expect(published.map((notification) => notification.kind)).toEqual(['retracted', 'applied', 'applied']);
		const retraction = published[0];
		// ONE BELOW the lowest block the delivered stream retracted, which is the number
		// the fold handed `revertTo`
		expect(retraction.kind === 'retracted' && retraction.forkPoint).toBe(103);
		expect(Object.keys(retraction).sort()).toEqual(['coherence', 'forkPoint', 'generation', 'kind']);
		// ROTATED as it published, so a retraction under the old token is unexpressible
		expect(retraction.coherence).not.toBe(tokenBefore);
		// and the appends after it carry exactly that new token, so a reader that
		// RECEIVED it goes back to invalidating narrowly at the next block
		expect(published.every((notification) => notification.coherence === retraction.coherence)).toBe(true);
	});

	it('publishes NOTHING for a FOLLOWER re-folding the stored stream to catch up', async () => {
		// A follower here re-folds a WHOLE stored stream, so a per-block publication
		// would fire one notification per past block while nothing a reader can see has
		// moved. `manual` keeps the pointer where it is, so the follower stays
		// non-canonical for the whole rebuild and the filter is what is under test
		// rather than the promotion.
		const w = world();
		const incumbent = await openReceivingIndexer<TestABI, string[], MemoryStore>({
			port: w.port,
			source: SOURCE,
			stream: {finality: FINALITY},
			appendEmissions: (write) => w.stream.append(write),
			replay: w.stream.source(),
			promotion: {policy: 'manual'},
			generation: w.specFor('v1', 1),
		});
		const moved: StateMoved[] = [];
		incumbent.onStateMoved((notification) => moved.push(notification));
		const push = pushTo(incumbent);
		await push({toBlock: 105, latestBlock: 105, logs: [AT_101, DEAD_104]});
		await push({toBlock: 106, latestBlock: 106, logs: [REORGED_104, AT_106]});
		const publishedBeforeTheFollower = moved.length;
		expect(publishedBeforeTheFollower).toBeGreaterThan(0);

		const tokenBeforeTheFollower = moved[moved.length - 1].coherence;

		await incumbent.add(w.specFor('v2', 10));
		await catchUp(incumbent);

		// the follower DID re-fold the stream -- otherwise this asserts nothing
		expect(w.rowsIn('v2', incumbent.streamDigest).length).toBeGreaterThan(0);
		expect((await incumbent.canonical())?.processor).toBe(identityOf('v1'));
		expect(moved.length).toBe(publishedBeforeTheFollower);

		// ...and the re-fold included the REORG, so the filter covers the TOKEN as well
		// as the notification: the next notification the CANONICAL fold publishes carries
		// exactly the token it was carrying before the rebuild. A rotation there would
		// have every reader throw its cache away because a second generation caught up.
		const LATER = transfer(112, '0xa112', 5n);
		await push({toBlock: 115, latestBlock: 115, logs: [REORGED_104, AT_106, LATER]});
		const after = moved[moved.length - 1];
		expect(appendsIn([after])[0].block).toBe(112);
		expect(after.coherence).toBe(tokenBeforeTheFollower);
	});

	it('ROTATES the token on a POINTER MOVE, publishes nothing for it, and then names the fold that answers', async () => {
		// The same mechanism the retraction uses and deliberately not a second event
		// kind: a different fold answers from here on, which from a cache's point of
		// view is indistinguishable from "everything you hold may be wrong". The move
		// is the one the DEFAULT policy makes on its own, so nobody asked for it.
		const {w, incumbent, moved, push, digestOf} = await aContainerBeingFed();
		await push({toBlock: 105, latestBlock: 105, logs: [AT_101, DEAD_104]});
		await push({toBlock: 106, latestBlock: 106, logs: [REORGED_104, AT_106]});
		const tokensBefore = new Set(moved.map((notification) => notification.coherence));
		expect(appendsIn(moved.filter((n) => n.kind === 'applied')).every((n) => n.generation === digestOf('v1'))).toBe(
			true,
		);
		const publishedBefore = moved.length;

		await incumbent.add(w.specFor('v2', 10));
		await catchUp(incumbent);
		expect((await incumbent.canonical())?.processor).toBe(identityOf('v2'));
		// THE MOVE PUBLISHED NOTHING: a pointer move has no block to name and no fold
		// applied anything, so what a reader receives is the NEXT notification.
		expect(moved.length).toBe(publishedBefore);

		// One more block. It reaches the WRITER of the stream, which is still the
		// oldest surviving generation (ADR-0044) and is no longer the one that answers
		// reads -- so folding it publishes NOTHING...
		const LATER = transfer(112, '0xa112', 5n);
		await push({toBlock: 115, latestBlock: 115, logs: [REORGED_104, AT_106, LATER]});
		expect(moved.length).toBe(publishedBefore);

		// ...and the notification arrives when the fold that DOES answer applies it,
		// carrying a token no reader has seen and naming the generation answering now.
		await incumbent.rebuildMore();
		const after = moved[moved.length - 1];
		expect(moved.length).toBeGreaterThan(publishedBefore);
		expect(appendsIn([after])[0].block).toBe(112);
		expect(after.generation).toBe(digestOf('v2'));
		expect(tokensBefore.has(after.coherence)).toBe(false);
		expect(digestOf('v2')).not.toBe(digestOf('v1'));
	});

	it('rotates NOTHING when the generation named is the one already answering', async () => {
		const {incumbent, moved, push} = await aContainerBeingFed();
		await push({toBlock: 105, latestBlock: 105, logs: [AT_101, DEAD_104]});
		const tokenBefore = moved[moved.length - 1].coherence;

		await incumbent.promote({stream: incumbent.streamDigest, processor: identityOf('v1')});
		await push({toBlock: 106, latestBlock: 106, logs: [REORGED_104, AT_106]});

		// the reorg in that batch rotates it once, and the promotion that moved no
		// pointer rotated nothing: two rotations would be one re-read charged for a
		// lineage change that did not happen
		const retractions = moved.filter((notification) => notification.kind === 'retracted');
		expect(retractions.length).toBe(1);
		expect(new Set(moved.map((notification) => notification.coherence)).size).toBe(2);
		expect(moved[0].coherence).toBe(tokenBefore);
	});

	it('CONTAINS a handler that throws, exactly as the chain-facing container does', async () => {
		const {incumbent, push} = await aContainerBeingFed();
		const seen: number[] = [];
		incumbent.onStateMoved(() => {
			throw new Error('a subscriber blew up');
		});
		incumbent.onStateMoved((notification) => {
			if (notification.kind === 'applied') seen.push(notification.block);
		});

		await push({toBlock: 105, latestBlock: 105, logs: [AT_101, DEAD_104]});

		// the fold ran, and the handler beside the throwing one was told
		expect(seen).toEqual([101, 104]);
	});
});
