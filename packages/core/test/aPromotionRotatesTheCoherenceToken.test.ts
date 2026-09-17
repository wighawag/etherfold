import {describe, expect, it} from 'vitest';
import {BRANCH_A, makeLog} from './utils/streamCacheWorld.js';
import {appendsIn, driveToTip, openWorld, reportingFold} from './utils/stateMovedWorld.js';
import {identityOf} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------
// A PROMOTION ROTATES THE COHERENCE TOKEN
// ---------------------------------------------------------------------------
// When the canonical pointer moves, a DIFFERENT FOLD answers reads. From a
// reader's point of view that is indistinguishable from "everything you hold may
// be wrong", so it gets the treatment a RETRACTION gets and by the SAME
// mechanism: the token rotates and the reader invalidates everything (ADR-0083).
//
// That sameness is the whole content of these cases. A promotion and a reorg
// have nothing in common mechanically, and exactly one thing in common for a
// reader, which is that narrow invalidation is no longer sufficient -- so there
// is ONE signal, ONE comparison and ONE code path in every reader ever written,
// rather than a second event kind an app author has to learn the difference
// between. What is asserted here therefore includes what is NOT published: a
// promotion adds no notification and no case to the union, it moves the token
// the next notification carries.
//
// The `generation` field is not a second mechanism. It rides EVERY notification
// and answers a different question: the token says WHETHER what a reader holds
// may be stale and is never parsed, so it can NAME nothing, while `generation`
// is the value a reader renders and compares so that a refetch after a promotion
// is not silently answered by a different lineage.
//
// The promotion is CAUSED, between two REAL generations over one stream, through
// the same machinery every other promotion case in this package uses: a
// successor is added beside the live one, it re-folds the stream, and the
// pointer is moved onto it. Nothing here hand-moves a token.
//
// The world and the fold live in `utils/stateMovedWorld.ts`, beside the append
// and retraction cases that ask the same questions of the same container.
// ---------------------------------------------------------------------------

/**
 * The two folds: the successor computes an entity the incumbent never did.
 *
 * That asymmetry is what makes "which generation answered" a question a READ can
 * answer, since a read reports no identity of its own and two folds over one
 * stream would otherwise produce the same rows -- the same reason
 * `promotion.test.ts`'s folds MARK what they produce. It is also the ordinary
 * reason a generation exists at all: the fold changed.
 */
const INCUMBENT_ENTITIES = ['cell'];
const SUCCESSOR_ENTITIES = ['cell', 'tile'];
/** Written by the successor's fold and by nothing else. */
const SUCCESSOR_ONLY = 'tile';
const successorOnlyRows = (rows: readonly string[]) => rows.some((row) => row.startsWith(`${SUCCESSOR_ONLY}@`));

/**
 * A successor built BESIDE the canonical generation and level with it, with the
 * pointer still naming the incumbent.
 *
 * `openWorld` runs the `manual` policy, so the move is made by these cases and
 * not by a successor catching up half way through one.
 */
async function aSuccessorBesideTheCanonicalOne() {
	const incumbent = reportingFold('A', () => INCUMBENT_ENTITIES);
	const world = await openWorld([incumbent], {keepStream: true});
	await world.indexer.load();
	await driveToTip(world.indexer);

	const successor = reportingFold('B', () => SUCCESSOR_ENTITIES);
	const held = await world.add(successor);
	// it FOLLOWS the stream the incumbent writes, so it re-folds that rather than
	// fetching a history of its own
	expect(held.follows).toBe(true);
	await world.indexer.load();
	await driveToTip(world.indexer);

	// the two folds are level, and the pointer has not moved
	expect(successor.applied).toEqual(incumbent.applied);
	expect(world.indexer.canonical.record.processor).toBe(identityOf('A'));

	// The chain GROWS: every block it has ever served is still served, because a
	// block that stopped being served is a REORG and would rotate the token for a
	// reason that is not the one under test.
	const served = [...BRANCH_A];
	return {
		incumbent,
		successor,
		world,
		id: held.record,
		/** One more block on the same branch, folded. */
		andOneMoreBlock: async (block: number) => {
			served.push(makeLog(block, `0xa${block}`));
			world.chain.serve([...served], block + 1);
			await driveToTip(world.indexer);
		},
	};
}

