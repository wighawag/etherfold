import {describe, expect, it} from 'vitest';
import {
	AT_101,
	AT_106,
	REORGED_104,
	anIncumbentThatHasFolded,
	idOf,
	reportFor,
	transfer,
} from './utils/receivingWorld.js';
import {identityOf} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------------------------------
// THERE IS NO WRITER SUCCESSION, BECAUSE THERE IS NO WRITE DUTY TO SUCCEED TO
// ---------------------------------------------------------------------------------------------------
// RE-SCOPED WHOLE, and the file is kept at its old path because what it asserts
// is the same SITUATION: a generation on a stream goes away while the deployment
// is running. What changed is the answer.
//
// It used to assert a HAND-OVER. The writer of a stream was the oldest surviving
// generation registered on it (`writerOf`), the emission appender was handed to
// whichever fold that ELECTED, and deleting that generation therefore had to move
// the engine to the next oldest -- a follower stopped following, was given a
// receiver and the appender, and a follower that was still CATCHING UP had to be
// made to wait, because a receiver asks from its OWN position and ADR-0052
// appends a re-sent range a second time.
//
// ADR-0087 deletes the whole mechanism, and the measurement is why: there is no
// observation point at which a hand-over is safe. A reconciliation once per fetch
// cycle sees the fold BELOW the coverage and then ABOVE it and never ON it --
// handing over below duplicates the overlap, handing over above leaves a HOLE --
// and the elected writer could be a generation the process holds no fold for at
// all, which is the ordinary restart and the measured data-loss defect.
//
// So the duty came off the generation entirely. The DEPLOYMENT fetches a stream
// and appends to it, positioned from the STREAM's own coverage claim, and every
// generation merely READS it. What this file asserts now is the property that
// replaces succession: **deleting a generation changes nothing about what fetches
// or what appends**, because neither was ever that generation's.
// ---------------------------------------------------------------------------------------------------

/** Drive a batch into the stream's writer, which is what a stream's address resolves to. */
async function feed(
	indexer: Awaited<ReturnType<typeof anIncumbentThatHasFolded>>['incumbent'],
	over: {toBlock: number; latestBlock: number; logs: ReturnType<typeof transfer>[]},
) {
	const [writer] = await indexer.liveIngestions();
	if (!writer) throw new Error('the stream has no writer, so nothing can be fetched into it');
	const fromBlock = await writer.expectedFromBlock();
	return writer.receive({
		context: writer.context,
		fromBlock,
		toBlock: over.toBlock,
		latestBlock: over.latestBlock,
		logs: over.logs.map((event) => ({...event})),
	});
}

/** Advance every fold until nothing is left to re-fold. */
async function rebuildToLevel(indexer: Awaited<ReturnType<typeof anIncumbentThatHasFolded>>['incumbent']) {
	for (let guard = 0; guard < 100; guard++) {
		const reports = await indexer.rebuildMore();
		if (reports.length === 0 || reports.every((report) => report.complete)) return;
	}
	throw new Error('the rebuild never reported complete');
}

describe('deleting a generation on a stream hands over NOTHING, because nothing was held', () => {
	it('leaves the same writer at the same address, and no fold changes shape', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const successor = await incumbent.add(w.specFor('v2', 10));
		await rebuildToLevel(incumbent);
		const writerBefore = incumbent.ingestion;

		// the successor is canonical after catching up, so the incumbent can be deleted
		await incumbent.registry.deleteGeneration(incumbent.opening.record);
		const live = await incumbent.liveIngestions();

		// the SAME writer object: it is the DEPLOYMENT's writer of that stream, and
		// nothing about which generations exist is an input to it
		expect(live).toEqual([writerBefore]);
		expect(live[0]?.streamDigest).toBe(successor.streamDigest);
		// and a fold is still one shape: a rebuild, no receiver, no pen
		expect(successor.rebuild).toBeDefined();
		expect(successor).not.toHaveProperty('ingestion');
		expect(successor).not.toHaveProperty('writesStream');
		expect(successor).not.toHaveProperty('follows');
	});

	it('goes on FETCHING and STORING the stream, which is the stall this removes', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const successor = await incumbent.add(w.specFor('v2', 10));
		await rebuildToLevel(incumbent);
		const storedBefore = (JSON.parse(w.stream.snapshot()).rows as unknown[]).length;

		await incumbent.registry.deleteGeneration(incumbent.opening.record);

		// a batch that arrives AFTER that generation went is still received...
		const LATER = transfer(112, '0xa112', 5n);
		await feed(incumbent, {toBlock: 115, latestBlock: 115, logs: [LATER]});

		// ...APPENDED to the stream, by the deployment and not by any fold...
		expect((JSON.parse(w.stream.snapshot()).rows as unknown[]).length).toBe(storedBefore + 1);
		// ...and folded by the generation that is left, which was LEVEL and so took the
		// delta the writer had just appended
		expect(w.rowsIn('v2', successor.streamDigest)).toContain(`${idOf(LATER)}x10`);
	});

	it('resumes from the STREAM`s own position, so nothing is re-fetched and nothing is skipped', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const successor = await incumbent.add(w.specFor('v2', 10));
		await rebuildToLevel(incumbent);
		const rebuiltState = [...w.rowsIn('v2', successor.streamDigest)];
		// the re-fold reproduced the incumbent's history, reorg included
		expect(rebuiltState).toEqual([`${idOf(AT_101)}x10`, `${idOf(REORGED_104)}x10`, `${idOf(AT_106)}x10`]);
		const positionBefore = await incumbent.ingestion.expectedFromBlock();

		await incumbent.registry.deleteGeneration(incumbent.opening.record);
		const [writer] = await incumbent.liveIngestions();

		// EXACTLY where it was. Deleting a generation is not an input to where the next
		// range starts, which is what makes the duplicate-history failure unreachable:
		// an empty-state successor could not drag this backwards either.
		expect(await writer!.expectedFromBlock()).toBe(positionBefore);
		await feed(incumbent, {toBlock: 115, latestBlock: 115, logs: [transfer(112, '0xa112', 5n)]});
		// the history the surviving fold had is still exactly the history it had
		expect(w.rowsIn('v2', successor.streamDigest).slice(0, 3)).toEqual(rebuiltState);
	});
});

