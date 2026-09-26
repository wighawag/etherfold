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
	streamCursorSourceOn,
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
import {
	ALICE,
	BOB,
	CONTRACT,
	START_BLOCK,
	TRANSFER_TOPIC,
	ZERO,
	abi,
	addressTopic,
	nftEntities,
	nftProcessor,
	timestampOf,
} from './utils/chain.js';
import {processorArtifactIdentity} from '@etherfold/utils';
import {bundleOf, identityOf} from './utils/processorIdentity.js';
import {generationStateSeamsOn} from './utils/generationState.js';

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
		// ...and the bytes it is the hash of, which registering stores (ADR-0092)
		bundle: bundleOf(identity),
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
	promotion?: {policy: 'manual'; dropOnPromotion: boolean},
): Promise<ReceivingIndexer<typeof abi, unknown, WritableStateStore>> {
	// BOTH state seams, under the namespace convention `openFolding` uses: the DROP
	// of a generation's namespace, and the READ of how far the fold in it got -- which
	// is what the promotion trigger compares, with no engine and for a generation this
	// process may hold no fold for.
	const state = generationStateSeamsOn(db, nftEntities);
	return openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, INDEXER, state),
		source: SOURCE_A,
		stream: {finality: FINALITY},
		appendEmissions: emissionAppenderFor(db, INDEXER),
		streamCursor: streamCursorSourceOn(db, INDEXER),
		replay: storedEmissionReplaySource(db, INDEXER),
		...(promotion ? {promotion} : {}),
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
		// REAL TOPICS, so a REPLAY can `reparse` this row. It used to be `topics: []`
		// with a pre-decoded `args`, which was enough while a fold was fed by the WIRE:
		// the decoded half arrived with the batch. Since ADR-0087 every generation
		// advances by re-folding the stream the deployment STORED, and a stored row
		// carries the raw log alone (`args` is what SOME ABI made of those bytes,
		// ADR-0034) -- so a fixture with no `topic0` is one no fold can decode.
		topics: [TRANSFER_TOPIC, addressTopic(ZERO), addressTopic(to), `0x${id.toString(16).padStart(64, '0')}`],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: 0,
		extra: undefined,
	} as unknown as LogEvent<typeof abi>;
}

/**
 * Feed ONE fold's STREAM, at that stream's address on the wire.
 *
 * It used to reach for the fold's own receiver. A fold has none since ADR-0087:
 * what answers at a stream's address is the DEPLOYMENT's writer of that stream,
 * and every generation over it reads what that writer stored.
 */
async function feed(
	indexer: ReceivingIndexer<typeof abi, unknown, unknown>,
	fold: HeldFold<typeof abi, unknown, unknown>,
	over: {address: string; toBlock: number; to: string; id: bigint},
): Promise<void> {
	const receiver = (await indexer.liveIngestions()).find((one) => one.streamDigest === fold.streamDigest);
	if (!receiver) throw new Error(`nothing is fetching the stream ${fold.streamDigest}`);
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
 * THE CODE EACH GENERATION KEEPS (ADR-0092), read straight off the rows: every stored
 * bundle under this name, RE-HASHED, so the answer is the identities the bytes name
 * rather than the identities the rows claim. A stored bundle for a generation that
 * has gone, or one whose bytes are not the ones that name it, shows up here as a
 * mismatch against `registeredProcessors`.
 */
async function storedBundleIdentities(db: RemoteSQL): Promise<string[]> {
	const rows = await db
		.prepare(`SELECT bundle FROM ${GENERATION_TABLE} WHERE indexer = ?1 AND bundle IS NOT NULL ORDER BY createdAt`)
		.bind(INDEXER)
		.all<{bundle: ArrayBuffer}>();
	return rows.results.map((row) => processorArtifactIdentity(new Uint8Array(row.bundle)));
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
	await feed(indexer, indexer.opening, {address: CONTRACT, toBlock: START_BLOCK + 100, to: ALICE, id: 1n});
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
		// ...and so did the CODE: each replaced successor's bundle went with its row, so
		// what is stored is exactly one bundle per registered generation, each one the
		// bytes that name it (ADR-0092)
		expect(await storedBundleIdentities(db)).toEqual(await registeredProcessors(db));
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
		// BOUNDED: eight deploys stored eight bundles and seven of them went with the
		// generation each one folded, so exactly two remain -- one per registered
		// generation, and each the bytes its identity is the hash of (ADR-0092)
		expect(await storedBundleIdentities(db)).toEqual([first.generation.processor, V5]);
	});

	it('restarting on the CANONICAL generation registers nothing, and DISCARDS a different pending successor (ADR-0094)', async () => {
		const db = oneDatabase();
		const first = await aDeploymentThatHasFolded(db);
		const pending = await first.add(specFor(db, V2));
		expect(await registeredProcessors(db)).toEqual([first.generation.processor, pending.record.processor]);

		// the ordinary restart of an unchanged deployment: its fold is what `canonical`
		// already names, so it registers nothing -- and a configured start folds toward
		// EXACTLY its configuration, so the pending successor it finds is discarded rather
		// than left to be promoted over it (this host passes no start guard, so nobody is
		// asked; the CLI's commands ask)
		const restarted = await openIndexer(db, V1);

		expect(restarted.generation.processor).toBe(first.generation.processor);
		expect(await registeredProcessors(db)).toEqual([first.generation.processor]);
		expect(await slotProcessors(db)).toEqual({
			canonical: first.generation.processor,
			successor: null,
			predecessor: null,
		});
		expect(await storedBundleIdentities(db)).toEqual([first.generation.processor]);
	});
});

