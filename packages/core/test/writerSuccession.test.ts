import {describe, expect, it} from 'vitest';
import {
	AT_101,
	AT_106,
	FINALITY,
	REORGED_104,
	anIncumbentThatHasFolded,
	batch,
	idOf,
	transfer,
} from './utils/receivingWorld.js';

// ---------------------------------------------------------------------------------------------------
// WRITER SUCCESSION, THE ENGINE HALF: THE WIRE MOVES TO THE OLDEST SURVIVOR
// ---------------------------------------------------------------------------------------------------
// ADR-0044 says the writer of a stream is the OLDEST SURVIVING generation held on
// it, and that succession is atomic with a delete BECAUSE IT IS STORED NOWHERE:
// the commit that removes the record is already the commit that makes the
// next-oldest generation the answer. That is the DURABLE half, and it has been
// true since the registry landed -- `registry.writerOf` answered correctly the
// instant the record went.
//
// What this file asserts is the half the amendment explicitly deferred: that a
// RUNNING PROCESS actually hands the survivor the engine. Without it the records
// said one thing and the host did another -- deleting a writer removed the only
// RECEIVER its stream had, so an incoming batch resolved to no receiver, nothing
// appended, and `/status` went on looking healthy while the cursor stopped. That
// stall is silent, which is why it is worth a file of its own.
//
// The two directions, and the guard between them:
//
//  - a FOLLOWER that inherits the duty stops following and gets the receiver AND
//    the appender, so the stream goes on being fed and on being stored;
//  - a fold that is still CATCHING UP does NOT take the wire, because a receiver
//    asks from its own position and ADR-0052 appends a re-sent range a second
//    time -- so it waits for its rebuild, and takes over once level.
// ---------------------------------------------------------------------------------------------------

/** Drive a batch into whichever fold currently holds the wire. */
async function feed(
	indexer: Awaited<ReturnType<typeof anIncumbentThatHasFolded>>['incumbent'],
	over: {toBlock: number; latestBlock: number; logs: ReturnType<typeof transfer>[]},
) {
	const [receiver] = await indexer.liveIngestions();
	if (!receiver) throw new Error('the stream has no receiver, so nothing can be fed');
	const fromBlock = await receiver.expectedFromBlock();
	return receiver.receive({
		context: receiver.context,
		fromBlock,
		toBlock: over.toBlock,
		latestBlock: over.latestBlock,
		logs: over.logs.map((event) => ({...event})),
	});
}

/** Advance every follower until nothing is left to re-fold. */
async function rebuildToLevel(indexer: Awaited<ReturnType<typeof anIncumbentThatHasFolded>>['incumbent']) {
	for (let guard = 0; guard < 100; guard++) {
		const reports = await indexer.rebuildMore();
		if (reports.length === 0 || reports.every((report) => report.complete)) return;
	}
	throw new Error('the rebuild never reported complete');
}

describe('deleting a stream`s WRITER hands the wire to the oldest survivor', () => {
	it('makes the follower stop following, take the receiver, and take the appender', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const successor = await incumbent.add(w.specFor('v2', 10));
		await rebuildToLevel(incumbent);

		// before: the incumbent writes, the successor follows and has no address
		expect(incumbent.opening.writesStream).toBe(true);
		expect(successor.follows).toBe(true);
		expect(successor.ingestion).toBeUndefined();

		// the successor is canonical after catching up, so the incumbent can be deleted
		await incumbent.registry.deleteGeneration(incumbent.opening.record);
		// asking what is live is what reconciles: the records moved, so the host must
		const live = await incumbent.liveIngestions();

		expect(successor.follows).toBe(false);
		expect(successor.rebuild).toBeUndefined();
		expect(successor.ingestion).toBeDefined();
		expect(successor.writesStream).toBe(true);
		// and it is the one live wire context on that stream
		expect(live.map((receiver) => receiver.streamDigest)).toEqual([successor.streamDigest]);
	});

	it('goes on FEEDING and STORING the stream, which is the stall this removes', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const successor = await incumbent.add(w.specFor('v2', 10));
		await rebuildToLevel(incumbent);
		const storedBefore = JSON.parse(w.stream.snapshot()).rows.length as number;

		await incumbent.registry.deleteGeneration(incumbent.opening.record);

		// a batch that arrives AFTER the writer went is still received...
		const LATER = transfer(112, '0xa112', 5n);
		await feed(incumbent, {toBlock: 115, latestBlock: 115, logs: [LATER]});

		// ...folded by the survivor, into its own state...
		expect(w.rowsIn('v2', successor.streamDigest)).toContain(`${idOf(LATER)}x10`);
		// ...and APPENDED to the stream, because the duty moved with the wire. Without
		// succession this row would simply not exist and nothing would have said so.
		expect((JSON.parse(w.stream.snapshot()).rows as unknown[]).length).toBe(storedBefore + 1);
	});

	it('resumes from the survivor`s OWN cursor, so nothing is re-folded and nothing is skipped', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const successor = await incumbent.add(w.specFor('v2', 10));
		await rebuildToLevel(incumbent);
		const rebuiltState = [...w.rowsIn('v2', successor.streamDigest)];
		// the re-fold reproduced the incumbent's history, reorg included
		expect(rebuiltState).toEqual([`${idOf(AT_101)}x10`, `${idOf(REORGED_104)}x10`, `${idOf(AT_106)}x10`]);

		await incumbent.registry.deleteGeneration(incumbent.opening.record);
		const [receiver] = await incumbent.liveIngestions();

		// the new writer asks from ITS OWN position, which is where the re-fold left it
		// -- not from the start of the stream, and not from where the deleted writer was
		expect(await receiver!.expectedFromBlock()).toBeGreaterThan(FINALITY);
		await feed(incumbent, {toBlock: 115, latestBlock: 115, logs: [transfer(112, '0xa112', 5n)]});
		// the history it had is still exactly the history it had: taking the wire
		// re-folds nothing
		expect(w.rowsIn('v2', successor.streamDigest).slice(0, 3)).toEqual(rebuiltState);
	});
});

