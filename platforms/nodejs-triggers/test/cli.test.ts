import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {encodeAbiParameters, encodeEventTopics} from 'viem';
import {
	createNodeService,
	defineConfig,
	delegatedIdentityVerifier,
	loadConfig,
	rewardAction,
	runCLI,
	type AppConfig,
	type NodeConfig,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// THE CLI, port-free: every command but `run` against a config whose feed is a
// scripted canonical view and whose reward target is a recording fetch. `run`
// is the one that listens, and its long-lived half is injected.
// ---------------------------------------------------------------------------

const BOARD = '0x00000000000000000000000000000000000000b0';
const ALICE = '0x00000000000000000000000000000000000000a1';
const abi = [
	{
		type: 'event',
		name: 'Posted',
		inputs: [
			{indexed: true, name: 'author', type: 'address'},
			{indexed: false, name: 'count', type: 'uint256'},
			{indexed: false, name: 'text', type: 'string'},
		],
	},
] as const;

/** A canonical view serving one post by Alice, then nothing more. */
const feedFetch = (async () =>
	Response.json({
		success: true,
		stream: 's',
		generation: 'g',
		entries: [
			{
				blockNumber: 101,
				blockHash: '0xa101',
				logIndex: 0,
				transactionHash: '0x01',
				transactionIndex: 0,
				address: BOARD,
				topics: encodeEventTopics({abi, eventName: 'Posted', args: {author: ALICE}}),
				data: encodeAbiParameters([{type: 'uint256'}, {type: 'string'}], [3n, 'hello']),
			},
		],
		cursor: 'c',
		hasMore: false,
	})) as unknown as typeof fetch;

let dir: string;
let output: string[];
let errors: string[];
let rewardCalls: number;
let config: NodeConfig;
let app: AppConfig;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'etherfold-triggers-cli-'));
	output = [];
	errors = [];
	rewardCalls = 0;
	app = {
		chainId: '1',
		etherfold: {url: 'http://etherfold.test', indexer: 'board', fetch: feedFetch},
		gate: async () => 1000,
		triggers: {
			events: {posted: {address: BOARD, abi: abi[0]}},
			rules: {
				'third-post': {
					event: 'posted',
					recipients: (log) => log.args['author'] as string,
					predicate: (log) => (log.args['count'] as bigint) >= 3n,
					action: 'reward',
					key: (_log, recipient) => `third-post:${recipient}`,
					render: () => ({achievement: 'third-post'}),
				},
			},
		},
		actions: {
			reward: rewardAction({
				url: 'https://rewards.test',
				token: 't',
				policy: {maxAttempts: 1, backoff: {initialMs: 1, maxMs: 1}},
				fetch: (async () => {
					rewardCalls++;
					return new Response('down', {status: 500});
				}) as unknown as typeof fetch,
			}),
		},
	};
	config = defineConfig({database: `file:${join(dir, 'triggers.db')}`, apps: {board: app}});
});
afterEach(() => rmSync(dir, {recursive: true, force: true}));

const cli = (...argv: string[]) =>
	runCLI(argv, {
		stdout: (line) => output.push(line),
		stderr: (line) => errors.push(line),
		loadConfig: async () => config,
	});

