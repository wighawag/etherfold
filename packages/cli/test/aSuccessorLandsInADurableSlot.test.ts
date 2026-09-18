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
	GENERATION_SLOT_TABLE,
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
import {describe, expect, it, vi} from 'vitest';
import {abi, ALICE, BOB, CONTRACT, nftEntities, nftProcessor, START_BLOCK, timestampOf, ZERO} from './utils/chain.js';
import {identityOf} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------------------------------
// A SUCCESSOR LANDS IN A DURABLE SLOT THAT HOLDS EXACTLY ONE (ADR-0084)
// ---------------------------------------------------------------------------------------------------
// A generation is held by a durable named SLOT, and `canonical` is merely the
// first one. `successor` holds AT MOST ONE, so registering into it REPLACES
// whatever it held; `predecessor` is what a revert moves back to, ASSIGNED by
// the promotion that creates one and never inferred.
//
// It SUPERSEDES the in-memory rule that shipped before it (an "abandoned
// successor" recognised from what one process had registered and seen since it
// opened). That rule was correct and could not be otherwise -- the durable fact
// did not exist, and cannot be derived, because with the pointer at C and a
// newer generation N, "N was never canonical" and "N was canonical and the
// pointer was reverted away from it" are the same rows. Its stated residual was
// that a RESTART recognised nothing and dropped nothing, so a deployment whose
// `version` is generated at build time accumulated one generation per deploy
// until a cap REFUSED it at start-up -- a failure to START rather than a
// degradation. That residual is what this closes, and the restart case below is
// the reason the whole ADR exists.
//
// The seam asserted here is the one the behaviour actually lives at: ONE
// container over a REAL database, with the generation registry, the stored
// emission stream and every generation's state namespace sharing the single
// libSQL handle a `run` / `index` deployment has -- and, for the restart, a
// SECOND CONTAINER opened over the same substrate, which is how the durability
// is asserted without a process boundary. What only this level can say:
//
//  - what the SLOT ROW holds after a run of changes (rows, not objects);
//  - that a FRESH container, having registered nothing and remembered nothing,
//    replaces what it finds in the slot;
//  - that the DISK comes back -- the replaced generation's table namespace is
//    really gone (ADR-0053 makes deleting a generation a `DROP`), and its stream
//    is reaped when no registered generation is left folding it;
//  - that a REVERT can still reach what it could reach before, which is the
//    property that makes the whole thing safe;
//  - that the caps are never REACHED by churn, on both axes.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'alpha';
const FINALITY = 3;

/**
 * THE SAME FOLD AS SEVERAL ARRIVALS: the SAME logs, a different generation each
 * time.
 *
 * Each is the identity of the bytes one build produced (ADR-0086), which is what
 * a save-and-rebuild loop actually moves; the declared object below is shared
 * between them, so nothing an author wrote distinguishes the five.
 */
