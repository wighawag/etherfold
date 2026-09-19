import {
	generationDigestOf,
	openReceivingIndexer,
	unslottedGenerations,
	type GenerationId,
	type HeldFold,
	type IndexingSource,
	type LogEvent,
	type ReceivingIndexer,
	type WireBatch,
} from '@etherfold/core';
import {
	EntityEventProcessor,
	openForWriting,
	type EntityProcessor,
	type StateStore,
	type WritableStateStore,
} from '@etherfold/processor-entities';
import {
	applySchema,
	EMISSION_STREAM_TABLE,
	emissionAppenderFor,
	generationRegistryPortOnSQL,
	storedEmissionReplaySource,
	type SQLGenerationRegistryOptions,
} from '@etherfold/server';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {abi, ALICE, BOB, CONTRACT, nftEntities, nftProcessor, START_BLOCK, timestampOf, ZERO} from './utils/chain.js';
import {identityOf} from './utils/processorIdentity.js';
import {generationStateSeamsOn} from './utils/generationState.js';

// ---------------------------------------------------------------------------------------------------
// A GENERATION NO SLOT NAMES IS RECLAIMED ON REQUEST (ADR-0084)
// ---------------------------------------------------------------------------------------------------
// A cap REFUSES at its bound and never evicts, which is sound and was the ONLY
// instrument an operator had: when it fires they are told what they COULD delete
// and handed nothing to delete it with, so the remedy was hand-written SQL or a
// deleted database. Slots make the missing verb expressible for the first time --
// a generation NO SLOT NAMES is garbage by definition rather than by an
// operator's judgement about digests and timestamps -- and the deletion itself is
// nothing new: it is the registry's own drop, which takes the row, the state
// NAMESPACE (ADR-0053 makes that a `DROP`) and the stream where no registered
// generation is left folding it.
//
// The seam asserted here is the one the behaviour lives at: ONE container over a
// REAL database, holding a canonical generation, a pending successor, a
// predecessor and a generation no slot names, with every generation's state
// namespace and the stored emission stream sharing the single libSQL handle a
// `run` / `index` deployment has. What only this level can say:
//
//  - WHICH survive and which go, against the slot ROWS rather than an object;
//  - what the DISK shows afterwards -- the reclaimed generation's namespace is
//    really gone and its stream is really reaped, with the records that came back
//    NAMED rather than counted;
//  - that a REVERT TARGET is never reclaimed, and still answers afterwards from
//    the state it folded, which is the property that makes a verb that DELETES
//    safe to run;
//  - that the decline is the existing one: the writer of a stream another held
//    fold follows is retained, and says so;
//  - that reclaiming NOTHING is a success that says so.
//
// What it is NOT is a garbage COLLECTOR. Nothing here fires on a timer or at
// `open`: every reclaim below is a call, because an automatic one deletes with
// nobody present and ADR-0084 does not make that decision.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'alpha';
const FINALITY = 3;

/**
 * THE SAME FOLD AS SEVERAL ARRIVALS: the SAME logs, a different generation each
 * time.
 *
 * What makes each one a different generation is the identity its arrival derived
 * (ADR-0086) -- the hash of the bytes it was read as -- and never a field the
 * author bumped. They share one declared object precisely to say so.
 */
const [V1, V2, V3, V4] = (['first', 'second', 'third', 'fourth'] as const).map((marker) => identityOf(marker)) as [
	string,
	string,
	string,
	string,
];

/** A DIFFERENT fetch filter is a different STREAM, which is what a SOURCE change makes. */
const OTHER_CONTRACT = '0x0000000000000000000000000000000000000088' as const;

const SOURCE_A: IndexingSource<typeof abi> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};
const SOURCE_B: IndexingSource<typeof abi> = {
	chainId: '1',
	contracts: [{abi, address: OTHER_CONTRACT, startBlock: START_BLOCK}],
};

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/**
 * ONE FOLD, as the CLI's own `openFolding` builds one: its own state namespace,
 * then the processor.
 *
 * `identity` is what the ARRIVAL supplied, and it is handed to BOTH halves --
 * the namespace named before the processor exists (ADR-0053) and the fold itself
 * -- so the registry record, the tables and the engine cannot answer to three
 * different names.
 */
