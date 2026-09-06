import {describe, expect, it} from 'vitest';
import {UnknownGenerationError} from '../src/generation/registry.js';
import {openReceivingIndexer, type ReceivingIndexer} from '../src/receivingContainer.js';
import type {MemoryStore, TestABI, World} from './utils/receivingWorld.js';
import {
	AT_101,
	AT_106,
	FINALITY,
	REORGED_104,
	SOURCE,
	anIncumbentThatHasFolded,
	batch,
	canonicalAnswers,
	idOf,
	transfer,
	world,
} from './utils/receivingWorld.js';

// ---------------------------------------------------------------------------------------------------
// THE CANONICAL POINTER MOVES BACK, AND THE PREVIOUS GENERATION ANSWERS AS BEFORE
// ---------------------------------------------------------------------------------------------------
// The way BACK, at the container seam: an upgrade that turned out worse is undone
// by ONE SMALL WRITE -- the pointer -- and the old answers come back with NO
// re-index and NO re-fetch.
//
// Almost all of it is true by construction and this file is what PROVES it: a
// retired generation is RETAINED under the caps (never evicted, `GenerationCapReachedError`)
// and its state is its own table NAMESPACE (ADR-0053), so nothing the successor
// did OVERWROTE it. What is NOT free and is asserted here:
//
//  - a REVERT is not a PROMOTION. The container tells them apart by whether the
//    pointer has EVER named the generation being moved to, exactly as the
//    chain-facing one does, and a BACKWARDS move therefore drops NOTHING even
//    under drop-on-promotion -- dropping what it moved away from would delete the
//    very thing a second move forward would want (ADR-0046).
//  - the ARMING is what stops the successor being re-promoted on the next chunk:
//    a reverted-from generation is caught up BY CONSTRUCTION, so "any level
//    non-canonical generation" would undo the revert immediately.
//  - the pointer moves to a generation this container holds NO FOLD for, which is
//    the ORDINARY case after a restart: a host comes back built with the NEW
//    processor alone, and reverting must not require it to build the old one.
//    Reads on this runtime resolve the pointer to a table namespace and need no
//    engine at all (ADR-0053).
//
// The stored stream is asserted BYTE FOR BYTE across the revert, because "no
// re-ingestion" is a claim about what was written and not about a row count.
// The OPERATOR's affordance over this -- the authenticated admin route -- is
// asserted in `packages/server/test/theCanonicalPointerMovesBack.test.ts`.
// ---------------------------------------------------------------------------------------------------

/** Drive the follower to level, which under the default policy is what moves the pointer. */
async function catchUp(indexer: ReceivingIndexer<TestABI, string[], MemoryStore>): Promise<void> {
	for (let guard = 0; guard < 50; guard++) {
		const [report] = await indexer.rebuildMore({maxEmissions: 1});
		if (!report) throw new Error('no follower to advance');
		if (report.complete) return;
	}
	throw new Error('the rebuild never reported itself complete');
}

/** An incumbent that folded the fixture, and a successor promoted over it. */
async function anUpgradeThatLanded(): Promise<{
	world: World;
	incumbent: ReceivingIndexer<TestABI, string[], MemoryStore>;
	/** What the previous generation answered at the instant it was superseded. */
	before: string[];
}> {
	const {world: w, incumbent} = await anIncumbentThatHasFolded();
	const before = await canonicalAnswers(w, incumbent);
	await incumbent.add(w.specFor('v2', 10));
	await catchUp(incumbent);
	expect((await incumbent.canonical())?.processor).toBe('v2');
	return {world: w, incumbent, before};
}

describe('moving the pointer BACK restores the previous generation`s own answers', () => {
	it('answers from its own state, with nothing the successor wrote in it', async () => {
		const {world: w, incumbent, before} = await anUpgradeThatLanded();
		// the successor's fold is a DIFFERENT answer over the same logs, so "the old
		// answers came back" is a real claim rather than two identical lists
		expect(await canonicalAnswers(w, incumbent)).not.toEqual(before);

		await incumbent.promote({stream: incumbent.streamDigest, processor: 'v1'});

		expect((await incumbent.canonical())?.processor).toBe('v1');
		// byte for byte what it answered before the promotion: nothing was folded into
		// it in between, and nothing the successor wrote could reach it -- its state is
		// its own namespace (ADR-0053)
		expect(await canonicalAnswers(w, incumbent)).toEqual(before);
		expect(await canonicalAnswers(w, incumbent)).toEqual([
			`${idOf(AT_101)}x1`,
			`${idOf(REORGED_104)}x1`,
			`${idOf(AT_106)}x1`,
		]);
	});

	it('makes ZERO chain calls and appends NOTHING to the stored stream', async () => {
		const {world: w, incumbent} = await anUpgradeThatLanded();
		const stream = w.stream.snapshot();
		const folds = [...w.stores.entries()].map(([namespace, store]) => [namespace, [...store.rows]] as const);

		await incumbent.promote({stream: incumbent.streamDigest, processor: 'v1'});

		// the stream is what every generation re-folds, so a single row appended here
		// would be a second history rather than an operational blemish
		expect(w.stream.snapshot()).toBe(stream);
		// and NOTHING was folded either: the revert is a POINTER write, so no fold ran,
		// which is what makes ZERO chain calls the honest claim rather than "fewer".
		// The chain is unreachable here by construction anyway -- this container is the
		// chain-free one and takes no provider at all, which is why it exists.
		expect([...w.stores.entries()].map(([namespace, store]) => [namespace, [...store.rows]] as const)).toEqual(folds);
	});

	it('holds the pointer where the operator put it: the successor is not re-promoted', async () => {
		const {world: w, incumbent} = await anUpgradeThatLanded();

		await incumbent.promote({stream: incumbent.streamDigest, processor: 'v1'});
		// the successor is level BY CONSTRUCTION -- it was promoted for reaching the
		// incumbent's cursor -- so an unarmed trigger would put the pointer straight
		// back on the next chunk (ADR-0046)
		await incumbent.rebuildMore();
		await incumbent.rebuildMore();

		// and it survives the stream MOVING under it, which is the case a container
		// that re-armed on activity would fail
		const LATER = transfer(112, '0xa112', 5n);
		const fromBlock = await incumbent.ingestion.expectedFromBlock();
		await incumbent.ingestion.receive(batch(incumbent, {toBlock: 115, latestBlock: 115, logs: [LATER]}, fromBlock));
		await incumbent.rebuildMore();

		expect((await incumbent.canonical())?.processor).toBe('v1');
		// the reverted-TO generation kept folding, so what it answers is CURRENT and
		// not a snapshot of the promotion instant
		expect(await canonicalAnswers(w, incumbent)).toContain(`${idOf(LATER)}x1`);
	});
});

