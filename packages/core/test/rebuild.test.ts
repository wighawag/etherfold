import {describe, expect, it} from 'vitest';
import {DEFAULT_MAX_EMISSIONS_PER_CHUNK, retryCanAdvance, type RebuildReport} from '../src/generation/rebuild.js';
import {openReceivingIndexer} from '../src/receivingContainer.js';
import type {MemoryStore, TestABI} from './utils/receivingWorld.js';
import {
	AT_101,
	AT_106,
	DEAD_104,
	FINALITY,
	REORGED_104,
	SOURCE,
	START_BLOCK,
	anIncumbentThatHasFolded,
	batch,
	canonicalAnswers,
	idOf,
	transfer,
	world,
} from './utils/receivingWorld.js';

// ---------------------------------------------------------------------------------------------------
// THE REBUILD REPLAYS THE LOCAL STREAM IN BOUNDED CHUNKS, AND THE POINTER MOVES AT THE END
// ---------------------------------------------------------------------------------------------------
// A processor upgrade is a new GENERATION over the SAME stream, so the successor
// is a **follower** (ADR-0044): it fetches NOTHING and re-folds what is already
// stored. This file asserts the CONTRACT of that catch-up over the reference
// substrate -- the driver's per-call report, the state after promotion, and that
// nothing reaches a chain or a stream writer.
//
// The three seams under test, deliberately separate:
//
//  - the DRIVER's per-call report: bounded work, and `complete` as the thing a
//    scheduler acts on, exactly as `prune` and `compactEmissionPairs` report
//    (ADR-0022);
//  - RESUMABILITY, asserted by driving chunk after chunk through a FRESH
//    container -- a new object graph over the same substrate, never a loop in one
//    closure -- including a kill between two chunks;
//  - the POINTER, which moves ONCE, at the end, with the retired generation
//    RETAINED and still answering.
//
// The WORLD these run in -- the stored stream with its coverage claim, the
// registry substrate, a state store per generation namespace -- is
// `test/utils/receivingWorld.ts`, shared with the suite that asserts the way
// BACK (`theCanonicalPointerMovesBack.test.ts`). What the SQL substrate adds is
// asserted in `packages/server/test/rebuildInBoundedChunks.test.ts`.
// ---------------------------------------------------------------------------------------------------

describe('a successor on a SHARED stream is a FOLLOWER, determined and never configured', () => {
	it('gets a rebuild over the stored stream and NO receiver, because a stream is one address', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();

		const successor = await incumbent.add(w.specFor('v2', 10));

		expect(successor.follows).toBe(true);
		expect(successor.ingestion).toBeUndefined();
		expect(successor.rebuild).toBeDefined();
		// and it is not the writer: ADR-0052's one-writer rule, so it stores nothing
		expect(successor.writesStream).toBe(false);
		expect(incumbent.writesStream).toBe(true);
		// one live wire context, still: the follower has no address of its own
		expect((await incumbent.liveIngestions()).map((live) => live.streamDigest)).toEqual([incumbent.streamDigest]);
	});

	it('replays `_emissions` alone: no chain, and not one write to the stream', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const before = w.stream.snapshot();

		await incumbent.add(w.specFor('v2', 10));
		let report = await incumbent.rebuildMore();
		while (!report[0]?.complete) {
			report = await incumbent.rebuildMore();
		}

		// The chain is unreachable by construction: this container holds no provider
		// at all and the rebuild's decoder is built over one that throws on every call
		// (asserted below). What is asserted here is the other half -- the stored stream
		// is untouched, byte for byte, so nothing was appended a second time.
		expect(w.stream.snapshot()).toBe(before);
	});

	it('holds a provider that REFUSES, so a reach for the chain is loud and not a quiet re-index', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const successor = await incumbent.add(w.specFor('v2', 10));

		// The decoder is the only thing in a rebuild that is built out of a chain-facing
		// class, and this is what it holds instead of a node. ZERO calls is asserted by
		// construction rather than by counting: there is nothing to count against,
		// because a single call throws.
		const provider = (
			successor.rebuild as unknown as {
				decoder: {provider: {request(args: {method: string}): Promise<never>}};
			}
		).decoder.provider;
		await expect(provider.request({method: 'eth_getLogs'})).rejects.toThrow(/must never reach the chain/);
	});
});

