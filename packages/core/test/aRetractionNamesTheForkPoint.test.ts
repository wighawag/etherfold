import {describe, expect, it} from 'vitest';
import type {StateMoved} from '../src/stateMoved.js';
import {BRANCH_A, BRANCH_B, BRANCH_B_TIP, makeLog} from './utils/streamCacheWorld.js';
import {driveToTip, openWorld, reportingFold} from './utils/stateMovedWorld.js';

// ---------------------------------------------------------------------------
// A RETRACTION NAMES THE FORK POINT IT WITHDREW
// ---------------------------------------------------------------------------
// A reorg does not add data, it WITHDRAWS it, and a reader that is only ever
// told "there is more" renders the abandoned branch for ever. So the withdrawal
// is a first-class case of the signal (ADR-0083): an explicit retraction naming
// the FORK POINT, and a coherence token that ROTATES with it.
//
// The second half is the one that is easy to skip and is the reason the first
// one is safe. Delivery is best-effort and the producer holds nothing per
// client, so a reader CAN miss the retraction -- and "the next notification
// repairs it" is true of an append and FALSE of a retraction, because the stale
// entities are the ones the ABANDONED branch touched and those are generally not
// in the next block's changed-set. The rotated token closes that for the cost of
// one field, and it is asserted here by DROPPING the retraction on the floor
// rather than by inspecting a message shape.
//
// The reorg is CAUSED, through the same machinery every other reorg case in this
// package uses: the fake chain serves branch A, then serves branch B, and the
// engine derives the `removed` markers itself. Nothing here hand-builds a
// retraction.
// ---------------------------------------------------------------------------

/**
 * The fold under these cases: block 104 on branch A touches an entity the
 * REPLACEMENT block does not.
 *
 * That asymmetry is the whole hazard, stated as data. `player@104` is written by
 * the branch the chain abandons and by nothing else, so a reader invalidating
 * NARROWLY on the next append is never told to re-read it -- which is what makes
 * "the reader converged" an assertion about the token rather than about luck.
 */
const ABANDONED_ENTITY = 'player';
const entitiesPerBlock = (_block: number, hash: string) => (hash === '0xa104' ? ['cell', ABANDONED_ENTITY] : ['cell']);

/** The world these cases drive, before anything is folded, so a reader can attach first. */
async function branchAWorld() {
	const fold = reportingFold('A', entitiesPerBlock);
	const world = await openWorld([fold]);
	return {fold, world};
}

/** Branch A folded to the tip, with the notifications it published. */
async function foldedToBranchA() {
	const {fold, world} = await branchAWorld();
	await world.indexer.load();
	await driveToTip(world.indexer);
	expect(fold.read(ABANDONED_ENTITY).length).toBe(1);
	return {fold, world};
}

/** The same chain reorganised at 104, folded to the new tip. */
async function thenReorged(world: Awaited<ReturnType<typeof foldedToBranchA>>['world']) {
	world.chain.serve([...BRANCH_B], BRANCH_B_TIP);
	await driveToTip(world.indexer);
}

function retractionsIn(moved: readonly StateMoved[]) {
	return moved.filter((notification) => notification.kind === 'retracted');
}

