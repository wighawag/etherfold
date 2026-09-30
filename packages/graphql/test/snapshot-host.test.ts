import {createClient} from '@libsql/client';
import {
	openSnapshotAware,
	SnapshotAwareStateStore,
	type Mutation,
	type StateStoreBackend,
} from '@etherfold/state-store';
import type {IndexedDBStateStore} from '@etherfold/state-store-indexeddb';
import {produceStateSnapshot, VersionedStateStore, type SnapshotHistory} from '@etherfold/state-store-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {
	block,
	deposit,
	describeQueryConformance,
	pool,
	QUERY_ENTITIES,
	subjectWith,
	type HistoryStep,
	type QueryExecutorFactory,
} from '../src/conformance/index.js';
import {buildQuerySchema, localExecutor, QUERY_ERROR_CODES, type QueryExecutor} from '../src/index.js';
import {closePort, readerHostExecutor, terminateHost, workerHostExecutor} from './workerHosts.js';

/**
 * A WORKER HOST WHOSE STORE STARTED FROM A SNAPSHOT ANSWERS QUERIES (ADR-0099),
 * and refuses a block below the floor the snapshot installed (ADR-0095, ADR-0028).
 *
 * The documented boot path opens every store through `openSnapshotAware`,
 * bootstrapped or not, and hands THAT to `openForWriting`. So the host's
 * `graphqlQueryHandler` reads the snapshot-aware handle's `accessor()` and
 * `tip()`, through the claimed handle, and this file asks it the whole query
 * conformance suite in both of its states:
 *
 * - BOOTSTRAPPED from a document the real producer wrote (`produceStateSnapshot`
 *   over a real SQLite store, format 2, carrying history), before the suite
 *   writes a block;
 * - NEVER bootstrapped, where the handle is a pass-through and must answer
 *   exactly what the plain IndexedDB host answers.
 *
 * Then, on a host whose store keeps everything (so the snapshot's floor is the
 * only floor there is), a block below the floor is refused with the one code
 * and a block at or above it answers what the SQLite in-process executor answers
 * over the store the snapshot was produced from.
 */

const BOUND = 60;
/** The identity the hosts in `workerHosts.ts` name their fold by, which a snapshot must match. */
const PROCESSOR = 'graphql-worker-conformance';
const transportFailures = {'port-closed': closePort, 'host-gone': terminateHost};

function sqliteStore(): VersionedStateStore {
	return new VersionedStateStore(new RemoteLibSQL(createClient({url: ':memory:'})), QUERY_ENTITIES);
}

async function apply(store: StateStoreBackend, steps: readonly {block: number; mutations: readonly Mutation[]}[]) {
	for (const step of steps) await store.applyBlock(block(step.block), step.mutations);
}

/** A published document: `steps` folded into a real SQLite store, read out by the real producer. */
async function published(
	source: VersionedStateStore,
	at: number,
	history: SnapshotHistory,
): Promise<{document: Uint8Array; floor: number; takenAt: number}> {
	const produced = await produceStateSnapshot(source, {at, processor: PROCESSOR, history});
	const document = new Uint8Array(await new Response(produced.document).arrayBuffer());
	return {document, floor: produced.head.floor, takenAt: produced.head.takenAt.number};
}

/**
 * How the host's app opens its store: snapshot-aware on every boot, and the
 * WRITER bootstrapped from `document` on this (its first) one. A reader opens the
 * same shared store snapshot-aware and bootstraps nothing: it recovers the floor
 * the writer recorded.
 */
function bootstrappedFrom(document: Uint8Array) {
	return async (store: IndexedDBStateStore, role: 'writer' | 'reader'): Promise<StateStoreBackend> => {
		const aware = await openSnapshotAware(store);
		if (role === 'writer') await aware.bootstrap(document, {processor: PROCESSOR});
		return aware;
	};
}

/**
 * The factory, checked: every subject's store is the snapshot-aware handle, and
 * still holds the floor it was given once its host has opened, so the suite is
 * asked of the store this file says it is (a host that wiped it would turn the
 * run into the pass-through case without a word).
 */