function specFor(db: RemoteSQL, identity: string, source?: IndexingSource<typeof abi>) {
	const declared: EntityProcessor<typeof abi> = nftProcessor;
	return {
		...(source ? {source} : {}),
		createState: (context: {stream: string}) =>
			openForWriting(
				new VersionedStateStore(db, declared.entities, {
					tableNamespace: generationDigestOf({stream: context.stream, processor: identity}),
					finalityDepth: FINALITY,
				}),
			),
		createProcessor: (state: WritableStateStore) =>
			new EntityEventProcessor<typeof abi>(state, declared, {finalityDepth: FINALITY}),
		processorIdentity: identity,
	};
}

/**
 * THE HOST ASSEMBLY: one named indexer's database, the fold it opened with, and
 * the stream it can re-fold.
 *
 * Called a SECOND time over the same database, this is what a RESTART is: a fresh
 * container, an empty memory, the same rows.
 */
async function openIndexer(
	db: RemoteSQL,
	identity: string = V1,
	source: IndexingSource<typeof abi> = SOURCE_A,
): Promise<ReceivingIndexer<typeof abi, unknown, WritableStateStore>> {
	// BOTH state seams, under the namespace convention `openFolding` uses: the DROP
	// of a generation's namespace, and the READ of how far the fold in it got -- which
	// is what the promotion trigger compares, with no engine and for a generation this
	// process may hold no fold for.
	const state = generationStateSeamsOn(db, nftEntities);
	return openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, INDEXER, state),
		source,
		stream: {finality: FINALITY},
		appendEmissions: emissionAppenderFor(db, INDEXER),
		replay: storedEmissionReplaySource(db, INDEXER),
		generation: specFor(db, identity, source),
	}) as Promise<ReceivingIndexer<typeof abi, unknown, WritableStateStore>>;
}

let logCounter = 0;

/** One decoded `Transfer` at an address, so a batch for one stream is not logs from another. */
function transferEvent(blockNumber: number, address: string, to: string, id: bigint): LogEvent<typeof abi> {
	logCounter++;
	return {
		blockNumber,
		blockHash: `0x${blockNumber.toString(16)}`,
		blockTimestamp: timestampOf(blockNumber),
		transactionIndex: 0,
		removed: false,
		address,
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: 0,
		extra: undefined,
		eventName: 'Transfer',
		args: {from: ZERO, to, id},
	} as unknown as LogEvent<typeof abi>;
}

/** Feed ONE fold through its own receiver, at its own address on the wire. */
async function feed(
	fold: HeldFold<typeof abi, unknown, unknown>,
	over: {address: string; toBlock: number; to: string; id: bigint},
): Promise<void> {
	const receiver = fold.ingestion;
	if (!receiver) throw new Error('this fold FOLLOWS its stream, so it has no receiver to feed');
	const batch: WireBatch<typeof abi> = {
		context: receiver.context,
		fromBlock: START_BLOCK,
		toBlock: over.toBlock,
		latestBlock: over.toBlock,
		logs: [transferEvent(START_BLOCK + 10, over.address, over.to, over.id)],
	};
	await receiver.receive(batch);
}

/** Every table in this database, minus the ones SQLite made for itself. */
async function tablesIn(db: RemoteSQL): Promise<string[]> {
	const rows = await db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
		.all<{name: string}>();
	return rows.results.map((row) => row.name);
}

/** How many tables a generation's own namespace still has (ADR-0053: its state IS its namespace). */
async function namespaceTables(db: RemoteSQL, id: GenerationId): Promise<string[]> {
	const namespace = generationDigestOf(id);
	return (await tablesIn(db)).filter((table) => table.includes(namespace));
}

/** How many stored emissions this stream still holds. */
async function emissionRows(db: RemoteSQL, stream: string): Promise<number> {
	const rows = await db
		.prepare(`SELECT COUNT(*) AS records FROM ${EMISSION_STREAM_TABLE} WHERE indexer = ?1 AND stream = ?2`)
		.bind(INDEXER, stream)
		.all<{records: number}>();
	return Number(rows.results[0]?.records ?? 0);
}

