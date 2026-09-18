/**
 * A REORG, CAUSED, OVER THE REAL FOLD -- AND WHAT A READER CAN CONCLUDE FROM IT.
 *
 * `@etherfold/core`'s own suite asserts what a CONTAINER does with a retraction:
 * that one is published, that it names the fork point, that the token rotates,
 * that a follower replaying the same retraction rotates nothing. It does that
 * against a fold that reports numbers of its own.
 *
 * What cannot be asserted there is the half that matters most: that the FORK
 * POINT a reader is told about is the one a REAL `revertTo` was handed, over a
 * real processor, on real logs. So this drives the container over the committed
 * stratagems capture -- a real ABI, the shipped `EntityEventProcessor`, a real
 * versioned store -- and causes a real reorg by RE-DELIVERING a range with a
 * block's logs gone, which is the ABSENCE case the engine infers a reorg from.
 * Nothing here hand-builds a retraction, at either layer.
 *
 * The case it ends on is the whole point of the token. The retraction is dropped
 * on the floor -- which is exactly what best-effort delivery permits -- and the
 * reader is nonetheless correct one notification later, because the append after
 * it carries a token the reader has never seen.
 */
import {
	openIndexer,
	openMemoryGenerationRegistry,
	type LastSync,
	type LogEvent,
	type StateMoved,
} from '@etherfold/core';
import {EntityEventProcessor, openForWriting, type EntityStateView} from '@etherfold/processor-entities';
import {MemoryStateStore, type EntityId} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {BASE_ABANDONED, loadStream, replayIntoStore, stratagemsProcessor, type TouchedIds} from '../src/index.js';
import type {StratagemsABI} from '../vendor/stratagems/abi.js';
import {identityOf} from './utils/processorIdentity.js';

const CHAIN_ID_HEX = '0x2105'; // 8453, the chain the capture is from
const FINALITY = 12;

/**
 * The identity this fold runs under, HANDED over the way an arrival hands one
 * (ADR-0086: derived from bytes, never declared by the author).
 *
 * The subject here is the RETRACTION -- the fork point a reader is told about and
 * the token that moved -- so the fold's name is only ever what a notification
 * quotes. It is supplied rather than left to the declared `version` the stratagems
 * processor still carries, because a deployment that supplies nothing is named by
 * a value `the-declared-version-and-the-drift-report-are-deleted` removes.
 */
const PROCESSOR_IDENTITY = identityOf('stratagems-retraction');

/**
 * The block the chain takes back, the fork point that leaves, and the height its
 * transactions come back at.
 *
 * The withdrawn one is the capture's LAST and busiest block -- 31 real logs, six
 * entities touched -- quoted as a literal for the same reason `alpha1.test.ts`
 * quotes its fork block: the case is a fact about a chain, and a computed
 * midpoint would drift into meaning something else.
 *
 * The capture has no block after it, so the block that arrives NEXT is one the
 * chain is made to mine here: real captured logs of a `CommitmentMade`,
 * re-stamped at a later height, which is what a transaction that went back to
 * the mempool and was re-mined looks like. That block touches ONE entity, and
 * the withdrawn block touched six -- which is the whole hazard, as data: the
 * five it does not name are exactly the ones a reader invalidating narrowly is
 * never told to re-read.
 */
const WITHDRAWN_BLOCK = 11_704_357;
const FORK_POINT = WITHDRAWN_BLOCK - 1;
const REMINED_BLOCK = WITHDRAWN_BLOCK + 13;
const REMINED_FROM = 11_683_311;

/**
 * A node that answers the identity and the tip, and refuses everything else.
 *
 * Typed `as never` at the boundary, as the container's own tests do: this
 * package does not depend on `eip-1193` and has no business acquiring one to
 * hand over two canned answers. Nothing here indexes from the node anyway --
 * every batch is FED -- so the tip it reports is only ever read at `load`.
 */
function fakeNode(tip: number) {
	return {
		async request(args: {method: string}): Promise<unknown> {
			switch (args.method) {
				case 'eth_chainId':
					return CHAIN_ID_HEX;
				case 'eth_blockNumber':
					return `0x${tip.toString(16)}`;
				default:
					throw new Error(`unexpected method ${args.method}`);
			}
		},
	} as never;
}