function floored(factory: QueryExecutorFactory, floor: number | undefined): QueryExecutorFactory {
	return async (declarations) => {
		const subject = await factory(declarations);
		if (!(subject.store instanceof SnapshotAwareStateStore)) throw new Error('the subject is not snapshot-aware');
		if (subject.store.snapshotOrigin !== floor) {
			throw new Error(`the subject's floor is ${subject.store.snapshotOrigin}, expected ${floor}`);
		}
		return subject;
	};
}

// -- the whole suite, bootstrapped ------------------------------------------

/**
 * The CONFORMANCE snapshot: rows at the floor (block 2) that its one later block
 * (3, the cut) removes, so it installs real rows and real history and leaves the
 * current state empty: every case the suite asks writes its own rows from block
 * 10 up, above the cut, onto a store with nothing live in it.
 */
const conformanceSource = sqliteStore();
await conformanceSource.migrate();
await apply(conformanceSource, [
	{block: 2, mutations: [pool('z', {label: 'zeta', kind: 'open'}), deposit('z', '1', {who: 'zoe', amount: 1n})]},
	{
		block: 3,
		mutations: [
			{type: 'delete', entity: 'deposit', id: {pool: 'z', seq: '1'}},
			{type: 'delete', entity: 'pool', id: {pool: 'z'}},
		],
	},
]);
const conformance = await published(conformanceSource, 3, 'all');
if (conformance.floor !== 2 || conformance.takenAt !== 3) {
	throw new Error(`the conformance snapshot spans ${conformance.floor} to ${conformance.takenAt}, expected 2 to 3`);
}

/**
 * A bootstrapped store's NARROWED window is the distance from its floor to its
 * tip, so it grows as the suite writes, and the suite reads a store's claim once,
 * from a probe. The claim is made stable by the store underneath: it keeps a
 * 1-block window, and the snapshot carries exactly one block of history above its
 * floor (floor 2, cut 3), so the narrowed claim is `{window, blocks: 1}` from the
 * moment the snapshot is installed and at every tip the suite reaches.
 */
await describeQueryConformance(
	'workerExecutor over a dedicated-worker host whose store was bootstrapped from a published snapshot',
	floored(
		workerHostExecutor('dedicated-worker', {
			rowsExaminedBound: BOUND,
			retention: {blocks: 1},
			finalityDepth: 1,
			open: bootstrappedFrom(conformance.document),
		}),
		conformance.floor,
	),
	{rowsExaminedBound: BOUND, transportFailures, snapshotTakenAt: conformance.takenAt},
);

// -- the whole suite, never bootstrapped ------------------------------------

await describeQueryConformance(
	'workerExecutor over a dedicated-worker host whose store is snapshot-aware and was never bootstrapped, keeping everything',
	floored(
		workerHostExecutor('dedicated-worker', {
			rowsExaminedBound: BOUND,
			open: (store) => openSnapshotAware(store),
		}),
		undefined,
	),
	{rowsExaminedBound: BOUND, transportFailures},
);

// -- the floor, on a store that keeps everything ----------------------------

/**
 * The FLOOR snapshot: a history reaching block 1, cut at block 8 with three
 * blocks of history, so its floor is block 5 and blocks 1 to 4 are history the
 * installed store never received.
 */