describe('a generation that has NOT caught up costs the stream nothing', () => {
	it('keeps fetching and appending while the fold behind it is carried by its rebuild', async () => {
		// RE-SCOPED from "a survivor that has NOT caught up does not take the wire". The
		// old case existed because a fold that was mid-rebuild would, if handed the wire,
		// ask from its OWN position and have ADR-0052 append that whole range a second
		// time -- so succession had to WAIT, and the stream was unfed in the meantime.
		// Under ADR-0087 the stream is fed by the deployment throughout, and a fold that
		// is behind simply declines the delta it is offered.
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const successor = await incumbent.add(w.specFor('v2', 10));
		// deliberately NOT rebuilt to level: one chunk of one emission, so it is part
		// way through re-folding the stored stream
		expect(reportFor(await incumbent.rebuildMore({maxEmissions: 1}), 'v2')?.complete).toBe(false);
		const partway = [...w.rowsIn('v2', successor.streamDigest)];
		expect(partway.length).toBeGreaterThan(0);

		// An operator MOVES THE POINTER by hand first, which is what makes deleting the
		// incumbent reachable at all: the registry refuses to delete the canonical
		// generation, and a successor that has not caught up is not promoted
		// automatically.
		await incumbent.promote(successor.record);
		await incumbent.registry.deleteGeneration(incumbent.opening.record);
		// the surviving generation is the one this stream was fetched FOR, which is an
		// ANSWER and never permission to append (ADR-0087)
		expect((await incumbent.registry.fetcherOf(successor.streamDigest))?.processor).toBe(identityOf('v2'));

		// THE STREAM IS STILL FED. There is no gap to wait out, because there was no
		// duty to transfer: one live wire context, and it is the deployment's writer.
		const live = await incumbent.liveIngestions();
		expect(live.length).toBe(1);
		const storedBefore = (JSON.parse(w.stream.snapshot()).rows as unknown[]).length;
		const LATER = transfer(112, '0xa112', 5n);
		await feed(incumbent, {toBlock: 115, latestBlock: 115, logs: [LATER]});
		expect((JSON.parse(w.stream.snapshot()).rows as unknown[]).length).toBe(storedBefore + 1);

		// ...and the fold that is BEHIND took nothing from that append -- it cannot, or
		// it would leave the blocks between as a hole in its own state -- so it is exactly
		// where its last chunk left it, and its rebuild is what carries it.
		expect(w.rowsIn('v2', successor.streamDigest)).toEqual(partway);
		await rebuildToLevel(incumbent);
		expect(w.rowsIn('v2', successor.streamDigest)).toContain(`${idOf(LATER)}x10`);
	});
});

describe('nothing is rebuilt underneath a fold that is working', () => {
	it('answers the same writer however many times the records are read', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));
		await rebuildToLevel(incumbent);
		const writerBefore = incumbent.ingestion;

		// several reads of the live set, no records moved
		await incumbent.liveIngestions();
		await incumbent.liveIngestions();
		await incumbent.rebuildMore();

		// the SAME writer object. There is no reconciliation left to be a no-op: the
		// thing at a stream's address is built once, with the first fold on that stream,
		// because nothing about which folds are present is an input to it.
		expect(incumbent.ingestion).toBe(writerBefore);
		expect((await incumbent.liveIngestions())[0]).toBe(writerBefore);
	});
});