const [V1, V2, V3, V4, V5] = (['first', 'second', 'third', 'fourth', 'fifth'] as const).map((marker) =>
	identityOf(marker),
) as [string, string, string, string, string];

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
function specFor(db: RemoteSQL, identity: string, source?: IndexingSource<typeof abi>) {
	const declared: EntityProcessor<typeof abi> = nftProcessor;
	return {
		...(source ? {source} : {}),
		// CLAIMED, because this fold WRITES: the ability to mutate is obtained by
		// claiming (ADR-0077), exactly as `buildFolding` does it.
		//
		// The identity the ARRIVAL supplied goes to BOTH halves, so the namespace named
		// before the processor exists (ADR-0053) and the fold that lands in it cannot
		// answer to two different names.
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
 * Called a SECOND time over the same database, this is what a RESTART is: a
 * fresh container, an empty memory, the same rows.
 */
async function openIndexer(
	db: RemoteSQL,
	identity: string = V1,
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
		generation: specFor(db, identity),
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

/**
 * WHAT EACH SLOT HOLDS, read straight off the ROW rather than through the
 * container, because the whole claim is that the fact is durable.
 */
async function slotProcessors(db: RemoteSQL): Promise<Record<string, string | null>> {
	const rows = await db
		.prepare(
			`SELECT canonicalProcessor, successorProcessor, predecessorProcessor
			 FROM ${GENERATION_SLOT_TABLE} WHERE indexer = ?1`,
		)
		.bind(INDEXER)
		.all<{canonicalProcessor: string | null; successorProcessor: string | null; predecessorProcessor: string | null}>();
	const row = rows.results[0];
	return {
		canonical: row?.canonicalProcessor ?? null,
		successor: row?.successorProcessor ?? null,
		predecessor: row?.predecessorProcessor ?? null,
	};
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

describe('the `successor` slot holds ONE, so a second registration replaces the first', () => {
	it('leaves the incumbent plus ONE successor after a run of changes, whatever the run', async () => {
		const db = oneDatabase();
		const indexer = await aDeploymentThatHasFolded(db);

		// three processor changes in a row, which is the ordinary save-and-rebuild loop
		const second = await indexer.add(specFor(db, V2));
		expect((await namespaceTables(db, idOf(second))).length).toBeGreaterThan(0);
		expect(await slotProcessors(db)).toEqual({
			canonical: indexer.generation.processor,
			successor: second.record.processor,
			predecessor: null,
		});

		const third = await indexer.add(specFor(db, V3));
		const fourth = await indexer.add(specFor(db, V4));

		// ONE successor is left catching up, it is the NEWEST one, and the SLOT ROW
		// says so -- which is what a restart will read
		expect(await registeredProcessors(db)).toEqual([indexer.generation.processor, fourth.record.processor]);
		expect(await slotProcessors(db)).toEqual({
			canonical: indexer.generation.processor,
			successor: fourth.record.processor,
			predecessor: null,
		});
		expect(indexer.held().map((fold) => fold.record.processor)).toEqual([
			indexer.generation.processor,
			fourth.record.processor,
		]);

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
		// may touch it: replacing a successor never disturbs the generation that writes
		// its stream (ADR-0044)
		expect(indexer.writesStream).toBe(true);
		expect(await emissionRows(db, indexer.streamDigest)).toBe(stored);
		expect((await namespaceTables(db, indexer.generation)).length).toBeGreaterThan(0);
	});

	it('REPORTS the replacement, naming what went, what took its place and why it was safe', async () => {
		const db = oneDatabase();
		const indexer = await aDeploymentThatHasFolded(db);
		const replaced = await indexer.add(specFor(db, V2));

		const {logs} = await import('named-logs');
		const namedLogger = logs('@etherfold/core');
		const said: string[] = [];
		const spy = vi.spyOn(namedLogger, 'info').mockImplementation((...args: unknown[]) => {
			said.push(String(args[0]));
		});
		try {
			const replacement = await indexer.add(specFor(db, V3));
			// an operator watching a dev loop must see BOUNDED CHURN rather than
			// generations quietly disappearing
			const line = said.find((entry) => entry.includes('REPLACES it there'));
			expect(line).toBeDefined();
			expect(line).toContain(replaced.record.processor);
			expect(line).toContain(replacement.record.processor);
			expect(line).toContain('no slot named it');
		} finally {
			spy.mockRestore();
		}
	});
});

describe('the slot is DURABLE, so a RESTART replaces rather than accumulates', () => {
	it('replaces what it finds in the slot, having registered nothing itself and remembered nothing', async () => {
		const db = oneDatabase();
		const first = await aDeploymentThatHasFolded(db);
		const pending = await first.add(specFor(db, V2));
		expect(await registeredProcessors(db)).toEqual([first.generation.processor, pending.record.processor]);

		// A RESTART is a fresh container over the same rows: it registered nothing, it
		// saw no pointer move, and its memory is empty. Under the in-memory rule this
		// superseded it therefore recognised NOTHING and dropped nothing, and a
		// deployment whose version is generated per build accumulated one generation per
		// deploy. The SLOT is a row, so this one reads what the last one left.
		const restarted = await openIndexer(db, V3);

		expect(await registeredProcessors(db)).toEqual([first.generation.processor, V3]);
		expect(await slotProcessors(db)).toEqual({
			canonical: first.generation.processor,
			successor: V3,
			predecessor: null,
		});
		// the replaced generation's state really went, and the incumbent is untouched
		expect(await namespaceTables(db, idOf(pending))).toEqual([]);
		expect(await restarted.canonical()).toMatchObject(first.generation);
		expect(await ownerOf(first.state, '1')).toBe(ALICE);
		expect(await emissionRows(db, first.streamDigest)).toBe(1);
	});

	it('holds at ONE successor across a run of restarts, which is the redeploy-per-commit loop', async () => {
		const db = oneDatabase();
		const first = await aDeploymentThatHasFolded(db);
		expect(first.caps).toEqual({maxGenerations: 4, maxStreams: 2});

		// far more deploys than the bound, every one of them a fresh process, and not
		// one of them is refused: the cap stops being reachable on this path without
		// being raised
		for (const identity of [V2, V3, V4, V5, V2, V3, V4, V5]) {
			await openIndexer(db, identity);
		}

		expect(await registeredProcessors(db)).toEqual([first.generation.processor, V5]);
		expect(await slotProcessors(db)).toEqual({
			canonical: first.generation.processor,
			successor: V5,
			predecessor: null,
		});
		expect(first.caps).toEqual({maxGenerations: 4, maxStreams: 2});
	});

	it('restarting on the CANONICAL generation registers nothing and displaces nothing', async () => {
		const db = oneDatabase();
		const first = await aDeploymentThatHasFolded(db);
		const pending = await first.add(specFor(db, V2));

		// the ordinary restart of an unchanged deployment: its fold is what `canonical`
		// already names, so it is not a successor to anything and the pending one it
		// finds is not its to replace
		const restarted = await openIndexer(db, V1);

		expect(restarted.generation.processor).toBe(first.generation.processor);
		expect(await registeredProcessors(db)).toEqual([first.generation.processor, pending.record.processor]);
		expect(await slotProcessors(db)).toEqual({
			canonical: first.generation.processor,
			successor: pending.record.processor,
			predecessor: null,
		});
	});
});

describe('a generation a revert needs is never replaced', () => {
	it('assigns `predecessor` on the promotion, and a replacement cannot reach it', async () => {
		const db = oneDatabase();
		const indexer = await aDeploymentThatHasFolded(db);
		const incumbent = indexer.generation;

		// the ordinary upgrade: a successor is promoted, the generation it superseded
		// becomes the PREDECESSOR -- assigned by the move that created one, never
		// inferred -- and the `successor` slot is emptied, because what it named is the
		// incumbent now
		const promoted = await indexer.add(specFor(db, V2));
		await indexer.promote(idOf(promoted));
		expect(await slotProcessors(db)).toEqual({
			canonical: promoted.record.processor,
			successor: null,
			predecessor: incumbent.processor,
		});

		// ...and then the developer changes their mind twice more. The predecessor is
		// NOT canonical right now, which is exactly why "not canonical right now" is the
		// wrong predicate: it is the way back.
		await indexer.add(specFor(db, V3));
		const fourth = await indexer.add(specFor(db, V4));

		expect(await registeredProcessors(db)).toEqual([
			incumbent.processor,
			promoted.record.processor,
			fourth.record.processor,
		]);
		expect(await slotProcessors(db)).toEqual({
			canonical: promoted.record.processor,
			successor: fourth.record.processor,
			predecessor: incumbent.processor,
		});
		expect((await namespaceTables(db, incumbent)).length).toBeGreaterThan(0);

		// the way BACK is still real: one small write, and the state it named is where
		// it was left
		await indexer.promote(incumbent);
		expect(await indexer.canonical()).toMatchObject(incumbent);
		expect(await ownerOf(indexer.state, '1')).toBe(ALICE);
	});

	it('does not replace the revert target when a RESTART registers into the slot', async () => {
		const db = oneDatabase();
		const first = await aDeploymentThatHasFolded(db);
		const incumbent = first.generation;
		const promoted = await first.add(specFor(db, V2));
		await first.promote(idOf(promoted));

		// a fresh process, a third processor, and the only thing it may displace is what
		// `successor` holds -- which is nothing. The predecessor is named by a slot, so
		// it is not reachable from a replacement under any circumstances.
		await openIndexer(db, V3);

		expect(await registeredProcessors(db)).toEqual([incumbent.processor, promoted.record.processor, V3]);
		expect(await slotProcessors(db)).toEqual({
			canonical: promoted.record.processor,
			successor: V3,
			predecessor: incumbent.processor,
		});
		expect((await namespaceTables(db, incumbent)).length).toBeGreaterThan(0);
	});

	it('is an ASSIGNMENT and not an identity: naming what a slot already holds makes no second generation', async () => {
		const db = oneDatabase();
		const first = await aDeploymentThatHasFolded(db);
		const incumbent = first.generation;
		const promoted = await first.add(specFor(db, V2));
		await first.promote(idOf(promoted));

		// a deployment REVERTED by redeploying the previous processor: the content it
		// names is exactly what `predecessor` holds, so it RESOLVES to that one
		// generation rather than creating a second one under a second slot -- one
		// identity, one state namespace, one fold of one stream
		const rolledBack = await openIndexer(db, V1);

		expect(rolledBack.generation).toMatchObject(incumbent);
		expect(await registeredProcessors(db)).toEqual([incumbent.processor, promoted.record.processor]);
		// and it stays where it is: a generation some slot already names is not yanked
		// into `successor` by the act of starting up, or a restart would re-arm exactly
		// what an operator reverted away from
		expect(await slotProcessors(db)).toEqual({
			canonical: promoted.record.processor,
			successor: null,
			predecessor: incumbent.processor,
		});
	});
});

describe('the caps are never REACHED by churn, and they are UNCHANGED', () => {
	it('keeps registering through a run of processor changes instead of refusing at maxGenerations', async () => {
		const db = oneDatabase();
		const indexer = await aDeploymentThatHasFolded(db);
		expect(indexer.caps).toEqual({maxGenerations: 4, maxStreams: 2});

		// far more saves than the bound, and not one of them is refused
		for (const identity of [V2, V3, V4, V5, V2, V3, V4, V5]) {
			await indexer.add(specFor(db, identity));
		}

		expect((await registeredProcessors(db)).length).toBe(2);
		expect(indexer.caps).toEqual({maxGenerations: 4, maxStreams: 2});
	});

	it('frees the STREAM slot too, because a source change is a new stream and the cap counts streams', async () => {
		const db = oneDatabase();
		const indexer = await aDeploymentThatHasFolded(db);

		// a SOURCE change makes a new stream, so two of them reach `maxStreams` of 2
		// with the generations still well under their own bound. There is ONE
		// `successor` slot, so a newer successor replaces the pending one WHEREVER it
		// sits -- which is what frees the stream slot as well.
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
		// the replaced successor's own stream was reaped with it, no registered
		// generation being left folding it
		expect(await emissionRows(db, onB.streamDigest)).toBe(0);
		expect(await namespaceTables(db, idOf(onB))).toEqual([]);
		expect(await namespaceTables(db, idOf(onC))).toEqual([]);
		// and the canonical generation's own stream is untouched
		expect(await emissionRows(db, indexer.streamDigest)).toBe(1);
	});

	it('DECLINES the drop while another held fold follows the replaced one\u2019s stream, then takes it', async () => {
		const db = oneDatabase();
		const indexer = await aDeploymentThatHasFolded(db);

		// the source change lands first, and the processor follows a moment later on
		// that same new stream
		const onB = await indexer.add(specFor(db, V2, sourceOn(OTHER_CONTRACT)));
		await feed(onB, {address: OTHER_CONTRACT, toBlock: START_BLOCK + 20, to: BOB, id: 2n});
		const alsoOnB = await indexer.add(specFor(db, V3, sourceOn(OTHER_CONTRACT)));

		// the older one lost the slot, but it WRITES the stream the newer one follows,
		// and dropping it would leave that one folding a stream nothing appends to
		// (ADR-0044). So it is RETAINED, named by no slot, and the one-writer rule is
		// untouched.
		expect(alsoOnB.follows).toBe(true);
		expect(onB.writesStream).toBe(true);
		expect(await registeredProcessors(db)).toEqual([
			indexer.generation.processor,
			onB.record.processor,
			alsoOnB.record.processor,
		]);
		expect(await slotProcessors(db)).toEqual({
			canonical: indexer.generation.processor,
			successor: alsoOnB.record.processor,
			predecessor: null,
		});
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