describe('the CLI', () => {
	it('runs one round, then shows the outbox, the journal and the consumer', async () => {
		expect(await cli('tick')).toBe(0);
		expect(JSON.parse(output[0]!)).toMatchObject({app: 'board', consumed: 1, matched: 1, delivery: {dead: 1}});
		expect(rewardCalls).toBe(1);

		output = [];
		expect(await cli('deliveries', '--status', 'dead')).toBe(0);
		expect(output.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({action: 'reward', key: `third-post:${ALICE}`, status: 'dead'}),
		]);

		output = [];
		await cli('journal', '--kind', 'dead-lettered');
		expect(output).toHaveLength(1);

		output = [];
		await cli('status');
		expect(JSON.parse(output[0]!)).toMatchObject({app: 'board', cursor: 'c', generation: 'g'});
	});

	it('requeues a dead letter, and refuses anything else', async () => {
		await cli('tick');
		expect(await cli('requeue', '1')).toBe(0);
		expect(await cli('requeue', '1')).toBe(1);
		expect(await cli('requeue', 'x')).toBe(1);
		await cli('tick');
		expect(rewardCalls).toBe(2);
	});

	it('hands run to the long-lived half, and prints its usage', async () => {
		let served: NodeConfig | undefined;
		await runCLI(['run'], {
			stdout: () => undefined,
			stderr: () => undefined,
			loadConfig: async () => config,
			serve: async (given) => void (served = given),
		});
		expect(served).toBe(config);
		served = undefined;
		const errors: string[] = [];
		expect(
			await runCLI(['run', '--app', 'board'], {
				stdout: () => undefined,
				stderr: (line) => void errors.push(line),
				loadConfig: async () => config,
				serve: async (given) => void (served = given),
			}),
		).toBe(1);
		expect(served).toBeUndefined();
		expect(errors.join('\n')).toMatch(/--app/);
		expect(await cli('--help')).toBe(0);
		expect(output.join('\n')).toMatch(/requeue <id>/);
		expect(await cli('nope')).toBe(1);
	});
});

describe('the CLI over several apps', () => {
	beforeEach(() => {
		config = {...config, apps: {board: app, forum: {...app, etherfold: {...app.etherfold, indexer: 'forum'}}}};
	});

	it('ticks, shows the status, the outbox and the journal of every app, each line naming its app', async () => {
		expect(await cli('tick')).toBe(0);
		expect(output.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({app: 'board', consumed: 1}),
			expect.objectContaining({app: 'forum', consumed: 1}),
		]);

		output = [];
		await cli('status');
		expect(output.map((line) => JSON.parse(line).app)).toEqual(['board', 'forum']);
		output = [];
		await cli('deliveries', '--status', 'dead');
		expect(output.map((line) => JSON.parse(line).app)).toEqual(['board', 'forum']);
		output = [];
		await cli('journal', '--kind', 'dead-lettered');
		expect(output.map((line) => JSON.parse(line).app)).toEqual(['board', 'forum']);
	});

	it('with --app, ticks, shows the status, the outbox and the journal of that app only', async () => {
		expect(await cli('tick', '--app', 'forum')).toBe(0);
		expect(output.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({app: 'forum', consumed: 1})]);
		expect(rewardCalls).toBe(1);

		output = [];
		await cli('status', '--app', 'forum');
		expect(output.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({app: 'forum', generation: 'g'})]);
		await cli('tick');
		output = [];
		await cli('deliveries', '--status', 'dead', '--app', 'board');
		expect(output.map((line) => JSON.parse(line).app)).toEqual(['board']);
		output = [];
		await cli('journal', '--kind', 'dead-lettered', '--app', 'forum');
		expect(output.map((line) => JSON.parse(line).app)).toEqual(['forum']);
	});

	it('refuses an unknown --app, listing the configured apps', async () => {
		for (const command of ['status', 'tick', 'resume', 'deliveries', 'journal']) {
			expect(await cli(command, '--app', 'nope')).toBe(1);
			expect(errors.at(-1)).toMatch(/no app .nope. in this config \(its apps: board, forum\)/);
		}
		expect(await cli('requeue', '1', '--app', 'nope')).toBe(1);
		expect(errors.at(-1)).toMatch(/no app .nope. in this config \(its apps: board, forum\)/);
		expect(output).toEqual([]);
	});

	it('requeues a row of the app it names, refuses a row of another app, and says whose row it was', async () => {
		await cli('tick');
		output = [];
		await cli('deliveries', '--status', 'dead');
		const ids = Object.fromEntries(output.map((line) => JSON.parse(line)).map((row) => [row.app, row.id]));

		expect(await cli('requeue', String(ids['forum']), '--app', 'board')).toBe(1);
		expect(errors.at(-1)).toMatch(new RegExp(`delivery ${ids['forum']} belongs to the app forum, not board`));
		output = [];
		await cli('deliveries', '--status', 'dead');
		expect(output).toHaveLength(2);

		output = [];
		expect(await cli('requeue', String(ids['board']), '--app', 'board')).toBe(0);
		expect(JSON.parse(output[0]!)).toEqual({app: 'board', requeued: ids['board']});
		output = [];
		expect(await cli('requeue', String(ids['forum']))).toBe(0);
		expect(JSON.parse(output[0]!)).toEqual({app: 'forum', requeued: ids['forum']});
		output = [];
		await cli('deliveries', '--status', 'pending');
		expect(output.map((line) => JSON.parse(line).app)).toEqual(['board', 'forum']);
		expect(await cli('requeue', '999')).toBe(1);
		expect(errors.at(-1)).toMatch(/no app of this config has a delivery 999/);
	});

	it('names every app holding a row of an id when the apps keep their own databases', async () => {
		config = {
			...config,
			apps: {
				board: {...app, database: `file:${join(dir, 'board.db')}`},
				forum: {...app, database: `file:${join(dir, 'forum.db')}`},
			},
		};
		await cli('tick');
		expect(await cli('requeue', '1')).toBe(1);
		expect(errors.at(-1)).toMatch(/several apps have a delivery 1 \(board, forum\): name one with --app/);
		expect(await cli('requeue', '1', '--app', 'forum')).toBe(0);
	});

	it('reports a failed round of one app beside the other, and exits 1', async () => {
		config = {
			...config,
			apps: {...config.apps, board: {...app, gate: async () => Promise.reject(new Error('no gate'))}},
		};
		expect(await cli('tick')).toBe(1);
		expect(output.map((line) => JSON.parse(line))).toEqual([
			{app: 'board', error: 'no gate'},
			expect.objectContaining({app: 'forum', consumed: 1}),
		]);
	});
});

