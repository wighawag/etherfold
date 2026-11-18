import {createHash} from 'node:crypto';
import {createClient} from '@libsql/client';
import {
	StreamBuilder,
	generationDigestOf,
	resolveStreamConfig,
	serializeWireBatch,
	streamDigestOf,
	type Abi,
	type GenerationId,
	type IndexingSource,
	type LogEvent,
} from '@etherfold/core';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {
	createServer,
	emissionAppenderFor,
	indexerRegistry,
	openGenerationRegistryOnSQL,
	singleContextEntry,
} from '@etherfold/server';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {encodeAbiParameters, encodeEventTopics} from 'viem';

// ---------------------------------------------------------------------------
// AN ETHERFOLD SERVER IN THIS PROCESS, folding the repo's own test contract
// (or another fold: the greetings').
// ---------------------------------------------------------------------------
// The same shape as `@etherfold/server`'s own feed harness: a StreamBuilder per
// named indexer whose emissions are appended to the server's database, and
// batches pushed through the real `/{indexer}/ingest` route, so the canonical
// view and its rewinds are the server's own and never synthesised. The fold
// writes into the namespace of the database's CANONICAL generation, so the
// server's `/graphql` answers its state as `etherfold run` does, pinned to a
// block. The app is reached through its `fetch`: no port is opened.
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

/** The fold: each author's post count, so the processor is a real one. */
const boardProcessor: EntityProcessor<BoardABI> = {
	entities: [{name: 'author', id: ['address'], fields: {posts: 'integer'}}],
	async onPosted(state, event) {
		const address = (event.args as {author: string}).author.toLowerCase();
		const current = await state.get('author', {address});
		state.set('author', {address}, {posts: Number(current?.posts ?? 0) + 1});
	},
};

/** What one in-process etherfold folds: a named indexer over one contract. */
export type Fold<ABI extends Abi> = {
	indexer: string;
	abi: ABI;
	address: `0x${string}`;
	processor: EntityProcessor<ABI>;
	/** Names the processor's bytes, as a bundle's identity does. */
	marker: string;
};

export const BOARD_FOLD: Fold<BoardABI> = {
	indexer: INDEXER,
	abi: boardAbi,
	address: BOARD,
	processor: boardProcessor,
	marker: 'the-board-fold',
};

/** A block's hash as a node gives it, 32 bytes, on a named branch: `/graphql` takes no shorter one. */
export function blockHash(block: number, branch = 'a'): `0x${string}` {
	return `0x${branch}${block.toString(16).padStart(63, '0')}` as `0x${string}`;
}

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

export type Etherfold<ABI extends Abi = BoardABI> = {
	/** What a consumer is handed: the app's own fetch, as `fetch` is. */
	fetch: typeof fetch;
	/** Push one batch through `/{indexer}/ingest`, refusing to carry on unless it was accepted. */
	ingest(fromBlock: number, toBlock: number, logs: LogEvent<ABI>[]): Promise<void>;
};

export async function startEtherfold<ABI extends Abi = BoardABI>(
	fold: Fold<ABI> = BOARD_FOLD as unknown as Fold<ABI>,
): Promise<Etherfold<ABI>> {
	const source: IndexingSource<ABI> = {
		chainId: CHAIN_ID,
		contracts: [{abi: fold.abi, address: fold.address, startBlock: START_BLOCK}],
	};
	const processorIdentity = `sha256:${createHash('sha256').update(fold.marker).digest('hex')}`;
	const generation: GenerationId = {
		stream: streamDigestOf(source, resolveStreamConfig({finality: FINALITY})),
		processor: processorIdentity,
	};

	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	// the fold writes into the namespace of the generation `/graphql` answers from
	const processor = new VersionedStateEventProcessor<ABI>(db, fold.processor, {
		tableNamespace: generationDigestOf(generation),
	});
	const builder = new StreamBuilder<ABI, unknown>(processor, source, {
		stream: {finality: FINALITY},
		appendEmissions: emissionAppenderFor(db, fold.indexer),
		processorIdentity,
	});
	const app = createServer<{INGEST_TOKEN?: string}>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN}),
		getIndexer: indexerRegistry({[fold.indexer]: singleContextEntry(db, builder)}),
		graphql: {declarationsOf: async () => fold.processor.entities},
	});
	await app.request('/admin/setup', {method: 'POST'});
	// and that generation is the database's canonical one, as a folding process leaves it
	const generations = await openGenerationRegistryOnSQL(db, fold.indexer, {caps: {maxGenerations: 4, maxStreams: 4}});
	await generations.create(generation);
	await generations.moveCanonicalTo(generation);

	const served = (async (input: RequestInfo | URL, init?: RequestInit) =>
		app.fetch(new Request(input, init))) as typeof fetch;

	return {
		fetch: served,
		async ingest(fromBlock, toBlock, logs) {
			const res = await app.request(`/${fold.indexer}/ingest`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
				body: serializeWireBatch({context: builder.context, fromBlock, toBlock, latestBlock: toBlock, logs}),
			});
			if (res.status !== 200) throw new Error(`ingest refused (${res.status}): ${await res.text()}`);
		},
	};
}
