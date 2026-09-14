import {
	generationDigestOf,
	openReceivingIndexer,
	type GenerationId,
	type HeldFold,
	type LogEvent,
	type ReceivingIndexer,
	type WireBatch,
} from '@etherfold/core';
import {
	entityProcessorVersionHash,
	EntityEventProcessor,
	type EntityProcessor,
	openForWriting,
	type StateStore,
	type WritableStateStore,
} from '@etherfold/processor-entities';
import {
	applySchema,
	EMISSION_STREAM_TABLE,
	emissionAppenderFor,
	GENERATION_TABLE,
	generationRegistryPortOnSQL,
	storedEmissionReplaySource,
	type SQLGenerationRegistryOptions,
} from '@etherfold/server';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {createClient} from '@libsql/client';
import type {IndexingSource} from '@etherfold/core';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {abi, ALICE, BOB, CONTRACT, nftEntities, nftProcessor, START_BLOCK, timestampOf, ZERO} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// A SUCCESSOR THAT WAS NEVER CANONICAL IS DROPPED WHEN A NEWER ONE TAKES ITS ROLE
// ---------------------------------------------------------------------------------------------------
// The container knew ONE kind of supersession and it is a PROMOTION: the
// incumbent becomes the predecessor and is RETAINED, because the pointer must be
// able to move back to it. The other half was missing -- a successor that is
// still catching up and that a NEWER successor has just made pointless kept its
// registry row, its state namespace and its place in the scheduled rebuild -- so
// a developer changing their mind a few times in a row reached the generation
// cap and had to delete generations by hand. A cap is the right mechanism
// against slow accumulation and the wrong one against CHURN.
//
// The seam asserted here is the one the behaviour actually lives at: ONE
// container over a REAL database, `add`ed to several times in a row, with the
// generation registry, the stored emission stream and every generation's state
// namespace sharing the single libSQL handle a `run` / `index` deployment has.
// What only this level can say:
//
//  - what the REGISTRY holds after a run of changes (rows, not objects);
//  - that the DISK comes back -- the dropped generation's table namespace is
//    really gone (ADR-0053 makes deleting a generation a `DROP`), and its stream
//    is reaped when no registered generation is left folding it;
//  - that a REVERT can still reach what it could reach before, which is the
//    property that makes the whole thing safe;
//  - that the caps are never REACHED by churn, on both axes -- `maxGenerations`
//    under processor changes and `maxStreams` under source changes, which is the
//    one the cross-stream rule exists for.
//
// The predicate under all of it is NOT "not canonical right now" -- a predecessor
// kept for a revert is not canonical right now either. It is "has NEVER been
// canonical", answered in memory from what THIS container has registered and
// seen since it opened, which is why the last case here asserts that a restart
// drops nothing at all.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'alpha';
const FINALITY = 3;

/** The same fold at several versions: the SAME logs, a different generation each time. */
const versions = ['1.0.0', '2.0.0', '3.0.0', '4.0.0', '5.0.0'] as const;
const [V1, V2, V3, V4, V5] = versions.map((version) => ({...nftProcessor, version}) as EntityProcessor<typeof abi>) as [
	EntityProcessor<typeof abi>,
	EntityProcessor<typeof abi>,
	EntityProcessor<typeof abi>,
	EntityProcessor<typeof abi>,
	EntityProcessor<typeof abi>,
];

/** A DIFFERENT fetch filter is a different STREAM, which is what a SOURCE change makes. */
const OTHER_CONTRACT = '0x0000000000000000000000000000000000000088' as const;
const THIRD_CONTRACT = '0x0000000000000000000000000000000000000077' as const;
const FOURTH_CONTRACT = '0x0000000000000000000000000000000000000066' as const;