/** THE FOLD, THE CHAIN'S FOUR MOVES, AND EVERYTHING A READER WAS TOLD. */
async function foldThroughAReorg() {
	const fixture = loadStream(BASE_ABANDONED);
	const registry = await openMemoryGenerationRegistry({maxGenerations: 2, maxStreams: 1});
	const indexer = await openIndexer<StratagemsABI, EntityStateView>({
		registry,
		provider: fakeNode(fixture.lastSync.latestBlock),
		source: fixture.source,
		config: {stream: {finality: FINALITY}},
		generations: [
			{
				createState: () => openForWriting(new MemoryStateStore(stratagemsProcessor.entities)),
				createProcessor: (store) => new EntityEventProcessor(store, stratagemsProcessor),
				processorIdentity: PROCESSOR_IDENTITY,
				stateOf: (processor) => (processor as EntityEventProcessor<StratagemsABI>).state,
			},
		],
	});

	const moved: StateMoved[] = [];
	indexer.onStateMoved((notification) => moved.push(notification));
	await indexer.load();

	const at = (block: number) => fixture.eventStream.filter((event) => event.blockNumber === block);
	const below = (block: number) => fixture.eventStream.filter((event) => event.blockNumber < block);

	/**
	 * The same transactions, mined again at a later height: what the chain does with
	 * the contents of a block it dropped.
	 *
	 * The LOGS are the capture's own, so the handlers that run are the real ones on
	 * real arguments; what is synthesised is the block they sit in, because a
	 * capture of a chain that did not reorg cannot contain the branch it did not
	 * take.
	 */
	const reminedAt = (
		block: number,
		hash: `0x${string}`,
		events: LogEvent<StratagemsABI>[],
	): LogEvent<StratagemsABI>[] =>
		events.map((event, index) => ({
			...event,
			blockNumber: block,
			blockHash: hash,
			blockTimestamp: (event.blockTimestamp ?? 0) + 12 * (block - event.blockNumber),
			logIndex: index,
		}));

	/**
	 * A FETCH, as the engine takes one: complete over `[from, to]`, carrying no
	 * verdicts. The context is the fixture's, because the identity is the same
	 * whichever slice of the stream this is.
	 */
	const fetched = (from: number, to: number): LastSync<StratagemsABI> => ({
		context: fixture.lastSync.context,
		lastFromBlock: from,
		lastToBlock: to,
		latestBlock: to,
		unconfirmedBlocks: [],
	});
	const feed = (events: LogEvent<StratagemsABI>[], from: number, to: number) => indexer.feed(events, fetched(from, to));

	return {fixture, indexer, moved, at, below, feed, reminedAt};
}

/** Every business key the whole capture writes, which is this reader's QUERY. */
async function everyTouchedId(fixture: ReturnType<typeof loadStream>): Promise<TouchedIds> {
	const store = await openForWriting(new MemoryStateStore(stratagemsProcessor.entities));
	const report = await replayIntoStore(store, stratagemsProcessor, fixture.eventStream);
	return report.touched;
}

/** What the state ANSWERS right now, for the entities asked about. */
async function readThrough(
	state: EntityStateView,
	touched: TouchedIds,
	entities: readonly string[],
): Promise<Map<string, unknown>> {
	const rows = new Map<string, unknown>();
	for (const entity of entities) {
		for (const [key, id] of touched.get(entity) ?? new Map<string, EntityId>()) {
			rows.set(`${entity}/${key}`, (await state.getCurrent(entity, id)) ?? null);
		}
	}
	return rows;
}

/**
 * A READER, as ADR-0083 describes one: it holds a token and what it last read,
 * and its whole rule is two lines.
 *
 * It re-reads THROUGH the surface it already has (`indexer.state`), because this
 * is a SIGNAL and nothing is delivered to it. The refetch lands a moment after
 * the notification -- `settle()` is that moment -- which is what a real reader
 * does too, since a handler cannot await.
 *
 * `compareTheToken: false` removes the FIRST of the two lines, and that reader is
 * not a straw man: it is exactly what "a missed notification is repaired by the
 * next one" produces when the missed one was a retraction.
 */
function renderingReader(state: EntityStateView, touched: TouchedIds, options: {compareTheToken?: boolean} = {}) {
	const compareTheToken = options.compareTheToken !== false;
	const queue: StateMoved[] = [];
	let rows = new Map<string, unknown>();
	let held: string | undefined;
	let wholesale = 0;
	return {
		/** What it would render if asked right now. */
		get rendering(): Map<string, unknown> {
			return rows;
		},
		get invalidatedEverything(): number {
			return wholesale;
		},
		receive(notification: StateMoved): void {
			queue.push(notification);
		},
		async settle(): Promise<void> {
			while (queue.length > 0) {
				const notification = queue.shift() as StateMoved;
				if (compareTheToken && notification.coherence !== held) {
					held = notification.coherence;
					wholesale++;
					// TOKEN CHANGED -> invalidate EVERYTHING.
					rows = await readThrough(state, touched, [...touched.keys()]);
					continue;
				}
				held = notification.coherence;
				// TOKEN UNCHANGED -> invalidate NARROWLY, using the names it was given.
				if (notification.kind !== 'applied') continue;
				for (const [key, value] of await readThrough(state, touched, notification.entities)) {
					rows.set(key, value);
				}
			}
		},
	};
}

/**
 * Which rows two readings DISAGREE about, keyed `<entity>/<business key>`.
 *
 * A list rather than a boolean, because the interesting question is not only
 * WHETHER a reader is stale but WHICH entities it is stale about: the rows a
 * narrow invalidator gets wrong are precisely the ones no changed-set after the
 * reorg ever names.
 */
function differences(left: Map<string, unknown>, right: Map<string, unknown>): string[] {
	const keys = new Set([...left.keys(), ...right.keys()]);
	return [...keys].filter((key) => JSON.stringify(left.get(key), bigints) !== JSON.stringify(right.get(key), bigints));
}