/** What a fold concluded, read back through the namespace it wrote -- with no engine at all. */
async function ownerOf(db: RemoteSQL, id: GenerationId, token: string): Promise<string | undefined> {
	const store: StateStore = new VersionedStateStore(db, nftEntities, {tableNamespace: generationDigestOf(id)});
	return (await store.getCurrent<{owner: string}>('nft', {tokenID: token.padStart(78, '0')}))?.owner;
}

const idOf = (fold: {record: {stream: string; processor: string}}): GenerationId => ({
	stream: fold.record.stream,
	processor: fold.record.processor,
});

type Deployment = {
	db: RemoteSQL;
	/** The deployment as it is RUNNING NOW: the restarted host, holding only its own fold. */
	indexer: ReceivingIndexer<typeof abi, unknown, WritableStateStore>;
	/** The container that performed the two upgrades, which still HOLDS a fold for the garbage. */
	upgraded: ReceivingIndexer<typeof abi, unknown, WritableStateStore>;
	/** The generation NO SLOT NAMES, on a stream of its own: what a reclaim is for. */
	garbage: GenerationId;
	/** What `predecessor` holds: the way back from the upgrade below, which a reclaim must never take. */
	predecessor: GenerationId;
	/** What `canonical` holds: what answers every read. */
	canonical: GenerationId;
	/** What `successor` holds: the fold being built beside the incumbent. */
	successor: GenerationId;
};

/**
 * A DEPLOYMENT THAT HAS BEEN UPGRADED TWICE, which is the ordinary way a
 * generation stops being named by anything.
 *
 * The first fold runs a source of its own, so the generation that falls out of the
 * slots is the only one on its stream -- which is what makes the reclaim REAP a
 * stream as well as a namespace, and therefore what makes "what came back" a
 * question with an answer. Nothing here is contrived: two promotions is what a
 * deployment does over two upgrades, and `predecessor` holds exactly one.
 *
 * The `successor` slot is filled by a RESTART, and that is not incidental either:
 * a registration displaces what the slot held AND what this container holds a fold
 * for and no slot names, so the process that made the garbage would have taken it
 * on the next save. A redeployed host holds no fold for it, which is precisely the
 * deployment an operator is looking at when a cap refuses.
 */
async function aDeploymentUpgradedTwice(): Promise<Deployment> {
	const db = oneDatabase();
	await applySchema(db);

	// the incumbent, on its own stream, which has folded and stored what it folded
	const indexer = await openIndexer(db, V1, SOURCE_A);
	await feed(indexer.opening, {address: CONTRACT, toBlock: START_BLOCK + 100, to: ALICE, id: 1n});
	const first = indexer.generation;

	// a SOURCE change: a new stream, its own receiver, and a promotion that makes the
	// first generation the PREDECESSOR -- retained, because the pointer must be able to
	// move back to it
	const second = await indexer.add(specFor(db, V2, SOURCE_B));
	await feed(second, {address: OTHER_CONTRACT, toBlock: START_BLOCK + 20, to: BOB, id: 2n});
	await indexer.promote(idOf(second));

	// ...and a PROCESSOR change over that same stream, promoted in turn. The first
	// generation is now named by NO slot: nothing answers reads from it, nothing
	// reverts to it, and nothing is waiting for it to catch up.
	const third = await indexer.add(specFor(db, V3, SOURCE_B));
	await indexer.promote(idOf(third));

	// ...and the host is REDEPLOYED with a fourth fold, which takes the `successor`
	// slot. It holds no fold for the generation the slots left behind, so it displaces
	// nothing: the deployment now has all three slots filled AND a generation no slot
	// names, which is the state an operator meets a cap in.
	const restarted = await openIndexer(db, V4, SOURCE_B);

	return {
		db,
		indexer: restarted,
		upgraded: indexer,
		garbage: first,
		predecessor: idOf(second),
		canonical: idOf(third),
		successor: restarted.generation,
	};
}

