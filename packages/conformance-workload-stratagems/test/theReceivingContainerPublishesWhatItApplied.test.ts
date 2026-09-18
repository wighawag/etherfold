/**
 * THE SIGNAL, ON THE CONTAINER EVERY SERVER AND CLI DEPLOYMENT ACTUALLY FOLDS
 * THROUGH, OVER A REAL FOLD.
 *
 * `theFoldPublishesWhatItJustChanged.test.ts` beside this one asks the same
 * questions of the CHAIN-FACING container, which is the one a browser runs.
 * Nothing that passes there says anything about a server: a server applies its
 * blocks in `ReceivingIndexer`, the chain-free twin, which is fed WIRE BATCHES
 * by a fetcher elsewhere and used to publish nothing at all. So these cases
 * drive the OTHER container over the same committed stratagems capture -- a real
 * ABI, real logs, the shipped `EntityEventProcessor` -- with a subscriber
 * attached, and assert the same properties.
 *
 * The point of asking them twice is that the answer must be the SAME ANSWER
 * rather than a second one: both containers publish from one assembly
 * (`StateMovedPublisher`, ADR-0083), so what is really being checked here is
 * that the receiving path reaches it -- that the relay carrying the entity set
 * up from `@etherfold/processor-entities` is attached, that the canonical filter
 * is applied, and that a retraction rotates the token on this path exactly as it
 * does on the other one.
 *
 * The ABANDONED deployment's capture (42 logs, 9 event-bearing blocks; see
 * `fixtures.ts` for why `base` is not the launched game), on the same reasoning
 * the chain-facing file gives: this is a question about the PUBLICATION, and the
 * publication does not get more interesting at 31,332 events.
 */
import {
	createMemoryGenerationRegistryPort,
	generationDigestOf,
	openReceivingIndexer,
	type AppliedBlock,
	type LogEvent,
	type StateApplied,
	type StateMoved,
} from '@etherfold/core';
import {
	EntityEventProcessor,
	applyEventStream,
	openForWriting,
	type EntityStateView,
} from '@etherfold/processor-entities';
import {MemoryStateStore, type WritableStateStore} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {BASE_ABANDONED, loadStream, stratagemsProcessor} from '../src/index.js';
import type {StratagemsABI} from '../vendor/stratagems/abi.js';
import {identityOf} from './utils/processorIdentity.js';

const FINALITY = 12;

/**
 * The identity this fold runs under, HANDED over the way an arrival hands one
 * (ADR-0086: derived from bytes, never declared by the author).
 *
 * The subject here is what the RECEIVING container publishes, so the fold's name
 * is only ever what a notification quotes -- but it has to be supplied, because a
 * deployment that supplies nothing has no name at all and is refused.
 */
const PROCESSOR_IDENTITY = identityOf('stratagems-receiving-container');

/**
 * The block the chain takes back, the fork point that leaves, and the height its
 * transactions come back at.
 *
 * The same three the chain-facing retraction case uses, quoted as literals for
 * the same reason it quotes them: the case is a fact about a chain, and a
 * computed midpoint would drift into meaning something else. The withdrawn one
 * is the capture's LAST and busiest block; the capture has no block after it, so
 * the one that arrives next is made here out of real captured logs re-stamped at
 * a later height, which is what a transaction that went back to the mempool and
 * was re-mined looks like.
 */
const WITHDRAWN_BLOCK = 11_704_357;
const FORK_POINT = WITHDRAWN_BLOCK - 1;
const REMINED_BLOCK = WITHDRAWN_BLOCK + 13;
const REMINED_FROM = 11_683_311;

/**
 * A RECEIVING CONTAINER over this capture, with an in-process subscriber
 * attached and NOTHING chain-facing anywhere near it.
 *
 * No provider, because this container makes no chain call: that is the whole
 * reason it exists, and it is why every split and CLI deployment folds through
 * it. What drives it is `push` below -- a WIRE BATCH, as a fetcher sends one.
 */
async function aReceivingContainer() {
	const fixture = loadStream(BASE_ABANDONED);
	const container = await openReceivingIndexer<StratagemsABI, EntityStateView, WritableStateStore>({
		port: createMemoryGenerationRegistryPort(),
		caps: {maxGenerations: 2, maxStreams: 1},
		source: fixture.source,
		stream: {finality: FINALITY},
		generation: {
			createState: () => openForWriting(new MemoryStateStore(stratagemsProcessor.entities)),
			createProcessor: (store) => new EntityEventProcessor<StratagemsABI>(store, stratagemsProcessor),
			processorIdentity: PROCESSOR_IDENTITY,
		},
	});

	const moved: StateMoved[] = [];
	const detach = container.onStateMoved((notification) => moved.push(notification));
	const ingestion = container.ingestion;

	/**
	 * ONE PUSH, as a fetcher makes one.
	 *
	 * The RECEIVER says where the range starts (`expectedFromBlock`: it reaches
	 * back over the unconfirmed window, which is the only way a reorg is ever
	 * detected), so the caller supplies the history and the logs below that block
	 * are dropped -- which is exactly what a fetcher does with a `409` correction.
	 */
	const push = async (over: {logs: LogEvent<StratagemsABI>[]; toBlock: number; latestBlock: number}) => {
		const fromBlock = await ingestion.expectedFromBlock();
		return ingestion.receive({
			context: ingestion.context,
			fromBlock,
			toBlock: over.toBlock,
			latestBlock: over.latestBlock,
			logs: over.logs.filter((event) => event.blockNumber >= fromBlock),
		});
	};

	return {fixture, container, ingestion, moved, detach, push};
}

