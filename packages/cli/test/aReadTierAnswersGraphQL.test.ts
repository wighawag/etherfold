import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generationDigestOf, type GenerationId} from '@etherfold/core';
import {httpExecutor, isTransportFailure} from '@etherfold/graphql';
import {
	describeQueryConformance,
	HISTORY,
	QUERY_ENTITIES,
	subjectWith,
	type QueryExecutorFactory,
	type QuerySubject,
} from '@etherfold/graphql/conformance';
import {createNodeDB, startServer, type RunningServer} from '@etherfold/platform-nodejs';
import {applySchema, openGenerationRegistryOnSQL} from '@etherfold/server';
import type {EntityDeclaration} from '@etherfold/state-store';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {processorArtifactIdentity} from '@etherfold/utils';
import type {RemoteSQL} from 'remote-sql';
import {createClient} from '@libsql/client';
import {fileURLToPath} from 'node:url';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterAll, describe, expect, it} from 'vitest';
import {run} from '../src/run.js';
import {serve} from '../src/serve.js';
import {ALICE, BOB, fakeChain, nftEntities, START_BLOCK, transfer, ZERO} from './utils/chain.js';
import {canonicalStoreIn} from './utils/reads.js';

// ---------------------------------------------------------------------------------------------------
// `etherfold serve` ANSWERS GRAPHQL OVER HTTP (ADR-0099)
// ---------------------------------------------------------------------------------------------------
// The real read tier: `serve` resolving its database and starting the real Node
// adapter on a real port, over a libSQL database file a writer holds a canonical
// generation in (with its bundle stored beside it, ADR-0092). `httpExecutor`
// against its `/graphql` is asked the whole query conformance suite, and must
// answer the same BYTES the in-process executor answers.
//
// The read tier holds no processor: the schema is built from the declarations
// the canonical generation's STORED BUNDLE carries, which is what is being
// proven here beside the transport. The bundle is the smallest module that is
// one (`createProcessor` returning its declarations), written here from the
// suite's own declarations rather than committed, since it has no code to build.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'pools';

const directories: string[] = [];
const servers: RunningServer[] = [];
const databases: RemoteSQL[] = [];
afterAll(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
	for (const db of [...databases.splice(0)]) (db as unknown as {close?: () => void}).close?.();
	for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

/** The smallest processor bundle: self-contained, and carrying exactly these declarations. */
function bundleDeclaring(declarations: readonly EntityDeclaration[]): Uint8Array {
	return new TextEncoder().encode(
		`export const createProcessor=()=>({entities:${JSON.stringify(declarations)},handlers:{}});`,
	);
}

const serverOf = new WeakMap<QuerySubject, RunningServer>();

/**
 * A fresh database file per subject, written as a folding command leaves one (the
 * fixed tables, one canonical generation with its bundle stored, and the store the
 * suite writes through in that generation's namespace), and `etherfold serve`
 * started over it on a port of its own.
 */
const overServe: QueryExecutorFactory = async (declarations) => {
	const directory = mkdtempSync(join(tmpdir(), 'etherfold-serve-graphql-'));
	directories.push(directory);
	const url = `file:${join(directory, 'written-elsewhere.db')}`;

	const db = createNodeDB(url);
	databases.push(db);
	await applySchema(db);
	const bundle = bundleDeclaring(declarations);
	const id: GenerationId = {stream: 'stream-digest', processor: processorArtifactIdentity(bundle)};
	const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: {maxGenerations: 4, maxStreams: 4}});
	await registry.create(id, {bundle});
	await registry.moveCanonicalTo(id);

	let running: RunningServer | undefined;
	await serve(
		{db: url, port: '0'},
		{env: {}, log: () => {}, startServer: async (options) => (running = await startServer(options))},
	);
	servers.push(running!);
	databases.push(running!.db);

	const subject: QuerySubject = {
		store: new VersionedStateStore(db, declarations, {tableNamespace: generationDigestOf(id)}),
		executor: httpExecutor(`${running!.url}/graphql`),
		generation: generationDigestOf(id),
	};
	serverOf.set(subject, running!);
	return subject;
};

await describeQueryConformance('httpExecutor against `etherfold serve`', overServe, {
	transportFailures: {
		// the read tier goes away: nothing listens on its port any more
		network: async (subject) => {
			await serverOf.get(subject)!.close();
		},
	},
});