describe('the generation reverted FROM stays available, so a second move forward is free', () => {
	it('is still registered, still holds its own state, and can be promoted again', async () => {
		const {world: w, incumbent} = await anUpgradeThatLanded();
		const successorAnswers = await canonicalAnswers(w, incumbent);

		await incumbent.promote({stream: incumbent.streamDigest, processor: 'v1'});

		expect((await incumbent.generations()).map((record) => record.processor)).toEqual(['v1', 'v2']);
		// its rows were not touched by the move: a revert is a POINTER write
		expect(w.rowsIn('v2', incumbent.streamDigest)).toEqual(successorAnswers);

		// forward again, and it costs the same one write
		await incumbent.promote({stream: incumbent.streamDigest, processor: 'v2'});
		expect((await incumbent.canonical())?.processor).toBe('v2');
		expect(await canonicalAnswers(w, incumbent)).toEqual(successorAnswers);
	});

	it('is NOT dropped by a backwards move, even under drop-on-promotion', async () => {
		const w = world();
		const incumbent = await openReceivingIndexer<TestABI, string[], MemoryStore>({
			port: w.port,
			source: SOURCE,
			stream: {finality: FINALITY},
			appendEmissions: (write) => w.stream.append(write),
			replay: w.stream.source(),
			// the deployment that would rather bound its storage than keep a way back
			promotion: {dropOnPromotion: true},
			generation: w.specFor('v1', 1),
		});
		const fromBlock = await incumbent.ingestion.expectedFromBlock();
		await incumbent.ingestion.receive(batch(incumbent, {toBlock: 105, latestBlock: 105, logs: [AT_101]}, fromBlock));
		await incumbent.add(w.specFor('v2', 10));
		await catchUp(incumbent);
		// the forward move kept BOTH: dropping the superseded one would have stranded
		// the promoted follower, which writes nothing (ADR-0046)
		expect((await incumbent.generations()).map((record) => record.processor)).toEqual(['v1', 'v2']);
		const successorAnswers = await canonicalAnswers(w, incumbent);

		await incumbent.promote({stream: incumbent.streamDigest, processor: 'v1'});

		// A BACKWARDS MOVE DROPS NOTHING. Dropping what the pointer moved away from
		// would delete the very generation a second move forward wants, and would make
		// a revert an unrecoverable operation under a flag about storage.
		expect((await incumbent.generations()).map((record) => record.processor)).toEqual(['v1', 'v2']);
		expect(w.rowsIn('v2', incumbent.streamDigest)).toEqual(successorAnswers);
		await incumbent.promote({stream: incumbent.streamDigest, processor: 'v2'});
		expect(await canonicalAnswers(w, incumbent)).toEqual(successorAnswers);
	});
});

describe('the pointer moves to a generation this container holds no FOLD for', () => {
	it('reverts from a host restarted with the NEW processor alone', async () => {
		const {world: w, incumbent, before} = await anUpgradeThatLanded();

		// the ordinary upgrade, one deploy later: the host is built with the new fold
		// and nothing else. The old generation is in the durable registry, its state is
		// in its own namespace, and NOTHING here can build its processor.
		const restarted = await w.open('v2', 10);
		expect(restarted.held().map((fold) => fold.record.processor)).toEqual(['v2']);
		expect((await restarted.canonical())?.processor).toBe('v2');

		await restarted.promote({stream: incumbent.streamDigest, processor: 'v1'});

		// reads answer from a table NAMESPACE the pointer names, with no engine at all
		expect((await restarted.canonical())?.processor).toBe('v1');
		expect(await canonicalAnswers(w, restarted)).toEqual(before);
	});

	it('REFUSES a generation this indexer does not hold, naming it', async () => {
		const {incumbent} = await anUpgradeThatLanded();

		const refused = incumbent.promote({stream: incumbent.streamDigest, processor: 'v3-never-registered'});

		// the registry's own refusal, because the registry is what holds the answer:
		// a wrong name is worth getting back rather than a silent success
		await expect(refused).rejects.toBeInstanceOf(UnknownGenerationError);
		await expect(refused).rejects.toThrow(/v3-never-registered/);
		expect((await incumbent.canonical())?.processor).toBe('v2');
	});
});
