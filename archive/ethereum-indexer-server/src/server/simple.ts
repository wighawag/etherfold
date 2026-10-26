import 'named-logs-console';

import Koa from 'koa';
import Router from 'koa-router';
import crypto from 'crypto';

import logger from 'koa-logger';
import json from 'koa-json';
import bodyParser from 'koa-bodyparser';

import {IndexingSource, EthereumIndexer, EventProcessor, LastSync, Abi, ExistingStream} from '@etherfold/core';
import {JSONRPCHTTPProvider} from '@eip-1193/jsonrpc-provider';
import {ProcessorFilesystemCache} from '@etherfold/fs-cache';

import {logs} from 'named-logs';

import {
	bnReplacer,
	EventCache,
	PouchDatabase,
	QueriableEventProcessor,
	Query,
	setupCache,
} from 'ethereum-indexer-db-utils';
import {getAdminPage} from '../pages/index.js';
import type {EIP1193CoreProvider} from 'eip-1193';
import {clean, formatLastSync, removeUndefinedValuesFromObject, resolveProcessorAndSource} from '@etherfold/utils';

const namedLogger = logs('ethereum-index-server');

export type UserConfig<ABI extends Abi> = {
	nodeURL: string;
	folder: string;
	processorPath: string;
	source?: IndexingSource<ABI>;
	useCache?: boolean;
	disableSecurity?: boolean;
	useFSCache?: boolean;
	port?: number;
	// Optional factory used to construct the EIP-1193 provider from the node URL. Defaults to
	// `new JSONRPCHTTPProvider(nodeURL)`. Useful for injecting a custom provider or a fake/spy in
	// tests. When omitted the behaviour is unchanged.
	createProvider?: (nodeURL: string) => EIP1193CoreProvider;
};

type Config = {
	nodeURL: string;
	folder: string;
	processorPath: string;
	useCache: boolean;
	disableSecurity: boolean;
	useFSCache: boolean;
	port: number;
};

export class SimpleServer<ABI extends Abi, ProcessResultType> {
	protected indexer: EthereumIndexer<ABI, ProcessResultType> | undefined;
	protected app: Koa | undefined;
	protected lastSync: LastSync<ABI> | undefined;
	protected config: Config;
	protected cache: EventCache<ABI, ProcessResultType> | undefined;
	protected processor: QueriableEventProcessor<ABI, ProcessResultType> | undefined;
	protected indexing: boolean = false;
	protected indexingTimeout: NodeJS.Timeout | undefined;

	// Last error from the auto-index loop, surfaced in the `/` status so a stuck/retrying server is
	// observable instead of silently reporting `indexing: true`.
	protected lastError: {message: string; at: number} | undefined;
	// Number of consecutive auto-index failures, used to compute exponential backoff.
	protected consecutiveErrors: number = 0;
	// Serializes ALL indexing entrypoints (auto loop, manual /indexMore, /feed, /replay) so they do
	// not run concurrently on the same indexer instance. Holds the in-flight operation's promise.
	protected inFlightIndexing: Promise<unknown> | undefined;

	protected source: IndexingSource<ABI> | undefined;

	constructor(config: UserConfig<ABI>) {
		this.config = Object.assign(
			{useCache: false, disableSecurity: false, useFSCache: false, port: 14385},
			removeUndefinedValuesFromObject(config),
		);
		this.source = config.source;
		this.createProvider = config.createProvider;
	}

	protected createProvider: ((nodeURL: string) => EIP1193CoreProvider) | undefined;

	async start(config: {autoIndex: boolean}) {
		// TODO allow to pass processor configuration
		await this.setupIndexing();
		const server = this.startServer();
		if (config.autoIndex) {
			this.startIndexing();
		}
		return server;
	}

