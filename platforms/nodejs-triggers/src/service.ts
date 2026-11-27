import {createClient} from '@libsql/client';
import {canonicalFeed, createTriggerService, rpcGate, type TickReport, type TriggerService} from '@etherfold/triggers';
import {Hono} from 'hono';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {DEFAULT_DATABASE, validateConfig, type AppConfig, type NodeConfig} from './config.js';

// ---------------------------------------------------------------------------
// THE PROCESS a config describes (etherfold ADR-0101): one core trigger service
// per app, over the database the app names (apps naming one URL share one
// connection), the apps' registration APIs mounted on one Hono app under
// `/{app}/`, and one loop per app run concurrently, so one app's slow or failing
// round never delays another's. The core knows nothing of several apps: this is
// composition only.
// ---------------------------------------------------------------------------

/** The database at a libSQL URL. */
export function openDatabase(url: string): {db: RemoteSQL; close(): void} {
	const client = createClient({url});
	return {db: new RemoteLibSQL(client), close: () => client.close()};
}

/** One app of the process: its core service, and the database it reads and writes. */
export type NodeApp = {name: string; service: TriggerService; db: RemoteSQL; database: string};

/** One app's round, as `tick` reports it: the core's report, or why the round failed. */
export type AppTickReport = {app: string} & (TickReport | {error: string; code?: string});

export type NodeService = {
	/** Every app, by name, in the config's order. */
	apps: Record<string, NodeApp>;
	/**
	 * One HTTP app serving every app with a verifier at `/{app}/...` (the path its
	 * verifier checks, prefix included); `undefined` when no app has one.
	 */
	api: Hono | undefined;
	/** One round of every app, concurrently, each reported under its name (a failed round too). */
	tick(): Promise<AppTickReport[]>;
	/** Every app's own loop, concurrently, until the signal aborts. */
	run(options: {
		signal?: AbortSignal;
		intervalMs?: number;
		onError?: (app: string, error: unknown) => void;
	}): Promise<void>;
	close(): void;
};

/** The core service for one app of the config, over the database it was given. */
function appService(name: string, app: AppConfig, db: RemoteSQL): TriggerService {
	return createTriggerService({
		db,
		app: name,
		chainId: app.chainId,
		feed: canonicalFeed({
			url: app.etherfold.url,
			indexer: app.etherfold.indexer,
			...(app.etherfold.fetch ? {fetch: app.etherfold.fetch} : {}),
		}),
		gate:
			typeof app.gate === 'function'
				? app.gate
				: rpcGate({url: app.gate.rpcUrl, ...(app.gate.depth === undefined ? {} : {depth: app.gate.depth})}),
		definitions: app.triggers,
		actions: app.actions,
		...(app.verifier ? {verifier: app.verifier} : {}),
		...(app.lane ? {lane: app.lane} : {}),
		...(app.maxSubscriptionsPerRecipient === undefined
			? {}
			: {maxSubscriptionsPerRecipient: app.maxSubscriptionsPerRecipient}),
		...(app.callTimeoutMs === undefined ? {} : {callTimeoutMs: app.callTimeoutMs}),
		...(app.maxPagesPerRound === undefined ? {} : {maxPagesPerRound: app.maxPagesPerRound}),
		...(app.maxDeliveriesPerRound === undefined ? {} : {maxDeliveriesPerRound: app.maxDeliveriesPerRound}),
	});
}

/** The process a config describes, its databases opened and set up. */
export async function createNodeService(config: NodeConfig): Promise<NodeService> {
	validateConfig(config);
	const opened = new Map<string, {db: RemoteSQL; close(): void}>();
	const close = () => {
		for (const database of opened.values()) database.close();
		opened.clear();
	};
	const apps: Record<string, NodeApp> = {};
	try {
		for (const [name, app] of Object.entries(config.apps)) {
			const database = app.database ?? config.database ?? DEFAULT_DATABASE;
			let handle = opened.get(database);
			if (!handle) {
				handle = openDatabase(database);
				opened.set(database, handle);
			}
			apps[name] = {name, service: appService(name, app, handle.db), db: handle.db, database};
		}
		for (const app of Object.values(apps)) await app.service.setup();
	} catch (error) {
		close();
		throw error;
	}

	let api: Hono | undefined;
	for (const app of Object.values(apps)) {
		if (!app.service.api) continue;
		// mounted, never rewritten: the sub-app sees the full path (`/{app}/subscriptions`), which
		// is the path the client signed, so the verifier checks the prefix too; its CORS answers
		// its own app's origin on its own routes only
		api ??= new Hono();
		api.route(`/${app.name}`, app.service.api);
	}

	return {
		apps,
		api,
		async tick() {
			const rounds = await Promise.allSettled(Object.values(apps).map((app) => app.service.tick()));
			return Object.values(apps).map((app, index): AppTickReport => {
				const round = rounds[index]!;
				if (round.status === 'fulfilled') return {app: app.name, ...round.value};
				const error = round.reason as {message?: unknown; code?: unknown} | undefined;
				return {
					app: app.name,
					error: error instanceof Error ? error.message : String(round.reason),
					...(typeof error?.code === 'string' ? {code: error.code} : {}),
				};
			});
		},
		async run({signal, intervalMs = 5000, onError = (app, error) => console.error(`${app}: a round failed`, error)}) {
			await Promise.all(
				Object.values(apps).map((app) =>
					app.service.run({
						...(signal ? {signal} : {}),
						intervalMs,
						onError: (error) => onError(app.name, error),
					}),
				),
			);
		},
		close,
	};
}
