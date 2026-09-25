import {
	type RebuildReport,
	generationDigestOf,
	openReceivingIndexer,
	type LogEvent,
	type ReceivingIndexer,
	type WireBatch,
} from '@etherfold/core';
import {
	EntityEventProcessor,
	type EntityProcessor,
	openForWriting,
	type WritableStateStore,
} from '@etherfold/processor-entities';
import {
	applySchema,
	createServer,
	emissionAppenderFor,
	streamCursorSourceOn,
	generationRegistryPortOnSQL,
	storedEmissionReplaySource,
} from '@etherfold/server';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {readStatusReport} from '../src/cursorReport.js';
import {
	abi,
	ALICE,
	BOB,
	CAROL,
	nftEntities,
	nftProcessor,
	SOURCE,
	START_BLOCK,
	transfer,
	ZERO,
	type RawLog,
} from './utils/chain.js';
import {bundleOf, identityOf} from './utils/processorIdentity.js';
import {generationStateSeamsOn} from './utils/generationState.js';

// ---------------------------------------------------------------------------------------------------
// AN OPERATOR WATCHES A REBUILD ADVANCE, ON `/status`, WITH NO NEW ENDPOINT
// ---------------------------------------------------------------------------------------------------
// `packages/server/test/aRebuildInProgressIsNeverEmpty.test.ts` asserts the
// ENVELOPE the server owns, with the report supplied by hand. This file asserts
// the thing that field exists for, over the assembly a deployment actually has:
// a real container on ONE libSQL handle, a real incumbent that folded a real
// stream, a real successor catching up from disk, and the reporter the folding
// commands inject (`readStatusReport`).
//
// What only this level can say:
//
//  - a generation that has folded NOTHING YET is VISIBLE, with no progress --
//    which is the whole distinction: "still being built" is not "absent";
//  - the rebuild's progress ADVANCES across chunks, read twice either side of
//    one, which is what an operator refreshing the page sees;
//  - the CANONICAL entry does not move while it advances (ADR-0008: readers
//    never see partial state), and the flag moves exactly once, at the end;
//  - the envelope stays SMALL: four numbers per generation, no unconfirmed
//    window and no raw serialized cursor anywhere in it.
//
// `run` AND `index` NOW HAND THAT REPORTER THEIR CONTAINER
// (`foldingStatusReport`, `src/folding.ts`), so what this file drives is what
// those two commands report -- with the folds arranged by hand, which is how a
// mid-rebuild page is put on screen without a chain and a promotion in the way.
// `packages/cli/test/equivalence.test.ts` asserts the same field through the
// COMMANDS, over a real `run` that adds a successor and promotes it.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'alpha';
const FINALITY = 3;

/** The incumbent fold, as its ARRIVAL delivered it: bytes, and the identity of those bytes. */
const V1 = {declared: nftProcessor as EntityProcessor<typeof abi>, identity: identityOf('the-incumbent-fold')};

/**
 * THE UPGRADE: the same logs, a different fold, so the two answer observably
 * differently.
 *
 * Its identity is the hash of the bytes it arrived as (ADR-0086), and there is
 * nothing in the declaration below that could name it.
 */
const V2 = {
	declared: {
		entities: nftEntities,
		async onTransfer(state, event) {
			const tokenID = event.args.id.toString().padStart(78, '0');
			const to = event.args.to.toLowerCase();
			if (to === ZERO) {
				state.delete('nft', {tokenID});
			} else {
				state.set('nft', {tokenID}, {owner: to});
			}
			const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
			state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 2});
		},
	} as EntityProcessor<typeof abi>,
	identity: identityOf('the-successor-fold'),
};

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/**
 * ONE FOLD, as the host builds it: its own state namespace, then the processor
 * over it.
 *
 * The identity the ARRIVAL supplied goes to BOTH halves, so the namespace named
 * before the processor exists (ADR-0053) and the fold that lands in it cannot
 * answer to two different names.
 */