	private async setupIndexing() {
		const eip1193Provider = this.createProvider
			? this.createProvider(this.config.nodeURL)
			: new JSONRPCHTTPProvider(this.config.nodeURL);

		// Processor/source resolution is shared with the CLI via `resolveProcessorAndSource` in
		// @etherfold/utils. The server intentionally passes its `folder` as the processor factory
		// argument (the CLI passes nothing) — this difference is now an explicit `processorConfig`.
		const {processor, source} = await resolveProcessorAndSource<ABI, ProcessResultType>({
			processorPath: this.config.processorPath,
			provider: eip1193Provider,
			source: this.source,
			processorConfig: this.config.folder,
		});
		this.processor = processor as QueriableEventProcessor<ABI, ProcessResultType>;
		this.source = source;

		let rootProcessor: EventProcessor<ABI, ProcessResultType> = this.processor;
		let streamKeeper: ExistingStream<ABI> | undefined;
		if (this.config.useCache) {
			const eventCacheDB = new PouchDatabase(`${this.config.folder}/event-stream.db`);
			this.cache = new EventCache(this.processor, eventCacheDB);
			rootProcessor = this.cache;
			// streamKeeper option ?
			// streamKeeper = await setupCache(new PouchDatabase(`${this.config.folder}/event-stream.db`));
		}

		if (this.config.useFSCache) {
			rootProcessor = new ProcessorFilesystemCache(rootProcessor, this.config.folder);
		}

		this.indexer = new EthereumIndexer(
			eip1193Provider,
			rootProcessor,
			this.source,
			{
				providerSupportsETHBatch: true,
				keepStream: streamKeeper,
			},
		);

		namedLogger.info(`LOADING....`);
		this.lastSync = await this.indexer.load();
	}

	private startIndexing(): boolean {
		if (!this.indexing) {
			this.index();
			return true;
		} else {
			return false;
		}
	}

	private stopIndexing(): boolean {
		if (this.indexing) {
			if (this.indexingTimeout) {
				clearTimeout(this.indexingTimeout);
			}
			this.indexing = false;
			return true;
		} else {
			return false;
		}
	}