describe('`etherfold serve` and /graphql', () => {
	it('says where the query surface is, beside the status page', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'etherfold-serve-graphql-'));
		directories.push(directory);
		const said: string[] = [];
		let running: RunningServer | undefined;
		await serve(
			{db: `file:${join(directory, 'empty.db')}`, port: '0'},
			{
				env: {},
				log: (...args) => said.push(args.map(String).join(' ')),
				startServer: async (options) => (running = await startServer(options)),
			},
		);
		servers.push(running!);
		databases.push(running!.db);
		expect(said).toContain(`  graphql: ${running!.url}/graphql`);

		// nothing answers reads in an empty database yet: refused, never empty lists
		const result = await httpExecutor(`${running!.url}/graphql`)({query: '{ pool(first: 1) { pool } }'});
		expect(isTransportFailure(result)).toBe(true);
		expect(result.errors![0]!.extensions).toMatchObject({reason: 'http-status', status: 503});
	});

	it('answers with the declarations of the canonical generation it read from the rows, with no processor given', async () => {
		const {executor, generation} = await subjectWith(overServe, HISTORY);
		expect(await executor({query: '{ deposit(orderBy: {field: amount}, first: 1) { pool seq amount } }'})).toEqual({
			data: {deposit: [{pool: 'b', seq: '1', amount: '1'}]},
			extensions: {generation, block: 11},
		});
		expect(QUERY_ENTITIES.map((entity) => entity.name)).toEqual(['pool', 'deposit', 'crowd']);
	});
});

/** A real committed processor bundle: `nft` and `counter` (`test/fixtures/processor-bundle/README.md`). */
const NFTS_BUNDLE = fileURLToPath(new URL('./fixtures/processor-bundle/nfts.bundle.js', import.meta.url));

describe('`etherfold run` serves /graphql over the generation it folds', () => {
	it('answers from its stored bundle, claiming the --retention it enforces (revert-only: every block refused)', async () => {
		const chain = fakeChain().serve(
			[transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n), transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n)],
			START_BLOCK + 50,
		);
		const running = await run(
			{
				processor: NFTS_BUNDLE,
				nodeUrl: 'http://localhost:0',
				store: 'sqlite',
				db: ':memory:',
				port: '0',
				retention: 'revert-only',
			},
			{
				provider: chain.provider,
				createDB: () => new RemoteLibSQL(createClient({url: ':memory:'})),
				sleep: async () => {
					await new Promise((resolve) => setTimeout(resolve, 1));
				},
				handleSignals: false,
				log: () => {},
				env: {MAX_BLOCKS_PER_FETCH: '20'},
			},
		);
		try {
			const executor = httpExecutor(`${running.url}/graphql`);
			const deadline = Date.now() + 10_000;
			let counted: unknown;
			for (;;) {
				const result = await executor({query: '{ counter(first: 1) { name value } }'});
				counted = result.data;
				if (JSON.stringify(counted) === JSON.stringify({counter: [{name: 'transfers', value: 2}]})) break;
				if (Date.now() > deadline) throw new Error(`run never answered the fold: ${JSON.stringify(result)}`);
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			const asOf = await executor({query: `{ nft(block: ${START_BLOCK + 10}, first: 1) { owner } }`});
			expect(asOf.errors?.[0]?.extensions.code).toBe('block-not-retained');
			expect(asOf.data).toBeNull();
		} finally {
			await running.stop();
		}
	});
});

// ---------------------------------------------------------------------------------------------------
// A READ TIER REFUSES WHAT THE WRITER PRUNED (ADR-0099, ADR-0095)
// ---------------------------------------------------------------------------------------------------
// `serve` claims no retention of its own (`unbounded`), but the process that
// folded the database may have pruned it: the versions closed at or below the
// floor its pass RECORDED are gone. Below that floor `serve` must refuse, never
// answer from partly deleted history; at it, it must answer what the writer did.
// ---------------------------------------------------------------------------------------------------

/** Eight blocks that each mint a token and rewrite ONE counter, so every write but the last closes a version. */
const CHURN = [10, 20, 30, 40, 50, 60, 70, 80].map((offset, index) =>
	transfer(START_BLOCK + offset, `0xa${offset}`, ZERO, ALICE, BigInt(index + 1)),
);
/** The last block carrying a log: the tip the writer's window is measured back from. */
const STORE_TIP = START_BLOCK + 80;
const WINDOW = 20;
/** The floor a pass records: the counter versions closed at or below it are deleted. */
const FLOOR = STORE_TIP - WINDOW;