/**
 * THE REORG COUNTERS ARE THE CHAIN'S RECORD, NOT EVERY FOLD'S.
 *
 * `recordReorg` writes counters that are per NAMED INDEXER and shared across its
 * generations (ADR-0050), while the emission append has a one-writer rule that
 * bounds it to a single generation (ADR-0052). Those two facts together are why
 * this needs pinning: a successor re-folding a stream that CONTAINS retractions
 * replays every one of them, and if that path could reach the recorder it would
 * add reverts on top of the ones the incumbent already counted -- `/status` would
 * report a contradiction rate no chain activity produced.
 *
 * It cannot, and the reason is structural rather than a guard: a successor on a
 * shared stream is a FOLLOWER, a follower is advanced by `GenerationRebuild`, and
 * the rebuild is a replay that concludes no reorgs of its own -- it honours the
 * verdicts the stream already carries (ADR-0042). Only a RECEIVER concludes a
 * reorg, and only the wire feeds a receiver.
 */
describe('a re-folding successor does not re-count the reverts the stream carries', () => {
	it('leaves the shared counters exactly where the incumbent left them', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		// the fixture holds ONE contradiction: 104 came back with a different hash
		expect(w.reorgs).toEqual([{blockNumber: 104}]);

		const successor = await incumbent.add(w.specFor('v2', 10));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}

		// the successor really did replay the retraction -- it is on the live branch, not
		// the dead one -- so this is not passing because nothing was re-folded
		expect(await canonicalAnswers(w, incumbent)).toEqual([
			`${idOf(AT_101)}x10`,
			`${idOf(REORGED_104)}x10`,
			`${idOf(AT_106)}x10`,
		]);
		expect(successor.record.processor).toBe('v2');
		// ...and the count is still ONE. The chain contradicted itself once.
		expect(w.reorgs).toEqual([{blockNumber: 104}]);
	});
});