	private async startServer() {
		const self = this;
		this.app = new Koa();
		const router = new Router();

		let apiKeys: string[];
		if (process.env.ETHEREUM_INDEXER_API_KEY) {
			apiKeys = process.env.ETHEREUM_INDEXER_API_KEY.split(',');
		} else {
			const apiKey = crypto.randomUUID();
			apiKeys = [apiKey];
			console.log(`generated apiKey: ${apiKey}`);
		}

		// Constant-time comparison so an attacker cannot learn the key byte-by-byte from response
		// timing. Returns true if `provided` matches any configured key.
		function matchesAnyKey(provided: unknown): boolean {
			if (typeof provided !== 'string' || provided.length === 0) {
				return false;
			}
			const providedBuf = Buffer.from(provided);
			let matched = false;
			for (const key of apiKeys) {
				const keyBuf = Buffer.from(key);
				// timingSafeEqual requires equal lengths; comparing lengths first leaks only the length,
				// not the contents. Use a length-padded compare to keep it constant-time per key.
				if (keyBuf.length === providedBuf.length && crypto.timingSafeEqual(keyBuf, providedBuf)) {
					matched = true;
				}
			}
			return matched;
		}

		function isAuthorized(ctx: any): boolean {
			if (self.config.disableSecurity) {
				return true;
			}
			// TODO pass api key in get request ?
			const apiKeyProvided = ctx.request.header.authorization || ctx.request.body.apiKey;
			return matchesAnyKey(apiKeyProvided);
		}

		router.get('/', async (ctx, next) => {
			if (!this.indexer || !this.lastSync) {
				ctx.status = 503;
				ctx.body = {error: {code: 503, message: 'Server not ready (indexing not set up yet).'}};
				await next();
				return;
			}

			const startingBlock = this.indexer.defaultFromBlock;
			const latestBlock = this.lastSync.latestBlock;
			const lastToBlock = this.lastSync.lastToBlock;

			const totalToProcess = latestBlock - startingBlock;
			const numBlocksProcessedSoFar = Math.max(0, lastToBlock - startingBlock);

			const lastSyncObject = formatLastSync(this.lastSync);
			lastSyncObject.numBlocksProcessedSoFar = numBlocksProcessedSoFar;
			lastSyncObject.syncPercentage = Math.floor((numBlocksProcessedSoFar * 1000000) / totalToProcess) / 10000;
			lastSyncObject.totalPercentage = Math.floor((lastToBlock * 1000000) / latestBlock) / 10000;

			// allow to get state whole
			const lastError = this.lastError;
			const data = (this.processor as any).json;
			if (data) {
				const _data = (this.processor as any)._json;
				if (_data) {
					ctx.body = bnReplacer({lastSync: lastSyncObject, indexing: this.indexing, lastError, data, _data});
				} else {
					ctx.body = bnReplacer({lastSync: lastSyncObject, indexing: this.indexing, lastError, data});
				}
			} else {
				const _data = (this.processor as any)._json;
				if (_data) {
					ctx.body = bnReplacer({lastSync: lastSyncObject, indexing: this.indexing, lastError, _data});
				} else {
					ctx.body = bnReplacer({lastSync: lastSyncObject, indexing: this.indexing, lastError});
				}
			}

			await next();
		});

		// TODO what about kind ?
		// feel like we shold consider it first class citizen
		// get is always a kind plus an id
		// multiple kinds is separate stuff
		router.get('/get/:id', async (ctx, next) => {
			if (!this.processor) {
				ctx.status = 503;
				ctx.body = {error: {code: 503, message: 'Server not ready (no processor).'}};
				await next();
				return;
			}

			const documentID = ctx.params['id'];
			const response = await this.processor.get(documentID);
			if (response) {
				ctx.body = bnReplacer(clean(response));
			}

			await next();
		});

		router.post('/query', async (ctx, next) => {
			if (!this.processor) {
				ctx.status = 503;
				ctx.body = {error: {code: 503, message: 'Server not ready (no processor).'}};
				await next();
				return;
			}
			const response = await this.processor.query(ctx.request.body as Query);
			// TODO clean response ? or force fields to be specified and prevent some (like underscore)
			ctx.body = bnReplacer(response);
			await next();
		});

		// ----------------------------------------------------------------------------------------------------------------
		// ADMIN ROUTES
		// ----------------------------------------------------------------------------------------------------------------

		router.get('/admin', async (ctx, next) => {
			ctx.body = getAdminPage();
			await next();
		});

		router.post('/replay', async (ctx, next) => {
			if (!isAuthorized(ctx)) {
				ctx.body = {error: {code: 4030, message: 'Forbidden'}};
			} else if (!this.cache) {
				ctx.body = {error: {code: 223, message: 'Cache is disabled'}};
			} else {
				await this.serializeIndexing(() => this.cache!.replay());
				ctx.body = {lastSync: this.lastSync};
			}
			await next();
		});

		router.post('/start', async (ctx, next) => {
			if (!isAuthorized(ctx)) {
				ctx.body = {error: {code: 4030, message: 'Forbidden'}};
			} else {
				ctx.body = {started: this.startIndexing()};
			}

			await next();
		});

		router.post('/stop', async (ctx, next) => {
			if (!isAuthorized(ctx)) {
				ctx.body = {error: {code: 4030, message: 'Forbidden'}};
			} else {
				ctx.body = {started: this.stopIndexing()};
			}

			await next();
		});

		router.post('/indexMore', async (ctx, next) => {
			if (!this.indexer) {
				ctx.status = 503;
				ctx.body = {error: {code: 503, message: 'Server not ready (no indexer).'}};
				await next();
				return;
			}
			if (!isAuthorized(ctx)) {
				ctx.body = {error: {code: 4030, message: 'Forbidden'}};
			} else {
				if (this.indexing) {
					ctx.body = {error: {code: 4040, message: 'Indexing Already'}};
				} else {
					// Serialize against any other in-flight indexing op (auto loop / another /indexMore /
					// /feed / /replay) so two do not run concurrently on the same indexer.
					this.lastSync = await this.serializeIndexing(() => this.indexer!.indexMore());
					ctx.body = {lastSync: this.lastSync};
				}
			}

			await next();
		});

		router.post('/feed', async (ctx, next) => {
			if (!this.indexer) {
				ctx.status = 503;
				ctx.body = {error: {code: 503, message: 'Server not ready (no indexer).'}};
				await next();
				return;
			}
			if (!isAuthorized(ctx)) {
				ctx.body = {error: {code: 4030, message: 'Forbidden'}};
			} else if (this.indexing) {
				ctx.body = {error: {code: 222, message: 'Server is Indexing, cannot import.'}};
			} else {
				// NOTE: events come from the request body (populated by koa-bodyparser as
				// `ctx.request.body`), not `ctx.body` (which is the response body).
				const eventStream = (ctx.request.body as {events?: unknown})?.events;
				if (!Array.isArray(eventStream)) {
					ctx.body = {error: {code: 4000, message: 'Bad Request: expected an `events` array.'}};
				} else if (eventStream.length === 0) {
					ctx.body = {success: true};
				} else {
					await this.serializeIndexing(() => this.indexer!.feed(eventStream as any));
					ctx.body = {success: true};
				}
			}
			await next();
		});

		router.post('/events', async (ctx, next) => {
			if (!this.cache) {
				ctx.status = 503;
				ctx.body = {error: {code: 503, message: 'Cache is disabled.'}};
				await next();
				return;
			}
			if (!isAuthorized(ctx)) {
				ctx.body = {error: {code: 4030, message: 'Forbidden'}};
			} else {
				const response = await this.cache.query(ctx.request.body as Query);
				ctx.body = response;
			}
			await next();
		});

		// ----------------------------------------------------------------------------------------------------------------

		// Middlewares
		this.app.use(json());
		if (process.env.NAMED_LOGS && process.env.NAMED_LOGS_LEVEL && parseInt(process.env.NAMED_LOGS_LEVEL) >= 3) {
			this.app.use(logger());
		}

		this.app.use(bodyParser());

		this.app.use(router.routes()).use(router.allowedMethods());

		const port = this.config.port;
		return this.app.listen(port, () => {
			console.log(`server started on port: ${port}`);
		});
	}

