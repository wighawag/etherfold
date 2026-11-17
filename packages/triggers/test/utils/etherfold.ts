import {createHash} from 'node:crypto';
import {createClient} from '@libsql/client';
import {StreamBuilder, serializeWireBatch, type Abi, type IndexingSource, type LogEvent} from '@etherfold/core';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {createServer, emissionAppenderFor, indexerRegistry, singleContextEntry} from '@etherfold/server';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {encodeAbiParameters, encodeEventTopics} from 'viem';

// ---------------------------------------------------------------------------
// AN ETHERFOLD SERVER IN THIS PROCESS, folding the repo's own test contract.
// ---------------------------------------------------------------------------
// The same shape as `@etherfold/server`'s own feed harness: a StreamBuilder per
// named indexer whose emissions are appended to the server's database, and
// batches pushed through the real `/{indexer}/ingest` route, so the canonical
// view and its rewinds are the server's own and never synthesised. The app is
// reached through its `fetch`: no port is opened.
// ---------------------------------------------------------------------------

/** The test contract: a board anyone may post on, which counts each author's posts. */
export const boardAbi = [
	{
		type: 'event',
		name: 'Posted',
		anonymous: false,
		inputs: [
			{indexed: true, name: 'author', type: 'address'},
			{indexed: false, name: 'count', type: 'uint256'},
			{indexed: false, name: 'text', type: 'string'},
		],
	},
] as const satisfies Abi;

export type BoardABI = typeof boardAbi;

export const BOARD = '0x00000000000000000000000000000000000000b0' as const;
export const ALICE = '0x00000000000000000000000000000000000000a1' as const;
export const BOB = '0x00000000000000000000000000000000000000b2' as const;
export const CAROL = '0x00000000000000000000000000000000000000c3' as const;

export const CHAIN_ID = '31337';
export const INDEXER = 'board';
export const START_BLOCK = 100;
export const FINALITY = 3;
const TOKEN = 'the-ingest-token';
export const BASE_URL = 'http://etherfold.test';

const SOURCE: IndexingSource<BoardABI> = {
	chainId: CHAIN_ID,
	contracts: [{abi: boardAbi, address: BOARD, startBlock: START_BLOCK}],
};

/** The fold: each author's post count, so the processor is a real one. */
const boardProcessor: EntityProcessor<BoardABI> = {
	entities: [{name: 'author', id: ['address'], fields: {posts: 'integer'}}],
	async onPosted(state, event) {
		const address = (event.args as {author: string}).author.toLowerCase();
		const current = await state.get('author', {address});
		state.set('author', {address}, {posts: Number(current?.posts ?? 0) + 1});
	},
};

const PROCESSOR_IDENTITY = `sha256:${createHash('sha256').update('the-board-fold').digest('hex')}`;

let transactionCounter = 0;

export type Post = {block: number; hash: string; author: string; count: bigint; text?: string; logIndex?: number};

/** One `Posted` log, encoded as a node would report it and decoded as the fetcher would. */
export function posted({block, hash, author, count, text = 'hello', logIndex = 0}: Post): LogEvent<BoardABI> {
	transactionCounter++;
	const topics = encodeEventTopics({abi: boardAbi, eventName: 'Posted', args: {author: author as `0x${string}`}});
	const data = encodeAbiParameters([{type: 'uint256'}, {type: 'string'}], [count, text]);
	return {
		blockNumber: block,
		blockHash: hash as `0x${string}`,
		blockTimestamp: 1_700_000_000 + block * 12,
		transactionIndex: 0,
		removed: false,
		address: BOARD,
		data,
		topics,
		transactionHash: `0x${transactionCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex,
		extra: undefined,
		eventName: 'Posted',
		args: {author, count, text},
	} as unknown as LogEvent<BoardABI>;
}

export type Etherfold = {
	/** What a consumer is handed: the app's own fetch, as `fetch` is. */
	fetch: typeof fetch;
	/** Push one batch through `/{indexer}/ingest`, refusing to carry on unless it was accepted. */
	ingest(fromBlock: number, toBlock: number, logs: LogEvent<BoardABI>[]): Promise<void>;
};

export async function startEtherfold(): Promise<Etherfold> {
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	const processor = new VersionedStateEventProcessor<BoardABI>(
		new RemoteLibSQL(createClient({url: ':memory:'})),
		boardProcessor,
	);
	const builder = new StreamBuilder<BoardABI, unknown>(processor, SOURCE, {
		stream: {finality: FINALITY},
		appendEmissions: emissionAppenderFor(db, INDEXER),
		processorIdentity: PROCESSOR_IDENTITY,
	});
	const app = createServer<{INGEST_TOKEN?: string}>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN}),
		getIndexer: indexerRegistry({[INDEXER]: singleContextEntry(db, builder)}),
	});
	await app.request('/admin/setup', {method: 'POST'});

	const served = (async (input: RequestInfo | URL, init?: RequestInit) =>
		app.fetch(new Request(input, init))) as typeof fetch;

	return {
		fetch: served,
		async ingest(fromBlock, toBlock, logs) {
			const res = await app.request(`/${INDEXER}/ingest`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
				body: serializeWireBatch({context: builder.context, fromBlock, toBlock, latestBlock: toBlock, logs}),
			});
			if (res.status !== 200) throw new Error(`ingest refused (${res.status}): ${await res.text()}`);
		},
	};
}
