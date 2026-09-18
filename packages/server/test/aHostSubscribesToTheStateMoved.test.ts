import {createClient} from '@libsql/client';
import {
	generationDigestOf,
	openReceivingIndexer,
	serializeWireBatch,
	type LogIngestion,
	type ReceivingIndexer,
	type StateMoved,
	type WireBatch,
} from '@etherfold/core';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {describe, expect, it} from 'vitest';
import {
	applySchema,
	createServer,
	emissionAppenderFor,
	generationRegistryPortOnSQL,
	indexerEntryOn,
	singleContextEntry,
} from '../src/index.js';
import {
	ALICE,
	CONTRACT,
	SOURCE,
	STREAM_CONFIG,
	START_BLOCK,
	TOKEN,
	transfer,
	type TestABI,
} from './utils/feedHarness.js';
import {identityOf} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------------------------------
// A SERVER-SHAPED DEPLOYMENT CAN SUBSCRIBE TO THE STATE-MOVED SIGNAL
// ---------------------------------------------------------------------------------------------------
// This package APPLIES NO BLOCKS. An ingest route delegates to a receiver the
// host constructed, so the signal ADR-0083 decides is produced in
// `@etherfold/core` (`ReceivingIndexer.onStateMoved`) and what a server needs is
// a way to REACH it -- because a route holds an ENTRY and never the container.
//
// So what is asserted here is the SHAPE OF ACCESS, on the real assembly: a
// `ReceivingIndexer` over the SQL generation registry, registered under a name
// through `indexerEntryOn`, a batch POSTed at `/{indexer}/ingest`, and a
// subscriber attached to the ENTRY being told which block landed and which
// entities it touched. That is the thing the remote transport task attaches to;
// it needs no change to the publication to do so, which is what ADR-0083 means
// by the producer being transport-agnostic.
//
// It also pins the OTHER half of the capability statement: an entry for a host
// holding a bare receiver and no container (`singleContextEntry`) reports NO
// subscription rather than an empty one, exactly as it reports no `generations`
// and no `promote`. A surface built over it refuses instead of going quiet --
// which is the failure mode ADR-0083 names for Cloudflare Workers, where an
// ingest invocation cannot write into a stream another request opened.
// ---------------------------------------------------------------------------------------------------

const NAME = 'alpha';

/**
 * WHICH FOLD this deployment runs, as its ARRIVAL derived it (ADR-0086): a hash
 * of the bytes a bundle would have arrived as, handed to the fold rather than
 * asked of it.
 */
const PROCESSOR_IDENTITY = identityOf('alpha');

const entityProcessor: EntityProcessor<TestABI> = {
	entities: [{name: 'token', id: ['id'], fields: {owner: 'text'}}],
	async onTransfer(state, event) {
		state.set('token', {id: (event.args as {id: bigint}).id.toString()}, {owner: event.args.to});
	},
};

function freshDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/** A host of the shape a server actually runs: a container over its database, registered under a name. */
async function deploy() {
	const db = freshDatabase();
	await applySchema(db);
	const indexer = (await openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, NAME),
		source: SOURCE,
		stream: STREAM_CONFIG,
		appendEmissions: emissionAppenderFor(db, NAME),
		generation: {
			createState: () => db,
			createProcessor: (state: RemoteSQL) => new VersionedStateEventProcessor<TestABI>(state, entityProcessor),
			processorIdentity: PROCESSOR_IDENTITY,
		},
	})) as ReceivingIndexer<TestABI, unknown, RemoteSQL>;

	const entry = indexerEntryOn(db, indexer);
	const app = createServer<{INGEST_TOKEN?: string}>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN}),
		getIndexer: (_c, name) => (name === NAME ? entry : undefined),
	});

	const post = (batch: WireBatch<TestABI>) =>
		app.request(`/${NAME}/ingest`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
			body: serializeWireBatch(batch),
		});

	return {db, indexer, entry, app, post};
}

describe('a host reaches the state-moved signal through the entry it registered', () => {
	it('tells a subscriber which block the INGEST ROUTE just folded, and which entities it touched', async () => {
		const {indexer, entry, post} = await deploy();

		// THE HOST'S ATTACHMENT POINT: the entry, which is the only handle a route has
		// on a name. A transport pushing this to a client subscribes exactly here.
		const moved: StateMoved[] = [];
		expect(entry.onStateMoved).toBeTypeOf('function');
		const detach = (entry.onStateMoved as NonNullable<typeof entry.onStateMoved>)((notification) =>
			moved.push(notification),
		);

		const response = await post({
			context: indexer.ingestion.context,
			fromBlock: START_BLOCK,
			toBlock: 105,
			latestBlock: 105,
			logs: [transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT)],
		});
		expect(response.status).toBe(200);

		expect(moved.map((notification) => notification.kind)).toEqual(['applied']);
		const applied = moved[0];
		expect(applied.kind === 'applied' && applied.block).toBe(101);
		// the entity NAMES a REAL fold produced, through the SQL wrapper: a deployment
		// whose processor is `VersionedStateEventProcessor` must not report an empty set
		expect(applied.kind === 'applied' && applied.entities).toEqual(['token']);
		const canonical = await indexer.canonical();
		expect(applied.generation).toBe(generationDigestOf(canonical as NonNullable<typeof canonical>));
		expect(typeof applied.coherence).toBe('string');

		// symmetric, and the producer holds nothing about a subscriber that left
		detach();
		await post({
			context: indexer.ingestion.context,
			fromBlock: 103,
			toBlock: 110,
			latestBlock: 110,
			logs: [transfer(107, '0xa107', ALICE, 2n, 0, CONTRACT)],
		});
		expect(moved.length).toBe(1);
	});

	it('reports NO subscription on an entry whose host holds a bare receiver and no container', async () => {
		// `singleContextEntry` is every host that is not built on a generation
		// container, and a receiver publishes nothing of its own -- the publisher is the
		// CONTAINER's. Absent says so, exactly as it does for `generations` and
		// `promote`, so a transport refuses rather than attaching to silence.
		const db = freshDatabase();
		const entry = singleContextEntry(db, {} as unknown as LogIngestion);

		expect(entry.onStateMoved).toBeUndefined();
		expect(entry.generations).toBeUndefined();
		expect(entry.promote).toBeUndefined();
	});
});