	// Serializes an indexing operation against any other in-flight indexing entrypoint (the auto
	// loop, manual /indexMore, /feed, /replay) so two never run concurrently on the same indexer.
	// Returns the operation's result. If another op is already in flight, this one waits for it.
	protected async serializeIndexing<T>(fn: () => Promise<T>): Promise<T> {
		while (this.inFlightIndexing) {
			try {
				await this.inFlightIndexing;
			} catch {
				// ignore the previous op's failure; we still get our turn
			}
		}
		const run = (async () => fn())();
		this.inFlightIndexing = run;
		try {
			return await run;
		} finally {
			if (this.inFlightIndexing === run) {
				this.inFlightIndexing = undefined;
			}
		}
	}

	// Compute the exponential backoff delay (ms) for the Nth consecutive error, capped.
	protected backoffDelay(consecutiveErrors: number): number {
		const base = 1000;
		const max = 60000;
		return Math.min(max, base * Math.pow(2, Math.max(0, consecutiveErrors - 1)));
	}

	async index() {
		if (!this.indexer) {
			throw new Error(`no indexer`);
		}
		this.indexing = true;
		try {
			namedLogger.info('server indexing more...');
			this.lastSync = await this.serializeIndexing(() => this.indexer!.indexMore());
			// success: clear the error state and reset backoff
			this.lastError = undefined;
			this.consecutiveErrors = 0;
		} catch (err) {
			this.consecutiveErrors++;
			const message = err instanceof Error ? err.message : String(err);
			this.lastError = {message, at: Date.now()};
			const delay = this.backoffDelay(this.consecutiveErrors);
			namedLogger.error(`server indexing error (attempt ${this.consecutiveErrors}), retry in ${delay}ms: `, err);
			this.indexingTimeout = setTimeout(this.index.bind(this), delay);
			return;
		}

		if (this.lastSync.latestBlock - this.lastSync.lastToBlock < 1) {
			namedLogger.info('no new block, skip');
			this.indexingTimeout = setTimeout(this.index.bind(this), 1000);
		} else {
			this.indexingTimeout = setTimeout(this.index.bind(this), 1);
		}
	}
}
