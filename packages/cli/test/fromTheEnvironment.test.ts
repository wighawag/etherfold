import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {prepareIndexing} from '../src/index.js';
import {serve} from '../src/serve.js';
import type {Options} from '../src/types.js';
import {abi, ALICE, CONTRACT, entityModule, fakeChain, noChain, START_BLOCK, transfer, ZERO} from './utils/chain.js';
import {canonicalStoreIn} from './utils/reads.js';

// ---------------------------------------------------------------------------------------------------
// THE RESOLVED VALUES REACH THE PIPELINE, AND THE ENVIRONMENT IS A FIRST-CLASS WAY IN
// ---------------------------------------------------------------------------------------------------
// `configuration.test.ts` asserts the resolver over an options object and an
// environment record. This one asserts that what it resolved is what the command
// actually RUNS on -- one pass per command that exists -- because a resolver
// nothing consumes would be a very well-tested piece of dead code.
//
// The environment is what is driven here rather than the flags, since the flag
// path is what every other test in this package already exercises: a deployment
// that names nothing on the command line but the module and the store must be a
// complete deployment.
// ---------------------------------------------------------------------------------------------------

const LOGS = [transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n)];
const TIP = START_BLOCK + 100;

/** The image: which processor module, and which store. Everything else varies per deployment. */
const IMAGE: Options = {processor: './nfts.js', store: 'sqlite'};

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

describe('`build`, configured from the environment', () => {
	it('opens the database DB names, and indexes the chain ETH_NODE_URI names', async () => {
		const chain = fakeChain().serve(LOGS, TIP);
		const opened: string[] = [];
		const db = oneDatabase();

		const prepared = await prepareIndexing('build', IMAGE, {
			env: {DB: 'file:./from-the-environment.db', ETH_NODE_URI: 'http://node.from.env'},
			importModule: async () => entityModule,
			provider: chain.provider,
			createDB: (url) => {
				opened.push(url);
				return db;
			},
			sleep: async () => {},
		});
		await prepared.index();

		// the resolved database is the one the store was built on, not a default
		expect(opened).toEqual(['file:./from-the-environment.db']);
		// ...and it really folded, so the environment reached the whole pipeline --
		// read through the canonical pointer, which is how a generation's tables are
		// named (ADR-0053)
		const store = await canonicalStoreIn(db, [{name: 'counter', id: ['name'], fields: {value: 'integer'}}]);
		expect(await store.getCurrent<{value: number}>('counter', {name: 'transfers'})).toMatchObject({value: 1});
	});

	it('indexes the source INDEXING_SOURCE names, with NO chain call to resolve it', async () => {
		const chain = fakeChain().serve(LOGS, TIP);

		const prepared = await prepareIndexing('build', IMAGE, {
			env: {
				DB: ':memory:',
				ETH_NODE_URI: 'http://node.from.env',
				INDEXING_SOURCE: JSON.stringify({
					chainId: '1',
					contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
				}),
			},
			importModule: async () => entityModule,
			provider: chain.provider,
			createDB: () => oneDatabase(),
			sleep: async () => {},
		});

		expect(prepared.source).toMatchObject({chainId: '1'});
		// the module here DOES key its contracts per chain, so the module route would
		// have asked. Nothing did: an explicitly given source is chain-free, which is
		// what makes it available to the one command that can make no chain call
		expect(chain.calls.map((call) => call.method)).not.toContain('eth_chainId');
	});

	it('refuses a missing node url before it imports the module or opens a database', async () => {
		const chain = noChain();
		const opened: string[] = [];
		let imported = false;

		await expect(
			prepareIndexing('build', IMAGE, {
				env: {DB: ':memory:'},
				importModule: async () => {
					imported = true;
					return entityModule;
				},
				provider: chain.provider,
				createDB: (url) => {
					opened.push(url);
					return oneDatabase();
				},
			}),
		).rejects.toThrow(/--node-url \(ETH_NODE_URI\)/);

		expect(chain.calls).toEqual([]);
		expect(opened).toEqual([]);
		expect(imported).toBe(false);
	});
});

describe('`serve`, configured from the environment', () => {
	/** `startServer`, replaced by a recorder: what reaches the adapter is the assertion. */
	function recorder() {
		const started: {db: string; port: number; hostname?: string; autoSetup: boolean}[] = [];
		return {
			started,
			startServer: async (options: {db: string; port: number; hostname?: string; autoSetup: boolean}) => {
				started.push(options);
				// the HANDLE the adapter opened comes back too, because the read tier resolves
				// the canonical pointer over it to say which generation answers (ADR-0053)
				return {url: `http://localhost:${options.port}`, port: options.port, db: oneDatabase()};
			},
		};
	}

	it('hands the adapter the database it resolved, so the adapter default is never reached', async () => {
		const adapter = recorder();
		await serve({}, {env: {DB: 'file:./written-elsewhere.db'}, startServer: adapter.startServer, log: () => {}});

		expect(adapter.started).toEqual([{db: 'file:./written-elsewhere.db', port: 2000, autoSetup: true}]);
	});

	it('lets the flag beat the variable, and carries the address through', async () => {
		const adapter = recorder();
		await serve(
			{db: 'file:./flagged.db', port: '3000', host: '127.0.0.1', autoSetup: false},
			{env: {DB: 'file:./from-env.db', PORT: '4000'}, startServer: adapter.startServer, log: () => {}},
		);

		expect(adapter.started[0]).toEqual({
			db: 'file:./flagged.db',
			port: 3000,
			hostname: '127.0.0.1',
			autoSetup: false,
		});
	});

	it('refuses to start on a database nobody named, rather than creating one', async () => {
		const adapter = recorder();
		await expect(serve({}, {env: {}, startServer: adapter.startServer, log: () => {}})).rejects.toThrow(
			/--db \(DB\).*nobody named/s,
		);
		expect(adapter.started).toEqual([]);
	});

	it('refuses a processor it cannot host before it binds anything', async () => {
		const adapter = recorder();
		await expect(
			serve({db: ':memory:', processor: './p.js'}, {env: {}, startServer: adapter.startServer, log: () => {}}),
		).rejects.toThrow(/read tier holds no processor/);
		expect(adapter.started).toEqual([]);
	});
});