/** The whole capture, folded through the receiving container in one batch. */
async function foldTheWholeCapture() {
	const world = await aReceivingContainer();
	await world.push({
		logs: [...world.fixture.eventStream],
		toBlock: world.fixture.lastSync.lastToBlock,
		latestBlock: world.fixture.lastSync.latestBlock,
	});
	return world;
}

/**
 * What the SAME handlers touch, block by block, established independently.
 *
 * Through `applyEventStream` with a reporter of its own rather than by reading
 * the expectation out of the thing under test, exactly as the chain-facing file
 * does it: the comparison is then between two runs of the real processor, and a
 * hand-written list of entity names would be a statement about this fixture
 * rather than about the fold.
 */
async function touchedPerBlock(eventStream: ReturnType<typeof loadStream>['eventStream']) {
	const store = await openForWriting(new MemoryStateStore(stratagemsProcessor.entities));
	const applied: AppliedBlock[] = [];
	await applyEventStream(store, stratagemsProcessor, eventStream, undefined, undefined, (report) => {
		if (report.kind !== 'applied') {
			throw new Error(`this capture holds no reorg, yet the fold retracted to ${report.forkPoint}`);
		}
		applied.push(report);
	});
	return applied;
}

/**
 * The notifications as APPENDS, REFUSING one that is not.
 *
 * Same helper and same reasoning as the chain-facing file: an assertion about
 * `block` or `entities` has to narrow, and refusing rather than filtering keeps
 * it honest where a capture holds no reorg.
 */
function appendsIn(moved: readonly StateMoved[]): StateApplied[] {
	return moved.map((notification) => {
		if (notification.kind !== 'applied') {
			throw new Error(`expected an applied-block notification, got '${notification.kind}'`);
		}
		return notification;
	});
}

/**
 * The same transactions, mined again at a later height: what the chain does with
 * the contents of a block it dropped.
 *
 * The LOGS are the capture's own, so the handlers that run are the real ones on
 * real arguments; what is synthesised is the block they sit in, because a
 * capture of a chain that did not reorg cannot contain the branch it did not
 * take.
 */
function reminedAt(block: number, hash: `0x${string}`, events: LogEvent<StratagemsABI>[]): LogEvent<StratagemsABI>[] {
	return events.map((event, index) => ({
		...event,
		blockNumber: block,
		blockHash: hash,
		blockTimestamp: (event.blockTimestamp ?? 0) + 12 * (block - event.blockNumber),
		logIndex: index,
	}));
}