const SOURCE_A: IndexingSource<typeof abi> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};
const sourceOn = (address: `0x${string}`): IndexingSource<typeof abi> => ({
	chainId: '1',
	contracts: [{abi, address, startBlock: START_BLOCK}],
});

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/** ONE FOLD, as the CLI's own `openFolding` builds one: its own state namespace, then the processor. */
function specFor(db: RemoteSQL, declared: EntityProcessor<typeof abi>, source?: IndexingSource<typeof abi>) {
	return {
		...(source ? {source} : {}),
		// CLAIMED, because this fold WRITES: the ability to mutate is obtained by
		// claiming (ADR-0077), exactly as `buildFolding` does it.
		createState: (context: {stream: string}) =>
			openForWriting(
				new VersionedStateStore(db, declared.entities, {
					tableNamespace: generationDigestOf({
						stream: context.stream,
						processor: entityProcessorVersionHash(declared),
					}),
					finalityDepth: FINALITY,
				}),
			),
		createProcessor: (state: WritableStateStore) =>
			new EntityEventProcessor<typeof abi>(state, declared, {finalityDepth: FINALITY}),
	};
}

/**
 * THE HOST ASSEMBLY: one named indexer's database, the fold it opened with, and
 * the stream it can re-fold.
 *
 * `replay` is supplied because a processor-change successor is a FOLLOWER
 * (ADR-0044): it gets no receiver and catches up by re-folding the stored stream,
 * and a container given nowhere to read one REFUSES to create it at all.
 */
async function openIndexer(
	db: RemoteSQL,
	declared: EntityProcessor<typeof abi> = V1,
): Promise<ReceivingIndexer<typeof abi, unknown, WritableStateStore>> {
	const dropState: SQLGenerationRegistryOptions['dropState'] = async (id) => {
		await new VersionedStateStore(db, nftEntities, {tableNamespace: generationDigestOf(id)}).drop();
	};
	return openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, INDEXER, {dropState}),
		source: SOURCE_A,
		stream: {finality: FINALITY},
		appendEmissions: emissionAppenderFor(db, INDEXER),
		replay: storedEmissionReplaySource(db, INDEXER),
		generation: specFor(db, declared),
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

