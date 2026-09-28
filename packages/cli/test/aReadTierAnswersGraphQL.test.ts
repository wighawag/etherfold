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
import {ALICE, BOB, fakeChain, START_BLOCK, transfer, ZERO} from './utils/chain.js';

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