describe('a survivor that has NOT caught up does not take the wire', () => {
	it('waits for its rebuild rather than re-asking for a range ADR-0052 would append twice', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const successor = await incumbent.add(w.specFor('v2', 10));
		// deliberately NOT rebuilt to level: one chunk of one emission, so it is part
		// way through re-folding the stored stream
		await incumbent.rebuildMore({maxEmissions: 1});
		expect(successor.follows).toBe(true);

		// An operator MOVES THE POINTER by hand first, which is what makes this reachable
		// at all: the registry refuses to delete the canonical generation, and a successor
		// that has not caught up is not promoted automatically. `POST
		// /{indexer}/admin/canonical-generation` is that move, and it is ungated by the
		// policy on purpose -- so an operator CAN publish a generation mid-rebuild, and
		// then delete the one it superseded.
		await incumbent.promote(successor.record);

		// the writer goes while the survivor is still behind. The registry answers the
		// succession immediately -- that half is durable and needs no host.
		await incumbent.registry.deleteGeneration(incumbent.opening.record);
		expect((await incumbent.registry.writerOf(successor.streamDigest))?.processor).toBe('v2');

		const live = await incumbent.liveIngestions();

		// ...but the ENGINE does not move yet: it is still a follower, still has no
		// receiver, and the stream is unfed for now. That is visible and recoverable;
		// a duplicated range would be neither.
		expect(successor.follows).toBe(true);
		expect(successor.ingestion).toBeUndefined();
		expect(successor.writesStream).toBe(false);
		expect(live).toEqual([]);

		// and it is not a stall: the rebuild is still what advances it, and the moment
		// it is level the wire is handed over.
		await rebuildToLevel(incumbent);
		expect(successor.writesStream).toBe(true);
		expect(successor.ingestion).toBeDefined();
		expect((await incumbent.liveIngestions()).length).toBe(1);
		// and the stream it now writes is the same one, still stored once
		await feed(incumbent, {toBlock: 115, latestBlock: 115, logs: [transfer(112, '0xa112', 5n)]});
		expect(w.rowsIn('v2', successor.streamDigest)).toContain(`${idOf(transfer(112, '0xa112', 5n))}x10`);
	});
});

describe('nothing succeeds where nothing changed', () => {
	it('leaves a stream whose writer is still registered exactly as it was', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const successor = await incumbent.add(w.specFor('v2', 10));
		await rebuildToLevel(incumbent);
		const receiverBefore = incumbent.opening.ingestion;

		// several reconciliations, no records moved
		await incumbent.liveIngestions();
		await incumbent.liveIngestions();
		await incumbent.rebuildMore();

		// the SAME receiver object: reconciliation is a no-op when the writer has not
		// changed, so nothing is rebuilt underneath a fold that is working
		expect(incumbent.opening.ingestion).toBe(receiverBefore);
		expect(incumbent.opening.writesStream).toBe(true);
		expect(successor.follows).toBe(true);
		expect(successor.writesStream).toBe(false);
	});
});