describe('a generation dropped ON PROMOTION takes its code with it (ADR-0092)', () => {
	it("deletes the superseded generation's bundle with its row, and keeps the promoted one's", async () => {
		const db = oneDatabase();
		await applySchema(db);
		const indexer = await openIndexer(db, V1, {policy: 'manual', dropOnPromotion: true});
		await feed(indexer, indexer.opening, {address: CONTRACT, toBlock: START_BLOCK + 100, to: ALICE, id: 1n});
		const promoted = await indexer.add(specFor(db, V2));
		expect(await storedBundleIdentities(db)).toEqual([V1, V2]);

		await indexer.promote(idOf(promoted));

		// the drop is the same `deleteGeneration` a reclaim and a replaced successor reach,
		// and the bundle is a column of the row it deletes: there is no second path to have
		// forgotten
		expect(await registeredProcessors(db)).toEqual([V2]);
		expect(await storedBundleIdentities(db)).toEqual([V2]);
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
		await feed(indexer, onB, {address: OTHER_CONTRACT, toBlock: START_BLOCK + 20, to: BOB, id: 2n});
		expect(await emissionRows(db, onB.streamDigest)).toBe(1);

		const onC = await indexer.add(specFor(db, V3, sourceOn(THIRD_CONTRACT)));
		const onD = await indexer.add(specFor(db, V4, sourceOn(FOURTH_CONTRACT)));

		expect(await registeredProcessors(db)).toEqual([indexer.generation.processor, onD.record.processor]);
		expect(await indexer.registry.streams()).toEqual(
			[indexer.streamDigest, onD.streamDigest].sort((a, b) => a.localeCompare(b)),
		);
		// RE-SCOPED: the replaced successor's own STREAM is KEPT (ADR-0087). Its
		// registry row and its state namespace go, because a registration displaced it;
		// the bytes a chain fetch bought do not, because nobody asked for them to. That
		// is what makes the next generation over that filter a local re-fold rather than
		// a re-index against a node that may refuse the history outright.
		expect(await emissionRows(db, onB.streamDigest)).toBe(1);
		expect(await indexer.registry.keptStreams()).toContain(onB.streamDigest);
		expect(await namespaceTables(db, idOf(onB))).toEqual([]);
		expect(await namespaceTables(db, idOf(onC))).toEqual([]);
		// and the canonical generation's own stream is untouched
		expect(await emissionRows(db, indexer.streamDigest)).toBe(1);
	});

	it('DROPS the replaced successor even where another held fold folds its stream, and KEEPS the stream', async () => {
		// RE-SCOPED. This used to assert a DECLINE: the older generation WROTE the
		// stream the newer one followed, so dropping it would have left that fold folding
		// a stream nothing appended to -- and would have reaped the stream out from under
		// it. Neither is possible under ADR-0087: the DEPLOYMENT writes the stream it
		// fetches, so there is no duty to strand, and a delete does not reap, so there
		// are no bytes to lose. The decline is gone rather than kept as a clause nothing
		// can reach.
		const db = oneDatabase();
		const indexer = await aDeploymentThatHasFolded(db);

		// the source change lands first, and the processor follows a moment later on
		// that same new stream
		const onB = await indexer.add(specFor(db, V2, sourceOn(OTHER_CONTRACT)));
		await feed(indexer, onB, {address: OTHER_CONTRACT, toBlock: START_BLOCK + 20, to: BOB, id: 2n});
		const alsoOnB = await indexer.add(specFor(db, V3, sourceOn(OTHER_CONTRACT)));

		// the older one lost the slot and GOES: nothing is left named by no slot and
		// retained "for now", so the churn a development loop produces stays bounded
		// without a clause that only fires on one stream shape.
		expect(await registeredProcessors(db)).toEqual([indexer.generation.processor, alsoOnB.record.processor]);
		expect(await slotProcessors(db)).toEqual({
			canonical: indexer.generation.processor,
			successor: alsoOnB.record.processor,
			predecessor: null,
		});
		expect(await namespaceTables(db, idOf(onB))).toEqual([]);

		// ...and the STREAM it opened is exactly where it was, which is what the fold
		// still on it re-folds. That is the whole point: a replaced generation is dead
		// work, and the history it fetched is not.
		expect(alsoOnB.streamDigest).toBe(onB.streamDigest);
		expect(await emissionRows(db, onB.streamDigest)).toBe(1);
		expect(await indexer.registry.keptStreams()).toContain(onB.streamDigest);
	});
});