/** The generations this database holds under this name, oldest first, by processor version hash. */
async function registeredProcessors(db: RemoteSQL): Promise<string[]> {
	const rows = await db
		.prepare(`SELECT processor FROM ${GENERATION_TABLE} WHERE indexer = ?1 ORDER BY createdAt`)
		.bind(INDEXER)
		.all<{processor: string}>();
	return rows.results.map((row) => row.processor);
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

/** What a fold concluded, read back through the store it wrote. */
async function ownerOf(store: StateStore, id: string): Promise<string | undefined> {
	return (await store.getCurrent<{owner: string}>('nft', {tokenID: id.padStart(78, '0')}))?.owner;
}

const idOf = (fold: {record: {stream: string; processor: string}}): GenerationId => ({
	stream: fold.record.stream,
	processor: fold.record.processor,
});

/** A deployment that has folded: the incumbent is canonical, and its stream is stored. */
async function aDeploymentThatHasFolded(db: RemoteSQL) {
	await applySchema(db);
	const indexer = await openIndexer(db);
	await feed(indexer.opening, {address: CONTRACT, toBlock: START_BLOCK + 100, to: ALICE, id: 1n});
	return indexer;
}

describe('a run of changes leaves ONE successor catching up', () => {
	it('drops the successor a newer successor replaced, so three changes in a row leave two generations', async () => {
		const db = oneDatabase();
		const indexer = await aDeploymentThatHasFolded(db);

		// three processor changes in a row, which is the ordinary save-and-rebuild loop
		const second = await indexer.add(specFor(db, V2));
		const secondNamespace = await namespaceTables(db, idOf(second));
		expect(secondNamespace.length).toBeGreaterThan(0);

		const third = await indexer.add(specFor(db, V3));
		const fourth = await indexer.add(specFor(db, V4));

		// ONE successor is left catching up, and it is the NEWEST one
		expect(await registeredProcessors(db)).toEqual([indexer.generation.processor, fourth.record.processor]);
		expect(indexer.held().map((fold) => fold.record.processor)).toEqual([
			indexer.generation.processor,
			fourth.record.processor,
		]);
		expect(third.record.processor).not.toBe(fourth.record.processor);

		// and the DISK came back: a dropped generation's state is its table namespace,
		// so dropping it is a `DROP` and not an unregistration (ADR-0053)
		expect(await namespaceTables(db, idOf(second))).toEqual([]);
		expect(await namespaceTables(db, idOf(third))).toEqual([]);
		expect((await namespaceTables(db, idOf(fourth))).length).toBeGreaterThan(0);
	});

	it('leaves the CANONICAL generation and its stream exactly where they were', async () => {
		const db = oneDatabase();
		const indexer = await aDeploymentThatHasFolded(db);
		const stored = await emissionRows(db, indexer.streamDigest);
		expect(stored).toBe(1);

		await indexer.add(specFor(db, V2));
		await indexer.add(specFor(db, V3));

		expect(await indexer.canonical()).toMatchObject(indexer.generation);
		expect(await ownerOf(indexer.state, '1')).toBe(ALICE);
		// the incumbent WRITES the stream both successors re-fold, so nothing dropped
		// may touch it: retiring a follower never disturbs the generation that writes
		// its stream (ADR-0044)
		expect(indexer.writesStream).toBe(true);
		expect(await emissionRows(db, indexer.streamDigest)).toBe(stored);
		expect((await namespaceTables(db, indexer.generation)).length).toBeGreaterThan(0);
	});
});

describe('a generation the pointer has NAMED is never dropped by this path', () => {
	it('keeps the predecessor a revert needs, and the revert still reaches the state it left', async () => {
		const db = oneDatabase();
		const indexer = await aDeploymentThatHasFolded(db);
		const incumbent = indexer.generation;

		// the ordinary upgrade: a successor is promoted, and the generation it
		// superseded is RETAINED so the pointer can move back to it
		const promoted = await indexer.add(specFor(db, V2));
		await indexer.promote(idOf(promoted));
		expect(await indexer.canonical()).toMatchObject(idOf(promoted));

		// ...and then the developer changes their mind twice more. The predecessor is
		// NOT canonical right now, which is exactly why "not canonical right now" is
		// the wrong predicate: it is what story 4 promises.
		await indexer.add(specFor(db, V3));
		const fourth = await indexer.add(specFor(db, V4));

		expect(await registeredProcessors(db)).toEqual([
			incumbent.processor,
			promoted.record.processor,
			fourth.record.processor,
		]);
		expect((await namespaceTables(db, incumbent)).length).toBeGreaterThan(0);

		// the way BACK is still real: one small write, and the state it named is where
		// it was left
		await indexer.promote(incumbent);
		expect(await indexer.canonical()).toMatchObject(incumbent);
		expect(await ownerOf(indexer.state, '1')).toBe(ALICE);
	});

	it('never drops a generation THIS container did not register, which is what a restart is', async () => {
		const db = oneDatabase();
		const first = await aDeploymentThatHasFolded(db);
		const successor = await first.add(specFor(db, V2));

		// a RESTART is a new container over the same rows, and it has seen nothing: the
		// ever-canonical fact is in memory (ADR-0057), so a fold it did not register is
		// one it cannot know was never canonical. Nothing is dropped, and the cap stays
		// the mechanism on that path -- refusing at start-up, where an operator reads it.
		const restarted = await openIndexer(db, V1);
		await restarted.add(specFor(db, V3));
		await restarted.add(specFor(db, V4));

		const held = await registeredProcessors(db);
		expect(held).toContain(successor.record.processor);
		expect((await namespaceTables(db, idOf(successor))).length).toBeGreaterThan(0);
		// what it DOES bound is its own churn: of the two successors it registered
		// itself, one is left
		expect(held).toEqual([first.generation.processor, successor.record.processor, entityProcessorVersionHash(V4)]);
	});
});

describe('the caps are never REACHED by churn, and they are UNCHANGED', () => {
	it('keeps registering through a run of processor changes instead of refusing at maxGenerations', async () => {
		const db = oneDatabase();
		const indexer = await aDeploymentThatHasFolded(db);
		expect(indexer.caps).toEqual({maxGenerations: 4, maxStreams: 2});

		// far more saves than the bound, and not one of them is refused
		for (const declared of [V2, V3, V4, V5, V2, V3, V4, V5]) {
			await indexer.add(specFor(db, declared));
		}

		expect((await registeredProcessors(db)).length).toBe(2);
		expect(indexer.caps).toEqual({maxGenerations: 4, maxStreams: 2});
	});

	it('frees the STREAM slot too, because a source change is a new stream and the cap counts streams', async () => {
		const db = oneDatabase();
		const indexer = await aDeploymentThatHasFolded(db);

		// a SOURCE change makes a new stream, so two of them reach `maxStreams` of 2
		// with the generations still well under their own bound. This is what the
		// cross-stream rule exists for: the previous never-canonical successor is
		// dropped whatever stream it sits on.
		const onB = await indexer.add(specFor(db, V2, sourceOn(OTHER_CONTRACT)));
		await feed(onB, {address: OTHER_CONTRACT, toBlock: START_BLOCK + 20, to: BOB, id: 2n});
		expect(await emissionRows(db, onB.streamDigest)).toBe(1);
		expect(onB.writesStream).toBe(true);

		const onC = await indexer.add(specFor(db, V3, sourceOn(THIRD_CONTRACT)));
		const onD = await indexer.add(specFor(db, V4, sourceOn(FOURTH_CONTRACT)));

		expect(await registeredProcessors(db)).toEqual([indexer.generation.processor, onD.record.processor]);
		expect(await indexer.registry.streams()).toEqual(
			[indexer.streamDigest, onD.streamDigest].sort((a, b) => a.localeCompare(b)),
		);
		// the dropped successor's own stream was reaped with it, no registered
		// generation being left folding it
		expect(await emissionRows(db, onB.streamDigest)).toBe(0);
		expect(await namespaceTables(db, idOf(onB))).toEqual([]);
		expect(await namespaceTables(db, idOf(onC))).toEqual([]);
		// and the canonical generation's own stream is untouched
		expect(await emissionRows(db, indexer.streamDigest)).toBe(1);
	});

	it('DECLINES the drop while another held fold follows the dropped one\u2019s stream, then takes it', async () => {
		const db = oneDatabase();
		const indexer = await aDeploymentThatHasFolded(db);

		// the scenario the observation opens with: the SOURCE change lands first, and
		// the processor follows a moment later on that same new stream
		const onB = await indexer.add(specFor(db, V2, sourceOn(OTHER_CONTRACT)));
		await feed(onB, {address: OTHER_CONTRACT, toBlock: START_BLOCK + 20, to: BOB, id: 2n});
		const alsoOnB = await indexer.add(specFor(db, V3, sourceOn(OTHER_CONTRACT)));

		// the older one is abandoned, but it WRITES the stream the newer one follows,
		// and dropping it would leave that one folding a stream nothing appends to
		// (ADR-0044). So it is RETAINED, and the one-writer rule is untouched.
		expect(alsoOnB.follows).toBe(true);
		expect(onB.writesStream).toBe(true);
		expect(await registeredProcessors(db)).toEqual([
			indexer.generation.processor,
			onB.record.processor,
			alsoOnB.record.processor,
		]);
		expect(await emissionRows(db, onB.streamDigest)).toBe(1);

		// ...and when the next change moves off that stream entirely, BOTH go in one
		// pass: the follower first, which is what leaves the writer free to go too
		const onC = await indexer.add(specFor(db, V4, sourceOn(THIRD_CONTRACT)));
		expect(await registeredProcessors(db)).toEqual([indexer.generation.processor, onC.record.processor]);
		expect(await emissionRows(db, onB.streamDigest)).toBe(0);
		expect(await namespaceTables(db, idOf(onB))).toEqual([]);
		expect(await namespaceTables(db, idOf(alsoOnB))).toEqual([]);
	});
});