describe('the CLI over several apps paused on a generation change', () => {
	/** A canonical view whose fold changes after its first page: `g1`, then `g2`. */
	const promotingFeed = () => {
		let reads = 0;
		return (async () =>
			Response.json({
				success: true,
				stream: 's',
				generation: reads++ === 0 ? 'g1' : 'g2',
				entries: [],
				cursor: 'c',
				hasMore: false,
			})) as unknown as typeof fetch;
	};

	beforeEach(() => {
		const fed = (indexer: string): AppConfig => ({
			...app,
			etherfold: {url: 'http://etherfold.test', indexer, fetch: promotingFeed()},
		});
		config = {...config, apps: {board: fed('board'), forum: fed('forum'), quiet: app}};
	});

	it('says which app is paused, the generation it left and the one it found', async () => {
		await cli('tick');
		await cli('tick');
		output = [];
		await cli('status', '--app', 'forum');
		expect(output.map((line) => JSON.parse(line))).toEqual([
			{
				app: 'forum',
				cursor: 'c',
				stream: 's',
				generation: 'g1',
				paused: {kind: 'generation-changed', from: 'g1', to: 'g2'},
			},
		]);
		output = [];
		await cli('status');
		expect(output.map((line) => JSON.parse(line)).map((status) => [status.app, status.paused?.kind])).toEqual([
			['board', 'generation-changed'],
			['forum', 'generation-changed'],
			['quiet', undefined],
		]);
	});

	it('resumes the app it names only, and without --app refuses two paused apps, naming both', async () => {
		await cli('tick');
		await cli('tick');
		expect(await cli('resume')).toBe(1);
		expect(errors.at(-1)).toMatch(/several apps are paused \(board, forum\): name one with --app/);

		output = [];
		expect(await cli('resume', '--app', 'board')).toBe(0);
		expect(JSON.parse(output[0]!)).toEqual({app: 'board', cursor: 'c', stream: 's', generation: 'g2'});
		output = [];
		await cli('status', '--app', 'forum');
		expect(JSON.parse(output[0]!)).toMatchObject({app: 'forum', paused: {kind: 'generation-changed'}});

		// one paused app left: resume acts on it, and says which
		output = [];
		expect(await cli('resume')).toBe(0);
		expect(JSON.parse(output[0]!)).toEqual({app: 'forum', cursor: 'c', stream: 's', generation: 'g2'});
		expect(await cli('resume')).toBe(1);
		expect(errors.at(-1)).toMatch(/no app is paused/);
	});
});