describe('an operator SEES what a deployment holds, slot by slot', () => {
	it('names what each slot holds, and what no slot holds, without matching digests by eye', async () => {
		const {indexer, garbage, predecessor, canonical, successor} = await aDeploymentUpgradedTwice();

		const slots = await indexer.slots();
		expect(slots.canonical).toMatchObject(canonical);
		expect(slots.successor).toMatchObject(successor);
		expect(slots.predecessor).toMatchObject(predecessor);

		// ...and the fourth generation this deployment holds is named by none of them,
		// which is the whole of what makes it collectable: a REFCOUNT, rather than a
		// judgement about which of four digests is safe to delete
		const registered = await indexer.generations();
		expect(registered.length).toBe(4);
		expect(unslottedGenerations(registered, slots).map((record) => record.processor)).toEqual([garbage.processor]);
	});
});

describe('an operator RECLAIMS every generation no slot names, in one action', () => {
	it('takes it, reaps its stream, and says what came back', async () => {
		const {db, indexer, garbage} = await aDeploymentUpgradedTwice();
		expect(await emissionRows(db, garbage.stream)).toBe(1);

		const report = await indexer.reclaim();

		expect(report.outcome).toBe('reclaimed');
		expect(report.declined).toEqual([]);
		expect(report.reclaimed.map((one) => one.generation.processor)).toEqual([garbage.processor]);
		// WHAT CAME BACK, and not merely how many: the stream is the expensive thing,
		// because a public node frequently will not serve those logs again
		expect(report.reclaimed[0]).toMatchObject({reaped: garbage.stream, records: 1});
		// ...and the sentence an operator reads NAMES it, rather than reporting a count
		// that leaves them exactly as uncertain as they were
		expect(report.message).toContain(garbage.processor);
		expect(report.message).toContain(garbage.stream);

		// the DISK came back: a generation's state IS its table namespace (ADR-0053), and
		// the stream went with it, no registered generation being left folding it
		expect(await namespaceTables(db, garbage)).toEqual([]);
		expect(await emissionRows(db, garbage.stream)).toBe(0);
		// ...and it reached a generation this PROCESS was never built with, which is the
		// ordinary operator case and what the durable slot rows make answerable at all
		expect(indexer.held().map((fold) => fold.record.processor)).toEqual([indexer.generation.processor]);
	});

	it('stops DRIVING a fold it reclaimed, rather than folding into state that is gone', async () => {
		const {db, upgraded, garbage} = await aDeploymentUpgradedTwice();
		expect(upgraded.held().some((fold) => fold.record.processor === garbage.processor)).toBe(true);

		const report = await upgraded.reclaim();

		expect(report.reclaimed.map((one) => one.generation.processor)).toEqual([garbage.processor]);
		expect(upgraded.held().some((fold) => fold.record.processor === garbage.processor)).toBe(false);
		expect(await namespaceTables(db, garbage)).toEqual([]);
	});

	it('leaves the CAPS exactly where they were: this is an instrument, not a raised bound', async () => {
		const {indexer} = await aDeploymentUpgradedTwice();
		expect(indexer.caps).toEqual({maxGenerations: 4, maxStreams: 2});

		await indexer.reclaim();

		expect(indexer.caps).toEqual({maxGenerations: 4, maxStreams: 2});
	});
});

describe('a generation ANY slot names is never reclaimed', () => {
	it('keeps the canonical generation, the pending successor and the REVERT TARGET', async () => {
		const {db, indexer, canonical, successor, predecessor} = await aDeploymentUpgradedTwice();

		await indexer.reclaim();

		const registered = await indexer.generations();
		expect(registered.map((record) => record.processor).sort()).toEqual(
			[canonical.processor, successor.processor, predecessor.processor].sort(),
		);
		const slots = await indexer.slots();
		expect(slots.canonical).toMatchObject(canonical);
		expect(slots.successor).toMatchObject(successor);
		expect(slots.predecessor).toMatchObject(predecessor);
		for (const kept of [canonical, successor, predecessor]) {
			expect((await namespaceTables(db, kept)).length).toBeGreaterThan(0);
		}
	});

	it('leaves the way BACK real: the predecessor still answers, from the state it folded', async () => {
		const {db, indexer, predecessor} = await aDeploymentUpgradedTwice();

		await indexer.reclaim();

		// "not canonical right now" is exactly the wrong predicate, and this is why: the
		// predecessor is not canonical and is the undo for the upgrade above. One small
		// write moves the pointer back, and the state it names was never touched.
		const moved = await indexer.promote(predecessor);
		expect(moved).toMatchObject(predecessor);
		expect(await indexer.canonical()).toMatchObject(predecessor);
		expect(await ownerOf(db, predecessor, '2')).toBe(BOB);
	});
});

