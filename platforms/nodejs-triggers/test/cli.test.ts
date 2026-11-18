import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {encodeAbiParameters, encodeEventTopics} from 'viem';
import {defineConfig, loadConfig, rewardAction, runCLI, type NodeConfig} from '../src/index.js';

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

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'etherfold-triggers-cli-'));
	output = [];
	errors = [];
	rewardCalls = 0;
	config = defineConfig({
		chainId: '1',
		database: `file:${join(dir, 'triggers.db')}`,
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
	});
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
		expect(JSON.parse(output[0]!)).toMatchObject({consumed: 1, matched: 1, delivery: {dead: 1}});
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
		expect(JSON.parse(output[0]!)).toMatchObject({name: 'board', cursor: 'c', generation: 'g'});
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
		expect(await cli('--help')).toBe(0);
		expect(output.join('\n')).toMatch(/requeue <id>/);
		expect(await cli('nope')).toBe(1);
	});
});

describe('a config file', () => {
	it('is its module default export', async () => {
		expect(await loadConfig(join(import.meta.dirname, 'fixtures/minimal.config.mjs'))).toMatchObject({chainId: '1'});
		await expect(loadConfig(join(import.meta.dirname, 'fixtures/no-default.mjs'))).rejects.toThrow(/no default export/);
	});
});