describe('the per-call timeout', () => {
	it("is the config's `callTimeoutMs`: a gate that never answers fails the round after it", async () => {
		const node = await createNodeService({
			...config,
			apps: {board: {...app, gate: () => new Promise<number>(() => {}), callTimeoutMs: 30}},
		});
		try {
			expect(await node.tick()).toEqual([{app: 'board', error: expect.any(String), code: 'gate-timeout'}]);
		} finally {
			node.close();
		}
	});
});

describe("the app's lease", () => {
	it('is released at the end of a `tick`, so two `tick` commands in a row both deliver', async () => {
		app.actions = {
			reward: rewardAction({
				url: 'https://rewards.test',
				token: 't',
				policy: {maxAttempts: 2, backoff: {initialMs: 1, maxMs: 1}},
				fetch: (async () => {
					rewardCalls++;
					return new Response('down', {status: 500});
				}) as unknown as typeof fetch,
			}),
		};
		expect(await cli('tick')).toBe(0);
		expect(JSON.parse(output[0]!)).toMatchObject({app: 'board', lease: 'held', delivery: {retried: 1}});
		await new Promise((resolve) => setTimeout(resolve, 5)); // past the retry's backoff

		// a second process, with a lease of its own: the first gave its up
		output = [];
		expect(await cli('tick')).toBe(0);
		expect(JSON.parse(output[0]!)).toMatchObject({app: 'board', lease: 'held', delivery: {attempted: 1, dead: 1}});
		expect(rewardCalls).toBe(2);

		const node = await createNodeService(config);
		try {
			const {results} = await node.apps['board']!.db.prepare(`SELECT lease_expires FROM consumers`).all();
			expect(results).toEqual([{lease_expires: 0}]);
		} finally {
			node.close();
		}
	});

	it("is the config's `leaseMs`, and a `callTimeoutMs` too long for it is refused at start, naming both", async () => {
		await expect(createNodeService({...config, apps: {board: {...app, callTimeoutMs: 25_000}}})).rejects.toThrow(
			/25000 ms.*60000 ms/,
		);
		const node = await createNodeService({...config, apps: {board: {...app, callTimeoutMs: 25_000, leaseMs: 120_000}}});
		try {
			expect(node.apps['board']!.service.lease.durationMs).toBe(120_000);
			expect(await node.tick()).toEqual([expect.objectContaining({app: 'board', lease: 'held'})]);
		} finally {
			await node.release();
			node.close();
		}
	});
});

describe('the registration API `run` serves', () => {
	it("answers CORS for the served app's origin, with nothing more in the config than its verifier", async () => {
		const node = await createNodeService({
			...config,
			apps: {
				board: {
					...app,
					verifier: delegatedIdentityVerifier({serverOrigin: 'https://triggers.test', domain: 'game.test'}),
				},
			},
		});
		try {
			const preflight = (origin: string) =>
				node.api!.request('https://triggers.test/board/subscriptions', {
					method: 'OPTIONS',
					headers: {
						Origin: origin,
						'Access-Control-Request-Method': 'POST',
						'Access-Control-Request-Headers': 'content-type,signature',
					},
				});
			const allowed = await preflight('https://game.test');
			expect(allowed.status).toBe(204);
			expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://game.test');
			expect((await preflight('https://evil.test')).headers.get('Access-Control-Allow-Origin')).toBeNull();
		} finally {
			node.close();
		}
	});
});

describe('a config file', () => {
	it('is its module default export', async () => {
		expect(await loadConfig(join(import.meta.dirname, 'fixtures/minimal.config.mjs'))).toMatchObject({
			apps: {board: {chainId: '1'}},
		});
		await expect(loadConfig(join(import.meta.dirname, 'fixtures/no-default.mjs'))).rejects.toThrow(/no default export/);
	});

	it('in the old flat shape is refused, showing the `apps` shape', async () => {
		await expect(loadConfig(join(import.meta.dirname, 'fixtures/flat.config.mjs'))).rejects.toThrow(
			/no `apps`[\s\S]*export default defineConfig\(\{[\s\S]*apps: \{/,
		);
	});
});