describe('reclaiming is DECLINED where dropping would strand a fold that follows the stream', () => {
	it('retains the writer another held fold follows, and says why', async () => {
		const db = oneDatabase();
		await applySchema(db);
		const indexer = await openIndexer(db, V1, SOURCE_A);
		await feed(indexer.opening, {address: CONTRACT, toBlock: START_BLOCK + 100, to: ALICE, id: 1n});

		// the source change lands first and stores its stream, then a processor change on
		// that same stream FOLLOWS it -- which takes the `successor` slot and leaves the
		// writer named by no slot, retained because dropping it then would strand the
		// follower (ADR-0044)
		const onB = await indexer.add(specFor(db, V2, SOURCE_B));
		await feed(onB, {address: OTHER_CONTRACT, toBlock: START_BLOCK + 20, to: BOB, id: 2n});
		const alsoOnB = await indexer.add(specFor(db, V3, SOURCE_B));
		expect(alsoOnB.follows).toBe(true);
		expect(onB.writesStream).toBe(true);
		expect(unslottedGenerations(await indexer.generations(), await indexer.slots())).toMatchObject([
			{processor: onB.record.processor},
		]);

		const report = await indexer.reclaim();

		// the same decline the existing drop makes, said out loud rather than performed
		// quietly: the bytes are kept, and the operator is told what to do about it
		expect(report.outcome).toBe('declined');
		expect(report.reclaimed).toEqual([]);
		expect(report.declined.map((one) => one.generation.processor)).toEqual([onB.record.processor]);
		expect(report.declined[0]?.reason).toBe('writes-a-followed-stream');
		expect(report.declined[0]?.message).toContain(onB.streamDigest);
		expect(report.message).toContain(onB.record.processor);

		// ...and NOTHING went: its state and the stream the follower is re-folding are
		// exactly where they were
		expect((await namespaceTables(db, idOf(onB))).length).toBeGreaterThan(0);
		expect(await emissionRows(db, onB.streamDigest)).toBe(1);
		expect((await indexer.generations()).length).toBe(3);
	});
});

describe('reclaiming NOTHING is a success that says it reclaimed nothing', () => {
	it('answers `nothing-to-reclaim` on a deployment every slot accounts for', async () => {
		const db = oneDatabase();
		await applySchema(db);
		const indexer = await openIndexer(db, V1, SOURCE_A);
		await feed(indexer.opening, {address: CONTRACT, toBlock: START_BLOCK + 100, to: ALICE, id: 1n});
		const pending = await indexer.add(specFor(db, V2));

		const report = await indexer.reclaim();

		expect(report.outcome).toBe('nothing-to-reclaim');
		expect(report.reclaimed).toEqual([]);
		expect(report.declined).toEqual([]);
		expect(report.message).toContain('NOTHING was reclaimed');
		// ...and it still says what IS held, because the operator asking what was freed
		// is also asking what is left
		expect(report.slots.canonical).toMatchObject(indexer.generation);
		expect(report.slots.successor).toMatchObject(idOf(pending));
		expect((await indexer.generations()).length).toBe(2);
	});

	it('is distinguishable from having done work, and a second call says so', async () => {
		const {indexer, garbage} = await aDeploymentUpgradedTwice();

		const first = await indexer.reclaim();
		const second = await indexer.reclaim();

		expect(first.outcome).toBe('reclaimed');
		expect(first.reclaimed.map((one) => one.generation.processor)).toEqual([garbage.processor]);
		expect(second.outcome).toBe('nothing-to-reclaim');
		expect(second.reclaimed).toEqual([]);
	});
});