describe('the receiving container publishes what it applied', () => {
	it('publishes one notification per applied block, naming the entities that block really touched', async () => {
		const {fixture, moved} = await foldTheWholeCapture();
		const expected = await touchedPerBlock(fixture.eventStream);
		const appends = appendsIn(moved);

		// one per APPLIED block, in order, naming that block
		expect(appends.map((notification) => notification.block)).toEqual(expected.map((block) => block.block));
		// and the entity NAMES are the ones the mutations carried, which is the half
		// that proves the RELAY is attached on this path and not only on the other one
		expect(appends.map((notification) => notification.entities)).toEqual(expected.map((block) => block.entities));
		expect(appends.flatMap((notification) => notification.entities).length).toBeGreaterThan(0);
	});

	it('names only entities the mutations touched, so a declared-but-untouched one is absent', async () => {
		const {moved} = await foldTheWholeCapture();
		const declared = stratagemsProcessor.entities.map((entity) => entity.name);
		const named = new Set(appendsIn(moved).flatMap((notification) => notification.entities));

		// every name is a declared entity: the payload is O(schema), never O(mutations)
		expect([...named].filter((name) => !declared.includes(name))).toEqual([]);
		// and the capture does not touch everything this processor declares, which is
		// what makes narrow invalidation worth anything
		expect(declared.filter((name) => !named.has(name)).length).toBeGreaterThan(0);
	});

	it('publishes an empty set for an applied block whose handlers changed nothing', async () => {
		// The capture opens with an `OwnershipTransferred` this processor has no
		// handler for: the block IS applied and it touched no entity, so it is
		// published with nothing to invalidate narrowly rather than not published at
		// all. One rule -- "one notification per APPLIED block" -- on both containers.
		const {moved} = await foldTheWholeCapture();
		const empty = appendsIn(moved).filter((notification) => notification.entities.length === 0);
		expect(empty.length).toBeGreaterThan(0);
		expect(moved.length).toBeGreaterThan(empty.length);
	});

	it('names the generation that answered, and carries one token across the whole fold', async () => {
		const {container, moved} = await foldTheWholeCapture();
		const canonical = await container.canonical();
		const generation = generationDigestOf(canonical as {stream: string; processor: string});

		expect(moved.length).toBeGreaterThan(1);
		expect(moved.every((notification) => notification.generation === generation)).toBe(true);
		expect(new Set(moved.map((notification) => notification.coherence)).size).toBe(1);
	});

	it(`publishes ONE retraction naming block ${FORK_POINT.toLocaleString('en-US')}, with a token that MOVED`, async () => {
		// A reorg CAUSED rather than a message shape asserted: the range is
		// re-delivered with the withdrawn block's logs simply GONE, which is the
		// ABSENCE case the receiver infers a reorg from. Nothing here hand-builds a
		// retraction, at either layer, and the fork point published is the one a real
		// `revertTo` was handed.
		const {fixture, moved, push} = await aReceivingContainer();
		const at = (block: number) => fixture.eventStream.filter((event) => event.blockNumber === block);
		const below = (block: number) => fixture.eventStream.filter((event) => event.blockNumber < block);

		// everything below the block the chain is about to take back...
		await push({logs: below(WITHDRAWN_BLOCK), toBlock: FORK_POINT, latestBlock: FORK_POINT});
		// ...then that block, which lands inside the reorg window...
		await push({logs: at(WITHDRAWN_BLOCK), toBlock: WITHDRAWN_BLOCK, latestBlock: WITHDRAWN_BLOCK});
		const beforeTheReorg = moved.length;
		const tokenBefore = moved[beforeTheReorg - 1].coherence;
		expect(new Set(moved.map((notification) => notification.coherence)).size).toBe(1);

		// ...and now the chain re-delivers that range with those logs GONE and one of
		// its transactions re-mined higher up.
		await push({
			logs: reminedAt(REMINED_BLOCK, '0xreminedcommitment', at(REMINED_FROM)),
			toBlock: REMINED_BLOCK + 1,
			latestBlock: REMINED_BLOCK + 1,
		});

		const published = moved.slice(beforeTheReorg);
		expect(published.map((notification) => notification.kind)).toEqual(['retracted', 'applied']);
		const retraction = published[0];
		expect(retraction.kind === 'retracted' && retraction.forkPoint).toBe(FORK_POINT);
		// no block, no entity set: a rotated token means invalidate everything
		expect(Object.keys(retraction).sort()).toEqual(['coherence', 'forkPoint', 'generation', 'kind']);
		expect(retraction.coherence).not.toBe(tokenBefore);
		// and the append that follows it carries the same NEW token, naming only what
		// the replacement block touched
		const append = published[1];
		expect(append.coherence).toBe(retraction.coherence);
		expect(append.kind === 'applied' && append.entities).toEqual(['commitment']);
	});

	it('carries no rows, no mutations and no state handle: the silence about handles is UNCHANGED', async () => {
		// This container withholds a state HANDLE by design -- reads on this runtime
		// resolve the canonical pointer to a table namespace (ADR-0053), so there is no
		// `stateOf` and nothing is notified with a value. Publishing a NOTIFICATION is a
		// different thing and does not reopen that: what goes out is its case plus four
		// facts, and a reader re-reads through the surface it already has.
		const {container, moved} = await foldTheWholeCapture();
		for (const notification of appendsIn(moved)) {
			expect(Object.keys(notification).sort()).toEqual(['block', 'coherence', 'entities', 'generation', 'kind']);
			// NAMES, not ids and not rows: a string per entity and nothing structured
			expect(notification.entities.every((entity) => typeof entity === 'string')).toBe(true);
		}

		// the state is still reached through the fold this host BUILT, and is still
		// published to nobody: no callback slot exists to hand one to
		expect(container.state).toBe(container.opening.state);
		expect((container as unknown as Record<string, unknown>).onStateUpdated).toBeUndefined();
		expect((container as unknown as Record<string, unknown>).stateOf).toBeUndefined();
	});

	it('holds NOTHING per subscriber, and detaching really stops delivery', async () => {
		// The property every transport downstream rests on, asserted on THIS container
		// because this is the one a SharedWorker-shaped host would not be running but a
		// long-lived server would.
		const world = await aReceivingContainer();
		const second: StateMoved[] = [];
		const detachSecond = world.container.onStateMoved((notification) => second.push(notification));
		world.detach();
		detachSecond();

		const late: StateMoved[] = [];
		world.container.onStateMoved((notification) => late.push(notification));
		await world.push({
			logs: [...world.fixture.eventStream],
			toBlock: world.fixture.lastSync.lastToBlock,
			latestBlock: world.fixture.lastSync.latestBlock,
		});

		expect(late.length).toBeGreaterThan(0);
		expect(world.moved).toEqual([]);
		expect(second).toEqual([]);
	});
});