function specFor(db: RemoteSQL, fold: {declared: EntityProcessor<typeof abi>; identity: string}) {
	const {declared, identity} = fold;
	return {
		// CLAIMED, because this fold WRITES: the ability to mutate is obtained by
		// claiming (ADR-0077), exactly as the CLI's own `buildFolding` does it.
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

async function openIndexer(db: RemoteSQL): Promise<ReceivingIndexer<typeof abi, unknown, WritableStateStore>> {
	return openReceivingIndexer({
		// BOTH state seams, as `openFolding` supplies them: this host named the
		// namespaces, so it is the one that can drop one and read a position out of one.
		port: generationRegistryPortOnSQL(db, INDEXER, generationStateSeamsOn(db, nftEntities)),
		source: SOURCE,
		stream: {finality: FINALITY},
		appendEmissions: emissionAppenderFor(db, INDEXER),
		streamCursor: streamCursorSourceOn(db, INDEXER),
		replay: storedEmissionReplaySource(db, INDEXER),
		generation: specFor(db, V1),
	}) as Promise<ReceivingIndexer<typeof abi, unknown, WritableStateStore>>;
}

/** One decoded `Transfer` carrying the REAL topics a stored row keeps, so a replay can decode it again. */
function transferEvent(
	blockNumber: number,
	blockHash: string,
	from: string,
	to: string,
	id: bigint,
): LogEvent<typeof abi> {
	const raw: RawLog = transfer(blockNumber, blockHash, from, to, id);
	return {
		blockNumber: parseInt(raw.blockNumber.slice(2), 16),
		blockHash: raw.blockHash,
		blockTimestamp: parseInt(raw.blockTimestamp.slice(2), 16),
		transactionIndex: parseInt(raw.transactionIndex.slice(2), 16),
		removed: false,
		address: raw.address,
		data: raw.data,
		topics: raw.topics,
		transactionHash: raw.transactionHash,
		logIndex: parseInt(raw.logIndex.slice(2), 16),
		extra: undefined,
		eventName: 'Transfer',
		args: {from, to, id},
	} as unknown as LogEvent<typeof abi>;
}

async function push(
	indexer: ReceivingIndexer<typeof abi, unknown, WritableStateStore>,
	over: {toBlock: number; latestBlock: number; logs?: LogEvent<typeof abi>[]},
): Promise<void> {
	const batch: WireBatch<typeof abi> = {
		context: indexer.ingestion.context,
		fromBlock: await indexer.ingestion.expectedFromBlock(),
		toBlock: over.toBlock,
		latestBlock: over.latestBlock,
		logs: (over.logs ?? []).map((event) => ({...event})),
	};
	await indexer.ingestion.receive(batch);
}

/** A database an incumbent has folded into, over a history long enough to need several chunks. */
async function anIndexerThatHasFolded(
	db: RemoteSQL,
): Promise<ReceivingIndexer<typeof abi, unknown, WritableStateStore>> {
	await applySchema(db);
	const incumbent = await openIndexer(db);
	await push(incumbent, {
		toBlock: START_BLOCK + 5,
		latestBlock: START_BLOCK + 5,
		logs: [
			transferEvent(START_BLOCK + 1, '0xa1', ZERO, ALICE, 1n),
			transferEvent(START_BLOCK + 3, '0xa3', ALICE, BOB, 1n),
			transferEvent(START_BLOCK + 5, '0xa5', BOB, CAROL, 1n),
		],
	});
	await push(incumbent, {
		toBlock: START_BLOCK + 20,
		latestBlock: START_BLOCK + 20,
		logs: [transferEvent(START_BLOCK + 9, '0xa9', CAROL, ALICE, 1n)],
	});
	return incumbent;
}

/**
 * THE HOST: the container, and the `/status` surface over the same handle, with
 * the reporter a folding command injects.
 *
 * The mapping from what the container HOLDS to what the reporter reads is the
 * four lines a host writes; nothing about it is test-only.
 */
async function hostOver(db: RemoteSQL, indexer: ReceivingIndexer<typeof abi, unknown, WritableStateStore>) {
	const app = createServer<{DEV?: string}>({
		getDB: () => db,
		getEnv: () => ({}),
		getCursorReport: async () => {
			const canonical = await indexer.canonical();
			return readStatusReport({
				folds: indexer.held().map((fold) => ({
					generation: fold.record,
					store: fold.state as WritableStateStore,
					// every generation on this runtime folds the stored stream (ADR-0087)
					follows: true,
				})),
				...(canonical ? {canonical} : {}),
			});
		},
	});
	return app;
}

type ReportedEntry = {generation: string; canonical: boolean; follows: boolean; value?: {lastToBlock: number}};

async function statusOf(app: Awaited<ReturnType<typeof hostOver>>) {
	const res = await app.request('/status');
	const body = (await res.json()) as {
		healthy: boolean;
		cursor: {reported: boolean; value?: {lastToBlock: number}; reason?: string; generations?: ReportedEntry[]};
	};
	expect(res.status, JSON.stringify(body)).toBe(200);
	return body;
}

function entryFor(
	body: Awaited<ReturnType<typeof statusOf>>,
	generation: {stream: string; processor: string},
): ReportedEntry {
	const digest = generationDigestOf(generation);
	const found = (body.cursor.generations ?? []).find((entry) => entry.generation === digest);
	if (!found) throw new Error(`no /status entry for the generation ${digest}`);
	return found;
}

/**
 * THE REPORT FOR ONE GENERATION, named rather than taken off the front.
 *
 * `rebuildMore` reports one entry per fold held, and since ADR-0087 that is every
 * generation this container holds rather than the followers alone -- so the first
 * entry is the incumbent, which is level and reports `complete` at once.
 */
function reportFor(reports: readonly RebuildReport[], generation: {stream: string; processor: string}) {
	return reports.find(
		(report) => report.generation.stream === generation.stream && report.generation.processor === generation.processor,
	);
}

// ---------------------------------------------------------------------------------------------------

describe('a rebuild in progress is visible on /status, and it ADVANCES', () => {
	it('reports one entry per generation, and the one being rebuilt advances across chunks', async () => {
		const db = oneDatabase();
		const incumbent = await anIndexerThatHasFolded(db);
		const app = await hostOver(db, incumbent);

		// ONE generation before the upgrade: the shape does not depend on how many a
		// deployment holds
		const alone = await statusOf(app);
		expect(alone.cursor.generations).toHaveLength(1);
		// `follows` is TRUE for every fold on this runtime since ADR-0087: no generation
		// fetches, so each of them advances by re-folding the stream the deployment stored.
		expect(entryFor(alone, incumbent.generation)).toMatchObject({canonical: true, follows: true});

		const successor = await incumbent.add(specFor(db, V2));

		// BEFORE ANY CHUNK: the successor is VISIBLE and has got nowhere. This is the
		// distinction the whole task is about -- an operator can tell "being built"
		// from "not there", and from "there and empty"
		const created = await statusOf(app);
		expect(created.cursor.generations).toHaveLength(2);
		expect(entryFor(created, successor.record)).toEqual({
			generation: generationDigestOf(successor.record),
			canonical: false,
			follows: true,
		});
		// and the CANONICAL generation is still the incumbent, still answering
		expect(entryFor(created, incumbent.generation).canonical).toBe(true);

		// TWO READS, EITHER SIDE OF A CHUNK
		const first = reportFor(await incumbent.rebuildMore({maxEmissions: 1}), successor.record);
		expect(first?.complete).toBe(false);
		const afterFirst = await statusOf(app);
		const second = reportFor(await incumbent.rebuildMore({maxEmissions: 1}), successor.record);
		expect(second?.complete).toBe(false);
		const afterSecond = await statusOf(app);

		const one = entryFor(afterFirst, successor.record);
		const two = entryFor(afterSecond, successor.record);
		expect(one.value?.lastToBlock).toBeGreaterThan(0);
		expect(two.value?.lastToBlock).toBeGreaterThan(one.value?.lastToBlock as number);
		// it is still the one being REBUILT and still not the one answering reads
		expect(two).toMatchObject({canonical: false, follows: true});

		// ...and what a READER gets did not move while it advanced (ADR-0008)
		const incumbentAfter = entryFor(afterSecond, incumbent.generation);
		expect(incumbentAfter).toMatchObject({canonical: true, follows: true});
		expect(incumbentAfter.value).toEqual(entryFor(alone, incumbent.generation).value);
		// the top-level `value` is the CANONICAL generation's, which is what a reader
		// that predates the generations field reads (ADR-0047)
		expect(afterSecond.cursor.value).toEqual(incumbentAfter.value);
	});

	it('moves the canonical flag exactly once, when the rebuild finishes', async () => {
		const db = oneDatabase();
		const incumbent = await anIndexerThatHasFolded(db);
		const app = await hostOver(db, incumbent);
		const successor = await incumbent.add(specFor(db, V2));

		const canonicalDuring: string[] = [];
		let done = false;
		for (let guard = 0; guard < 20 && !done; guard++) {
			const report = reportFor(await incumbent.rebuildMore({maxEmissions: 1}), successor.record);
			done = !!report?.complete;
			const body = await statusOf(app);
			canonicalDuring.push((body.cursor.generations ?? []).find((entry) => entry.canonical)?.generation as string);
		}
		expect(done).toBe(true);

		const incumbentDigest = generationDigestOf(incumbent.generation);
		const successorDigest = generationDigestOf(successor.record);
		// the incumbent answered every read until the last chunk, and the flag moved
		// once: no page ever showed the half-built generation as the one answering
		expect(canonicalDuring[canonicalDuring.length - 1]).toBe(successorDigest);
		expect(canonicalDuring.slice(0, -1).every((digest) => digest === incumbentDigest)).toBe(true);
		expect(new Set(canonicalDuring).size).toBe(2);

		// and the successor is now the one whose progress `value` reports
		const settled = await statusOf(app);
		expect(entryFor(settled, successor.record).canonical).toBe(true);
		expect(settled.cursor.value).toEqual(entryFor(settled, successor.record).value);
	});

	it('keeps the envelope SMALL: four numbers a generation, no window and no serialized cursor', async () => {
		const db = oneDatabase();
		const incumbent = await anIndexerThatHasFolded(db);
		const app = await hostOver(db, incumbent);
		await incumbent.add(specFor(db, V2));
		await incumbent.rebuildMore({maxEmissions: 1});

		const body = await statusOf(app);
		for (const entry of body.cursor.generations ?? []) {
			expect(Object.keys(entry).sort()).toEqual(
				entry.value ? ['canonical', 'follows', 'generation', 'value'] : ['canonical', 'follows', 'generation'],
			);
			if (entry.value) {
				// a COUNT and never the window itself: the window is whole blocks of
				// decoded events, which is the blob this seam exists to keep off the page
				expect(Object.keys(entry.value).sort()).toEqual([
					'lastFromBlock',
					'lastToBlock',
					'latestBlock',
					'unconfirmedBlocks',
				]);
				expect(typeof (entry.value as unknown as {unconfirmedBlocks: number}).unconfirmedBlocks).toBe('number');
			}
		}
		// nothing anywhere in the envelope carries the serialized cursor's shape
		const serialised = JSON.stringify(body.cursor);
		expect(serialised).not.toContain('unconfirmedBlocks":[');
		expect(serialised).not.toContain('transactionHash');
		expect(serialised.length).toBeLessThan(1000);
	});
});