const asOf = (block: number) =>
	`{ counter(block: ${block}, first: 1) { name value } nft(block: ${block}, first: 10) { tokenID owner } }`;

/** Poll until `done`, or fail naming what never happened. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/**
 * `etherfold run` folds CHURN into a database FILE with `retention`, asked what it
 * answers at `blocks` over its own `/graphql` once it has folded (and, with a
 * window, pruned) to the tip, then stopped: the database a read tier is then
 * started over.
 */
async function foldedByRun(retention: string, blocks: readonly number[]) {
	const directory = mkdtempSync(join(tmpdir(), 'etherfold-serve-pruned-'));
	directories.push(directory);
	const url = `file:${join(directory, 'folded.db')}`;
	const chain = fakeChain().serve(CHURN, START_BLOCK + 100);
	const running = await run(
		{processor: NFTS_BUNDLE, nodeUrl: 'http://localhost:0', store: 'sqlite', db: url, port: '0', retention},
		{
			provider: chain.provider,
			sleep: async () => {
				await new Promise((resolve) => setTimeout(resolve, 1));
			},
			handleSignals: false,
			log: () => {},
			env: {MAX_BLOCKS_PER_FETCH: '20'},
		},
	);
	try {
		const executor = httpExecutor(`${running.url}/graphql`);
		await until(
			async () => (await executor({query: '{ counter(first: 1) { value } }'})).data,
			(data) => JSON.stringify(data) === JSON.stringify({counter: [{value: CHURN.length}]}),
			'the run to fold every transfer',
		);
		if (retention !== 'unbounded') {
			const reader = createNodeDB(url);
			databases.push(reader);
			const store = await canonicalStoreIn(reader, nftEntities);
			// a handle claiming no retention reports only the floor a pass RECORDED
			await until(
				() => store.retainedFrom(),
				(from) => from === FLOOR,
				'the run to prune at its floor',
			);
		}
		const answered = new Map<number, unknown>();
		for (const block of blocks) answered.set(block, await executor({query: asOf(block)}));
		return {url, answered};
	} finally {
		await running.stop();
	}
}

/** `etherfold serve` over a database file, told no retention: the read tier of a split deployment. */
async function servedOver(url: string) {
	let running: RunningServer | undefined;
	await serve(
		{db: url, port: '0'},
		{env: {}, log: () => {}, startServer: async (options) => (running = await startServer(options))},
	);
	servers.push(running!);
	databases.push(running!.db);
	return httpExecutor(`${running!.url}/graphql`);
}

describe('`etherfold serve` over a database another process folded', () => {
	it('refuses a block below the prune floor the writer recorded, and answers the floor as the writer did', async () => {
		const {url, answered} = await foldedByRun(String(WINDOW), [FLOOR]);
		const atFloor = answered.get(FLOOR) as {data: unknown; errors?: unknown};
		// the writer answered its own floor: six transfers had been counted by then
		expect(atFloor.errors).toBeUndefined();
		expect(atFloor.data).toMatchObject({counter: [{name: 'transfers', value: 6}]});

		const executor = await servedOver(url);

		const below = await executor({query: asOf(FLOOR - 1)});
		expect(below.errors).toHaveLength(1);
		expect(below.errors![0]!.extensions).toMatchObject({code: 'block-not-retained'});
		expect(below.data).toBeNull();
		const farBelow = await executor({query: asOf(START_BLOCK + 20)});
		expect(farBelow.errors?.[0]?.extensions.code).toBe('block-not-retained');
		expect(farBelow.data).toBeNull();

		expect(await executor({query: asOf(FLOOR)})).toEqual(atFloor);
	});

	it('answers a block far below the tip of a database that was never pruned, as the writer did', async () => {
		const early = START_BLOCK + 20;
		const {url, answered} = await foldedByRun('unbounded', [early]);
		expect(answered.get(early)).toMatchObject({data: {counter: [{name: 'transfers', value: 2}]}});

		const executor = await servedOver(url);

		expect(await executor({query: asOf(early)})).toEqual(answered.get(early));
	});
});