const bigints = (_key: string, value: unknown) => (typeof value === 'bigint' ? `${value}n` : value);

describe('a reorg over the stratagems capture publishes a retraction naming its fork point', () => {
	it(`publishes ONE retraction naming block ${FORK_POINT.toLocaleString('en-US')}, with a token that MOVED`, async () => {
		const {moved, at, below, feed, reminedAt} = await foldThroughAReorg();

		// everything below the block the chain is about to take back...
		await feed(below(WITHDRAWN_BLOCK), 11_681_917, WITHDRAWN_BLOCK - 1);
		// ...then that block, which lands inside the reorg window...
		await feed(at(WITHDRAWN_BLOCK), WITHDRAWN_BLOCK - FINALITY - 1, WITHDRAWN_BLOCK);
		const beforeTheReorg = moved.length;
		const tokenBefore = moved[beforeTheReorg - 1].coherence;
		expect(new Set(moved.map((notification) => notification.coherence)).size).toBe(1);

		// ...and now the chain re-delivers that range with those logs GONE and one of
		// its transactions re-mined higher up. That is the ABSENCE case, which the
		// engine INFERS: the block is simply not in the re-delivered range, and the
		// fold has to take it back.
		await feed(
			reminedAt(REMINED_BLOCK, '0xreminedcommitment', at(REMINED_FROM)),
			WITHDRAWN_BLOCK - FINALITY,
			REMINED_BLOCK + 1,
		);

		const published = moved.slice(beforeTheReorg);
		expect(published.map((notification) => notification.kind)).toEqual(['retracted', 'applied']);
		const retraction = published[0];
		// THE FORK POINT THE FOLD ACTUALLY REVERTED TO: `applyEventStream` computed
		// it from the `removed` markers the engine derived, and handed exactly this
		// number to `revertTo`.
		expect(retraction.kind === 'retracted' && retraction.forkPoint).toBe(FORK_POINT);
		// no block, no entity set: a rotated token means invalidate everything
		expect(Object.keys(retraction).sort()).toEqual(['coherence', 'forkPoint', 'generation', 'kind']);
		expect(retraction.coherence).not.toBe(tokenBefore);
		// and the append that follows it carries the same NEW token, naming only what
		// the replacement block touched -- which is one entity where the withdrawn
		// block touched six
		const append = published[1];
		expect(append.coherence).toBe(retraction.coherence);
		expect(append.kind === 'applied' && append.entities).toEqual(['commitment']);
	});

	it('converges a reader that NEVER SAW the retraction, one notification later', async () => {
		const {fixture, indexer, at, below, feed, reminedAt} = await foldThroughAReorg();
		const touched = await everyTouchedId(fixture);
		const state = indexer.state;

		const reader = renderingReader(state, touched);
		const keptTheToken = renderingReader(state, touched, {compareTheToken: false});
		indexer.onStateMoved((notification) => {
			// LOST IN TRANSIT. Best-effort delivery permits exactly this, and the
			// producer holds nothing per client, so nothing will ever re-send it.
			if (notification.kind === 'retracted') return;
			reader.receive(notification);
			keptTheToken.receive(notification);
		});

		await feed(below(WITHDRAWN_BLOCK), 11_681_917, WITHDRAWN_BLOCK - 1);
		await feed(at(WITHDRAWN_BLOCK), WITHDRAWN_BLOCK - FINALITY - 1, WITHDRAWN_BLOCK);
		await reader.settle();
		await keptTheToken.settle();

		// both readers are rendering the branch the chain is about to abandon, and
		// they agree with the fold about every row of it
		const abandoned = await readThrough(state, touched, [...touched.keys()]);
		expect(abandoned.size).toBeGreaterThan(0);
		expect(differences(reader.rendering, abandoned)).toEqual([]);
		expect(differences(keptTheToken.rendering, abandoned)).toEqual([]);
		const wholesaleBefore = reader.invalidatedEverything;

		// THE REORG, and the ONE ordinary append that comes with it
		await feed(
			reminedAt(REMINED_BLOCK, '0xreminedcommitment', at(REMINED_FROM)),
			WITHDRAWN_BLOCK - FINALITY,
			REMINED_BLOCK + 1,
		);
		await reader.settle();
		await keptTheToken.settle();

		// the fold really did withdraw something a reader could see
		const canonical = await readThrough(state, touched, [...touched.keys()]);
		expect(differences(canonical, abandoned).length).toBeGreaterThan(0);

		// THE PROPERTY: the reader that missed the retraction is correct anyway,
		// because the ONE append it did receive carried a token it had never seen
		expect(reader.invalidatedEverything).toBe(wholesaleBefore + 1);
		expect(differences(reader.rendering, canonical)).toEqual([]);

		// and this is what the token BOUGHT: the same reader without it is still
		// rendering rows from the branch the chain abandoned -- and every one of them
		// belongs to an entity the append after the reorg never named, which is why no
		// later changed-set would have repaired it either
		const stale = differences(keptTheToken.rendering, canonical);
		expect(stale.length).toBeGreaterThan(0);
		expect(stale.filter((key) => key.startsWith('commitment/'))).toEqual([]);
	});
});