describe('a reorg publishes a retraction naming the fork point it withdrew', () => {
	it('publishes an explicit RETRACTION naming the fork point, distinguishable at the TYPE level', async () => {
		const {world} = await foldedToBranchA();
		const beforeTheReorg = world.moved.length;

		await thenReorged(world);

		const retractions = retractionsIn(world.moved);
		expect(retractions.length).toBe(1);
		const retraction = retractions[0];
		// THE FORK POINT, which is what the fold reverted to: branch B replaces the
		// block at 104, so everything above 103 was withdrawn. A SET OF BLOCKS is
		// deliberately not what crosses -- the fork point is the vocabulary
		// `revertTo`, the `removed` markers and the emission stream already share.
		expect(retraction.forkPoint).toBe(103);
		// DISTINGUISHABLE BY ITS TAG, never by a field being absent: a reader
		// switches on `kind`, and the compiler is what stops it reading `block` off a
		// retraction.
		expect(retraction.kind).toBe('retracted');
		expect(Object.keys(retraction).sort()).toEqual(['coherence', 'forkPoint', 'generation', 'kind']);
		// it names the generation that withdrew, exactly as an append names the one
		// that applied
		expect(retraction.generation).toBe(world.digestOf('A'));
		// and it arrived where the reorg did, not at the end of the fold
		expect(world.moved.indexOf(retraction)).toBe(beforeTheReorg);
	});

	it('ROTATES the coherence token: what is published after a retraction differs from what was published before', async () => {
		const {world} = await foldedToBranchA();
		const before = new Set(world.moved.map((notification) => notification.coherence));
		expect(before.size).toBe(1);

		await thenReorged(world);

		const after = world.moved.slice(-2);
		// the retraction itself carries the NEW token, so a reader that received it
		// holds the token the appends after it carry
		expect(after.every((notification) => !before.has(notification.coherence))).toBe(true);
		expect(new Set(after.map((notification) => notification.coherence)).size).toBe(1);
	});

	it('publishes the retraction BEFORE the block that replaced the abandoned one', async () => {
		// The fold reverts once at the fork point and only then applies, so a reader
		// told the other way round would re-read the replacement and then be told to
		// throw it away.
		const {world} = await foldedToBranchA();
		const beforeTheReorg = world.moved.length;

		await thenReorged(world);

		const kinds = world.moved.slice(beforeTheReorg).map((notification) => notification.kind);
		expect(kinds).toEqual(['retracted', 'applied']);
		const replacement = world.moved[world.moved.length - 1];
		expect(replacement.kind === 'applied' && replacement.block).toBe(104);
	});

	it('converges a reader that MISSED the retraction, one notification later', async () => {
		// THE PROPERTY THE TOKEN BUYS. This reader never sees the retraction -- it is
		// dropped on the floor, which is exactly what best-effort delivery permits --
		// and it is correct anyway at the next notification, because that
		// notification carries a token it has never seen and its rule for that is to
		// invalidate everything.
		const {fold, world} = await branchAWorld();
		const reader = renderingReader(fold);
		world.indexer.onStateMoved((notification) => {
			if (notification.kind === 'retracted') return; // LOST IN TRANSIT
			reader.receive(notification);
		});

		// it is rendering branch A, the abandoned block included
		await world.indexer.load();
		await driveToTip(world.indexer);
		expect(reader.rendering(ABANDONED_ENTITY)).toEqual([`${ABANDONED_ENTITY}@104:0xa104`]);
		// it invalidated everything ONCE on first contact (it held no token) and has
		// been invalidating narrowly ever since, which is the state a reader is in when
		// a reorg finds it
		const wholesaleBefore = reader.invalidatedEverything;
		expect(wholesaleBefore).toBe(1);

		await thenReorged(world);

		// the fold itself no longer holds the dead branch...
		expect(fold.read(ABANDONED_ENTITY)).toEqual([]);
		// ...and neither does the reader, which was told nothing about that entity
		expect(reader.rendering(ABANDONED_ENTITY)).toEqual([]);
		// because the ONE append it did receive carried a token it had never seen
		expect(reader.invalidatedEverything).toBe(wholesaleBefore + 1);
		// what it DID re-read narrowly is still current, so convergence is not a
		// cache that simply gave up
		expect(reader.rendering('cell')).toEqual(fold.read('cell'));
	});

	it('is what the token is FOR: without it, narrow invalidation keeps the abandoned branch', async () => {
		// The same reader with its first line removed. It is not a straw man: it is
		// precisely what "a missed notification is repaired by the next one" produces
		// when the missed one was a retraction, and it is why the token is carried.
		const {fold, world} = await branchAWorld();
		const reader = renderingReader(fold, {compareTheToken: false});
		world.indexer.onStateMoved((notification) => {
			if (notification.kind === 'retracted') return;
			reader.receive(notification);
		});

		await world.indexer.load();
		await driveToTip(world.indexer);
		expect(reader.rendering(ABANDONED_ENTITY)).toEqual([`${ABANDONED_ENTITY}@104:0xa104`]);
		await thenReorged(world);

		expect(fold.read(ABANDONED_ENTITY)).toEqual([]);
		expect(reader.rendering(ABANDONED_ENTITY)).toEqual([`${ABANDONED_ENTITY}@104:0xa104`]);
	});

	it('does NOT rotate the token for a NON-CANONICAL fold replaying the same retraction', async () => {
		// A follower re-folds the whole stored stream to catch up, retractions
		// included, while nothing a reader can see has moved. Publishing there would
		// be noise; ROTATING there would be worse -- every reader of the canonical
		// fold would throw its cache away because a second generation caught up.
		const canonical = reportingFold('A', entitiesPerBlock);
		const world = await openWorld([canonical], {keepStream: true});
		await world.indexer.load();
		await driveToTip(world.indexer);
		world.chain.serve([...BRANCH_B], BRANCH_B_TIP);
		await driveToTip(world.indexer);
		const publishedBefore = world.moved.length;
		const tokenBefore = world.moved[world.moved.length - 1].coherence;

		const follower = reportingFold('B', entitiesPerBlock);
		const held = await world.add(follower);
		expect(held.follows).toBe(true);
		await world.indexer.load();
		await driveToTip(world.indexer);

		// the follower really did replay the retraction -- otherwise this asserts nothing
		expect(follower.retractedTo).toContain(103);
		expect(world.moved.length).toBe(publishedBefore);

		// and the next thing the CANONICAL fold applies still carries the token the
		// reader already holds, so nothing was invalidated by a second fold catching up
		world.chain.serve([...BRANCH_B, makeLog(106, '0xb106')], 107);
		await driveToTip(world.indexer);
		expect(world.moved.length).toBeGreaterThan(publishedBefore);
		expect(world.moved[world.moved.length - 1].coherence).toBe(tokenBefore);
	});

	it('leaves an ordinary append alone: no retraction, one token, for a fold that never reverts', async () => {
		const {world} = await foldedToBranchA();
		world.chain.serve([...BRANCH_A, makeLog(106, '0xa106')], 107);
		await driveToTip(world.indexer);

		expect(retractionsIn(world.moved)).toEqual([]);
		expect(new Set(world.moved.map((notification) => notification.coherence)).size).toBe(1);
	});
});