describe('a promotion rotates the coherence token', () => {
	it('ROTATES it: the first notification after the pointer moved carries a token no reader has seen', async () => {
		const {world, id, andOneMoreBlock} = await aSuccessorBesideTheCanonicalOne();
		const before = new Set(world.moved.map((notification) => notification.coherence));
		expect(before.size).toBe(1);

		await world.indexer.promote(id);
		await andOneMoreBlock(106);

		const after = world.moved[world.moved.length - 1];
		expect(appendsIn([after])[0].block).toBe(106);
		expect(before.has(after.coherence)).toBe(false);
	});

	it('NAMES the generation that answers now, from the first notification after the move onwards', async () => {
		const {world, id, andOneMoreBlock} = await aSuccessorBesideTheCanonicalOne();
		const publishedBefore = world.moved.length;
		// every notification BEFORE the move named the generation that was answering
		// then, which is the half a rotation must not quietly break
		expect(appendsIn(world.moved).every((moved) => moved.generation === world.digestOf('A'))).toBe(true);

		await world.indexer.promote(id);
		await andOneMoreBlock(106);

		const since = appendsIn(world.moved.slice(publishedBefore));
		expect(since.length).toBeGreaterThan(0);
		expect(since.every((moved) => moved.generation === world.digestOf('B'))).toBe(true);
		// and the two are really different lineages, so the assertion above is not
		// comparing one value with itself
		expect(world.digestOf('B')).not.toBe(world.digestOf('A'));
	});

	it('ANSWERS a reader that re-reads on the changed token from the generation the notification NAMED', async () => {
		// The reader's whole rule, as ADR-0083 describes it, over the one case this
		// task exists for: it re-reads through the surface it already has, and that
		// surface follows the pointer.
		const {incumbent, successor, world, id, andOneMoreBlock} = await aSuccessorBesideTheCanonicalOne();
		const rendering: {generation: string; rows: string[]} = {generation: '', rows: []};
		let held: string | undefined;
		world.indexer.onStateMoved((moved) => {
			if (moved.coherence === held) {
				return;
			}
			// TOKEN CHANGED -> invalidate EVERYTHING, and re-read
			held = moved.coherence;
			rendering.generation = moved.generation;
			rendering.rows = [...world.indexer.state];
		});

		await andOneMoreBlock(106);
		// it is rendering the incumbent, which has never held the successor's entity
		expect(rendering.generation).toBe(world.digestOf('A'));
		expect(successorOnlyRows(rendering.rows)).toBe(false);
		expect(rendering.rows).toEqual(incumbent.rows.slice(0, rendering.rows.length));

		await world.indexer.promote(id);
		await andOneMoreBlock(108);

		// The notification named the successor, and what the reader re-read came from
		// the successor's fold -- rows the retired generation could not have produced,
		// while it goes on folding beside it and answering something else.
		expect(rendering.generation).toBe(world.digestOf('B'));
		expect(successorOnlyRows(rendering.rows)).toBe(true);
		expect(rendering.rows).toEqual(successor.rows.slice(0, rendering.rows.length));
		expect(successorOnlyRows(incumbent.rows)).toBe(false);
		// and the read surface it re-read through has settled on the successor too
		expect([...world.indexer.state]).toEqual(successor.rows);
		expect(successor.rows).not.toEqual(incumbent.rows);
	});

	it('leaves an ORDINARY APPEND alone: one generation folding on carries ONE token, after the move as before it', async () => {
		// The stability property the append case bought, asserted on BOTH sides of the
		// move, because this is the change most likely to break it.
		const {world, id, andOneMoreBlock} = await aSuccessorBesideTheCanonicalOne();
		await andOneMoreBlock(106);
		const beforeTheMove = new Set(world.moved.map((notification) => notification.coherence));
		expect(beforeTheMove.size).toBe(1);
		const publishedBefore = world.moved.length;

		await world.indexer.promote(id);
		await andOneMoreBlock(108);
		await andOneMoreBlock(110);

		const since = appendsIn(world.moved.slice(publishedBefore));
		expect(since.map((moved) => moved.block)).toEqual([108, 110]);
		// ONE token across the appends that followed the move: the rotation is what a
		// POINTER MOVE does, not what a block does
		expect(new Set(since.map((moved) => moved.coherence)).size).toBe(1);
		expect(beforeTheMove.has(since[0].coherence)).toBe(false);
	});

	it('is ONE mechanism shared with the retraction: no second event kind, and no notification of its own', async () => {
		// A reader does not care that a promotion is a different THING from a reorg,
		// and two kinds would mean every app handles both. So the union is unchanged
		// and the pointer move publishes NOTHING: what it moves is the token the next
		// notification carries.
		const {world, id, andOneMoreBlock} = await aSuccessorBesideTheCanonicalOne();
		const publishedBefore = world.moved.length;

		await world.indexer.promote(id);

		expect(world.moved.length).toBe(publishedBefore);
		await andOneMoreBlock(106);
		expect(world.moved.every((notification) => notification.kind === 'applied')).toBe(true);
	});

	it('rotates on the move the POLICY makes, not on the verb a caller called', async () => {
		// The rotation belongs to the POINTER MOVE and not to `promote`, so the
		// container promoting a successor on its own -- which is what `on-catch-up`,
		// the default everywhere, does -- rotates exactly as an asked-for move does. A
		// reader cannot tell the two apart and must not have to.
		const incumbent = reportingFold('A', () => INCUMBENT_ENTITIES);
		const world = await openWorld([incumbent], {keepStream: true, promotion: {policy: 'on-catch-up'}});
		await world.indexer.load();
		await driveToTip(world.indexer);
		const before = new Set(world.moved.map((notification) => notification.coherence));
		expect(before.size).toBe(1);

		const successor = reportingFold('B', () => SUCCESSOR_ENTITIES);
		await world.add(successor);
		// nobody asked: the successor re-folds the stream, reaches the cursor the
		// canonical generation has, and the container moves the pointer itself
		await world.indexer.load();
		await driveToTip(world.indexer);
		expect(world.indexer.canonical.record.processor).toBe(identityOf('B'));

		world.chain.serve([...BRANCH_A, makeLog(106, '0xa106')], 107);
		await driveToTip(world.indexer);

		const after = world.moved[world.moved.length - 1];
		expect(appendsIn([after])[0].block).toBe(106);
		expect(after.generation).toBe(world.digestOf('B'));
		expect(before.has(after.coherence)).toBe(false);
	});

	it('rotates NOTHING when the generation named is the one already answering', async () => {
		// Promoting the canonical generation moves no pointer, so nothing a reader
		// holds became suspect -- and invalidating every reader's cache would be a
		// re-read charged for a lineage change that did not happen.
		const {world, andOneMoreBlock} = await aSuccessorBesideTheCanonicalOne();
		await andOneMoreBlock(106);
		const tokenBefore = world.moved[world.moved.length - 1].coherence;

		await world.indexer.promote(world.indexer.canonical.record);
		await andOneMoreBlock(108);

		expect(world.moved[world.moved.length - 1].coherence).toBe(tokenBefore);
	});
});