describe('the rebuild proceeds in bounded chunks and REPORTS whether it finished', () => {
	it('does bounded work per call and says `complete` only when the stream is folded', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));

		const reports = [];
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			if (!report) throw new Error('no follower to advance');
			reports.push(report);
			done = report.complete;
		}

		// more than one call, and every one of them bounded: the fixture holds five
		// emissions and a budget of one cannot swallow them in a single chunk
		expect(reports.length).toBeGreaterThan(1);
		expect(reports.slice(0, -1).every((report) => report.complete === false)).toBe(true);
		// the report is what a scheduler acts on, and it names the position it reached
		expect(reports[0]).toMatchObject({fromBlock: START_BLOCK, stopped: {reason: 'budget'}});
		expect(reports[reports.length - 1]).toMatchObject({complete: true, toBlock: 110});
		// and it reports the stream-space size it is folding against
		expect(reports[reports.length - 1]?.highWater).toBe(w.stream.rows.length);
	});

	it('spends a budget that lands INSIDE one block on the whole block, never on half of it', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));

		const scans: number[] = [];
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			if (!report) throw new Error('no follower to advance');
			scans.push(report.scanned);
			done = report.complete;
		}

		// block 104 carries three emissions (an application, its retraction and the
		// replacement) and a budget of one still reads all three: a chunk that ended
		// mid-block would leave rows below its own resume point, and the next chunk
		// resumes above them
		expect(Math.max(...scans)).toBeGreaterThan(1);
	});

	it('says DOES-NOT-REACH-BACK, and says a retry cannot fix it, for a stream that opens too high', async () => {
		// The defect ADR-0070 removes, and the case that would have caught it. A SEEDED
		// stream opens at the capture's `fromBlock` rather than at the source's first
		// block, so a follower resuming from a fresh checkpoint asks from lower than the
		// stream reaches -- on this call and on every call after it, because the resume
		// point comes from its own durable checkpoint.
		//
		// Collapsed into `absent` (as it was), a host could only keep polling: it would
		// burn a scheduled invocation per follower for ever, and `origin.level` would
		// stay false so the follower could never inherit a vacant write duty. A silent,
		// permanent stall reported as an ordinary "not finished yet".
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		w.stream.opensAt(START_BLOCK + 50);
		await incumbent.add(w.specFor('v2', 10));

		const reports = await incumbent.rebuildMore();
		const follower = reports.find((report) => report.generation.processor !== incumbent.generation.processor);

		expect(follower?.stopped).toEqual({reason: 'does-not-reach-back', startBlock: START_BLOCK + 50});
		// the half that matters to a scheduler: this is NOT the transient one
		expect(retryCanAdvance((follower as RebuildReport).stopped)).toBe(false);
		expect(follower?.complete).toBe(false);
		// and calling again reports exactly the same thing rather than progressing
		const again = await incumbent.rebuildMore();
		expect(again.find((r) => r.generation.processor !== incumbent.generation.processor)?.stopped).toEqual(
			follower?.stopped,
		);
	});

	it('refuses a budget of zero rather than reading it as "do nothing"', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));

		await expect(incumbent.rebuildMore({maxEmissions: 0})).rejects.toThrow(/invalid rebuild budget/);
		expect(DEFAULT_MAX_EMISSIONS_PER_CHUNK).toBeGreaterThan(0);
	});

	it('reports NOTHING-STORED rather than completing, where there is no stored stream to fold', async () => {
		const w = world();
		// nothing has ever been folded, so nothing has been stored
		const incumbent = await w.open('v1', 1);
		await incumbent.add(w.specFor('v2', 10));

		const [report] = await incumbent.rebuildMore();
		expect(report).toMatchObject({stopped: {reason: 'nothing-stored'}, complete: false, scanned: 0});
		// TRANSIENT: the writer simply has not appended yet, so calling again is right.
		// This is the half that must stay distinguishable from `does-not-reach-back`,
		// which recurs for ever (ADR-0070).
		expect(retryCanAdvance((report as RebuildReport).stopped)).toBe(true);
		// and the pointer did not move onto a generation that has folded nothing
		expect(await incumbent.canonical()).toMatchObject(incumbent.generation);
	});
});