/**
 * A READER, as ADR-0083 describes one: it holds a token and what it is
 * rendering, and its whole rule is two lines.
 *
 * `compareTheToken: false` removes the first of those two lines, which is what
 * the case above uses to show the hazard is real rather than hypothetical. It
 * re-reads through the surface it already has (the fold's own rows), which is
 * the point of a SIGNAL: nothing is delivered TO it.
 */
function renderingReader(
	fold: {read: (entity: string) => string[]},
	options: {compareTheToken?: boolean} = {},
): {
	receive: (moved: StateMoved) => void;
	rendering: (entity: string) => string[];
	invalidatedEverything: number;
} {
	const compareTheToken = options.compareTheToken !== false;
	const cache = new Map<string, string[]>();
	let held: string | undefined;
	let everything = 0;
	const known = new Set<string>();
	return {
		receive(moved: StateMoved) {
			if (moved.kind === 'applied') for (const entity of moved.entities) known.add(entity);
			if (compareTheToken && moved.coherence !== held) {
				held = moved.coherence;
				everything++;
				// TOKEN CHANGED -> invalidate EVERYTHING: drop the lot and re-read what is
				// still being rendered.
				for (const entity of [...cache.keys(), ...known]) cache.set(entity, fold.read(entity));
				return;
			}
			held = moved.coherence;
			// TOKEN UNCHANGED -> invalidate NARROWLY, using the names it was given.
			if (moved.kind === 'applied') for (const entity of moved.entities) cache.set(entity, fold.read(entity));
		},
		rendering(entity: string) {
			return cache.get(entity) ?? [];
		},
		get invalidatedEverything() {
			return everything;
		},
	};
}