const EARLIER: readonly {block: number; mutations: readonly Mutation[]}[] = [
	{block: 1, mutations: [pool('a', {label: 'a1', kind: 'open'}), pool('b', {label: 'b1', kind: 'closed'})]},
	{block: 3, mutations: [pool('a', {label: 'a3', kind: 'open'}), deposit('a', '1', {who: 'ann', amount: 5n})]},
	{
		block: 5,
		mutations: [pool('c', {label: 'c5', kind: 'open'}), {type: 'delete', entity: 'pool', id: {pool: 'b'}}],
	},
	{block: 6, mutations: [pool('a', {label: 'a6', kind: 'closed'})]},
	{block: 8, mutations: [deposit('a', '2', {who: 'bob', amount: 7n}), pool('d', {label: 'd8', kind: 'open'})]},
];
/** What the suite-style subject writes after the snapshot: to the host's store, and to the source alike. */
const LATER: readonly {block: number; mutations: readonly Mutation[]}[] = [
	{block: 10, mutations: [pool('e', {label: 'e10', kind: 'open'}), deposit('c', '1', {who: 'cat', amount: 2n})]},
	{
		block: 11,
		mutations: [{type: 'delete', entity: 'pool', id: {pool: 'd'}}, pool('c', {label: 'c11', kind: 'closed'})],
	},
];
const LATER_STEPS: readonly HistoryStep[] = LATER;

const floorSource = sqliteStore();
await floorSource.migrate();
await apply(floorSource, EARLIER);
const floorSnapshot = await published(floorSource, 8, 3);
await apply(floorSource, LATER);

/** The SQLite in-process executor over the store the floor snapshot was produced from, with LATER applied. */
const sqlite: QueryExecutor = localExecutor(buildQuerySchema(QUERY_ENTITIES), {
	accessor: floorSource.accessor(),
	generation: 'sqlite-source',
	tip: async () => (await floorSource.getBlockAtOrBelow(Number.MAX_SAFE_INTEGER))?.number,
	asOf: true,
});

const poolsAt = (at?: number) =>
	`{ pool(${at === undefined ? '' : `block: {number: ${at}}, `}orderBy: {field: pool}, first: 10) { pool label kind deposits(orderBy: {field: seq}, first: 10) { seq who amount } } }`;

/** Exactly one error, coded `block-not-retained`, and no rows. */
function expectRefusedBelowTheFloor(result: Awaited<ReturnType<QueryExecutor>>, requested: number) {
	expect(result.data).toBeNull();
	expect(result.errors).toHaveLength(1);
	expect(result.errors![0]!.extensions).toMatchObject({code: QUERY_ERROR_CODES.blockNotRetained, requested});
}

describe('a worker host whose store started from a snapshot', () => {
	it('was given the floor the producer wrote', () => {
		expect(floorSnapshot.floor).toBe(5);
	});

	it('refuses a block below the installed floor with block-not-retained, and answers the floor and above it as SQLite does', async () => {
		const factory = floored(
			workerHostExecutor('dedicated-worker', {open: bootstrappedFrom(floorSnapshot.document)}),
			floorSnapshot.floor,
		);
		const {executor} = await subjectWith(factory, LATER_STEPS);

		// the source database HAS block 4, which is the point: the host must not answer it
		expect((await sqlite({query: poolsAt(4)})).errors).toBeUndefined();
		for (const below of [4, 1, 0]) expectRefusedBelowTheFloor(await executor({query: poolsAt(below)}), below);

		for (const at of [5, 6, 7, 8, 9, 10, 11, undefined]) {
			const worker = await executor({query: poolsAt(at)});
			const expected = await sqlite({query: poolsAt(at)});
			expect(worker.errors, `block ${at}`).toBeUndefined();
			expect(expected.errors, `block ${at}`).toBeUndefined();
			expect(JSON.stringify(worker.data), `block ${at}`).toBe(JSON.stringify(expected.data));
			expect(worker.extensions?.block).toBe(11);
		}
	});

	it('answers a query from the READER side of the tab election, through the same snapshot-aware handle', async () => {
		const factory = floored(readerHostExecutor({open: bootstrappedFrom(floorSnapshot.document)}), floorSnapshot.floor);
		const {executor} = await subjectWith(factory, LATER_STEPS);
		const reader = await executor({query: poolsAt(8)});
		expect(reader.errors).toBeUndefined();
		expect(JSON.stringify(reader.data)).toBe(JSON.stringify((await sqlite({query: poolsAt(8)})).data));
		expectRefusedBelowTheFloor(await executor({query: poolsAt(4)}), 4);
	});
});