describe('resumability, asserted through a FRESH container between every chunk', () => {
	it('lands on the state the original fold produced, over a stream holding a REORG', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const original = [...w.rowsIn('v1', incumbent.streamDigest)];
		// the incumbent took the reorg: the dead 104 is gone and its replacement is in
		expect(original).toEqual([`${idOf(AT_101)}x1`, `${idOf(REORGED_104)}x1`, `${idOf(AT_106)}x1`]);

		// EVERY chunk through a new object graph: a new container, a new receiver, a
		// new rebuild driver, over the same durable rows. Nothing carries from one
		// call to the next but what the store committed.
		let done = false;
		let chunks = 0;
		while (!done) {
			const fresh = await w.open('v1', 1);
			await fresh.add(w.specFor('v2', 10));
			const [report] = await fresh.rebuildMore({maxEmissions: 1});
			if (!report) throw new Error('no follower to advance');
			chunks++;
			done = report.complete;
			expect(chunks).toBeLessThan(20);
		}

		// compare STATE, not row counts: the successor folded the same history and the
		// same reorg, and its own fold applied to it
		const rebuilt = w.rowsIn('v2', incumbent.streamDigest);
		expect(rebuilt).toEqual([`${idOf(AT_101)}x10`, `${idOf(REORGED_104)}x10`, `${idOf(AT_106)}x10`]);
		expect(rebuilt).not.toContain(`${idOf(DEAD_104)}x10`);
	});

	it('resumes from the checkpoint after a KILL between two chunks, applying nothing twice', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));

		// two chunks, then the process is gone
		await incumbent.rebuildMore({maxEmissions: 1});
		await incumbent.rebuildMore({maxEmissions: 1});
		const killedAt = [...w.rowsIn('v2', incumbent.streamDigest)];
		expect(killedAt.length).toBeGreaterThan(0);

		// a new process comes up against the same substrate and finishes the job
		let done = false;
		while (!done) {
			const revived = await w.open('v1', 1);
			await revived.add(w.specFor('v2', 10));
			const [report] = await revived.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}

		// nothing applied twice and nothing skipped: the rebuilt state is exactly the
		// one an uninterrupted rebuild produces
		expect(w.rowsIn('v2', incumbent.streamDigest)).toEqual([
			`${idOf(AT_101)}x10`,
			`${idOf(REORGED_104)}x10`,
			`${idOf(AT_106)}x10`,
		]);
		// and it did resume rather than start again: the killed-at prefix survived
		expect(w.rowsIn('v2', incumbent.streamDigest).slice(0, killedAt.length)).toEqual(killedAt);
	});

	it('does nothing on a further call once level, and stays complete', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}
		const level = [...w.rowsIn('v2', incumbent.streamDigest)];

		const [again] = await incumbent.rebuildMore();

		expect(again).toMatchObject({complete: true, replayed: 0});
		expect(w.rowsIn('v2', incumbent.streamDigest)).toEqual(level);
	});
});

describe('the canonical generation is served throughout, and the pointer moves ONCE at the end', () => {
	it('answers from the incumbent for the whole rebuild and switches only at the move', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const incumbentAnswers = await canonicalAnswers(w, incumbent);
		await incumbent.add(w.specFor('v2', 10));

		const answersDuring: string[][] = [];
		const pointers: string[] = [];
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			if (!report) throw new Error('no follower to advance');
			done = report.complete;
			if (!done) {
				answersDuring.push(await canonicalAnswers(w, incumbent));
				pointers.push((await incumbent.canonical())?.processor as string);
			}
		}

		// nobody ever observed partial state: every read during the rebuild answered
		// exactly what the incumbent answered before it started
		expect(answersDuring.length).toBeGreaterThan(0);
		for (const answer of answersDuring) {
			expect(answer).toEqual(incumbentAnswers);
		}
		expect(new Set(pointers)).toEqual(new Set(['v1']));

		// and at the end the pointer names the successor
		expect((await incumbent.canonical())?.processor).toBe('v2');
		expect(await canonicalAnswers(w, incumbent)).toEqual([
			`${idOf(AT_101)}x10`,
			`${idOf(REORGED_104)}x10`,
			`${idOf(AT_106)}x10`,
		]);
	});

	it('RETAINS the retired generation, which still holds its own state and can still answer', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const before = await canonicalAnswers(w, incumbent);
		await incumbent.add(w.specFor('v2', 10));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}

		// still registered, with its own rows untouched -- which is what makes moving
		// the pointer BACK a revert rather than a re-index
		expect((await incumbent.generations()).map((record) => record.processor)).toEqual(['v1', 'v2']);
		expect(w.rowsIn('v1', incumbent.streamDigest)).toEqual(before);

		// and moving the pointer back restores the answers EXACTLY, with no re-fold
		await incumbent.promote({stream: incumbent.streamDigest, processor: 'v1'});
		expect(await canonicalAnswers(w, incumbent)).toEqual(before);
	});

	it('does not move the pointer again on the chunk after a REVERT', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}
		await incumbent.promote({stream: incumbent.streamDigest, processor: 'v1'});

		// the successor is caught up by construction, so "any level non-canonical
		// generation is promotable" would put the pointer straight back (ADR-0046)
		await incumbent.rebuildMore();
		await incumbent.rebuildMore();

		expect((await incumbent.canonical())?.processor).toBe('v1');
	});

	it('keeps the WRITER and the retired generation FOLDING after the move (open question 2)', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}
		expect((await incumbent.canonical())?.processor).toBe('v2');

		// the append duty did NOT move with the pointer: the writer is the oldest
		// surviving generation on the stream, registration order and never the pointer
		expect((await incumbent.registry.writerOf(incumbent.streamDigest))?.processor).toBe('v1');
		expect(incumbent.writesStream).toBe(true);
		// so the retired generation is still the one being fed...
		expect((await incumbent.liveIngestions()).map((live) => live.streamDigest)).toEqual([incumbent.streamDigest]);

		const LATER = transfer(112, '0xa112', 5n);
		const fromBlock = await incumbent.ingestion.expectedFromBlock();
		await incumbent.ingestion.receive(batch(incumbent, {toBlock: 115, latestBlock: 115, logs: [LATER]}, fromBlock));

		// ...and it KEEPS FOLDING: a frozen retired generation would answer stale data
		// the instant the pointer was moved back to it
		expect(w.rowsIn('v1', incumbent.streamDigest)).toContain(`${idOf(LATER)}x1`);
		// and the promoted successor keeps FOLLOWING the same stream
		await incumbent.rebuildMore();
		expect(w.rowsIn('v2', incumbent.streamDigest)).toContain(`${idOf(LATER)}x10`);
	});
});

describe('the promotion policy is applied here and re-decided nowhere', () => {
	it('defaults to `on-catch-up` with nothing dropped, as in every runtime', async () => {
		const {incumbent} = await anIncumbentThatHasFolded();
		expect(incumbent.promotion).toEqual({policy: 'on-catch-up', dropOnPromotion: false});
	});

	it('under `manual` the pointer moves only when asked', async () => {
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
		const fromBlock = await incumbent.ingestion.expectedFromBlock();
		await incumbent.ingestion.receive(batch(incumbent, {toBlock: 105, latestBlock: 105, logs: [AT_101]}, fromBlock));

		await incumbent.add(w.specFor('v2', 10));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}

		// caught up, and still not canonical: `manual` means an operator inspects first
		expect((await incumbent.canonical())?.processor).toBe('v1');
		await incumbent.promote({stream: incumbent.streamDigest, processor: 'v2'});
		expect((await incumbent.canonical())?.processor).toBe('v2');
	});

	it('REFUSES `immediate` with drop-on-promotion rather than dropping a state that proved nothing', async () => {
		const w = world();
		await expect(
			openReceivingIndexer<TestABI, string[], MemoryStore>({
				port: w.port,
				source: SOURCE,
				stream: {finality: FINALITY},
				replay: w.stream.source(),
				promotion: {policy: 'immediate', dropOnPromotion: true},
				generation: w.specFor('v1', 1),
			}),
		).rejects.toThrow(/'immediate' with dropOnPromotion is not available/);
	});

	it('DECLINES a drop that would leave a follower folding a stream nothing appends to', async () => {
		const w = world();
		const incumbent = await openReceivingIndexer<TestABI, string[], MemoryStore>({
			port: w.port,
			source: SOURCE,
			stream: {finality: FINALITY},
			appendEmissions: (write) => w.stream.append(write),
			replay: w.stream.source(),
			promotion: {dropOnPromotion: true},
			generation: w.specFor('v1', 1),
		});
		const fromBlock = await incumbent.ingestion.expectedFromBlock();
		await incumbent.ingestion.receive(batch(incumbent, {toBlock: 105, latestBlock: 105, logs: [AT_101]}, fromBlock));

		await incumbent.add(w.specFor('v2', 10));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}

		// the superseded generation WRITES the stream the promoted one follows, so
		// dropping it would leave the app simply not advancing (ADR-0046)
		expect((await incumbent.canonical())?.processor).toBe('v2');
		expect((await incumbent.generations()).map((record) => record.processor)).toEqual(['v1', 'v2']);
	});
});
