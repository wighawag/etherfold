import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClient} from '@libsql/client';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
	createNodeService,
	defineConfig,
	delegatedIdentityVerifier,
	listDeliveries,
	readJournal,
	validateConfig,
	type AppConfig,
	type NodeConfig,
	type NodeService,
} from '../src/index.js';
import {
	ALICE,
	BOB,
	appUser,
	eventually,
	hangingFetch,
	post,
	postedAbi,
	recordingAction,
	scriptedFeed,
	signedPost,
} from './utils.js';

// ---------------------------------------------------------------------------
// ONE PROCESS, SEVERAL APPS (etherfold ADR-0101): one config's `apps`, each
// with its own feed, chain, gate, actions and verifier, composed as one core
// service per app over the database it names (one shared one by default), its
// registration API mounted under `/{app}/`, and its own loop. Port-free: the
// API is called through Hono's `request`, the feeds are scripted `fetch`es.
// ---------------------------------------------------------------------------

const SERVER_ORIGIN = 'https://triggers.test';

let dir: string;
let services: NodeService[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'etherfold-triggers-apps-'));
	services = [];
});
afterEach(() => {
	for (const service of services) service.close();
	rmSync(dir, {recursive: true, force: true});
});

async function start(config: NodeConfig): Promise<NodeService> {
	const service = await createNodeService(config);
	services.push(service);
	return service;
}

/** The rows `table` holds in the database at `url`, by app. */
async function rowsByApp(url: string, table: 'deliveries' | 'subscriptions' | 'consumers'): Promise<string[]> {
	const client = createClient({url});
	try {
		const {rows} = await client.execute(`SELECT app FROM ${table} ORDER BY app`);
		return rows.map((row) => String(row['app']));
	} finally {
		client.close();
	}
}

/** An app on its own indexer and chain: a subscription kind, a rule, and one recording action for both. */
function appConfig(options: {
	indexer: string;
	chainId: string;
	domain?: string;
	feed: typeof fetch;
	action: ReturnType<typeof recordingAction>;
	extra?: Partial<AppConfig>;
}): AppConfig {
	return {
		chainId: options.chainId,
		etherfold: {url: 'http://etherfold.test', indexer: options.indexer, fetch: options.feed},
		gate: async () => 1000,
		triggers: {
			events: {posted: {address: '0x00000000000000000000000000000000000000b0', abi: postedAbi}},
			subscriptions: {
				'new-post': {event: 'posted', notFrom: 'author', action: 'notify', render: (log) => ({text: log.args['text']})},
			},
			rules: {
				'third-post': {
					event: 'posted',
					recipients: (log) => log.args['author'] as string,
					predicate: (log) => (log.args['count'] as bigint) >= 3n,
					action: 'notify',
					key: (_log, recipient) => `third-post:${recipient}`,
					render: () => ({achievement: 'third-post'}),
				},
			},
		},
		actions: {notify: options.action},
		...(options.domain
			? {verifier: delegatedIdentityVerifier({serverOrigin: SERVER_ORIGIN, domain: options.domain})}
			: {}),
		...options.extra,
	};
}

async function subscribe(service: NodeService, path: string, user: Awaited<ReturnType<typeof appUser>>) {
	const response = await service.api!.request(
		`${SERVER_ORIGIN}${path}`,
		await signedPost(user, {serverOrigin: SERVER_ORIGIN, path, fields: {kind: 'new-post'}}),
	);
	return {status: response.status, body: (await response.json()) as Record<string, unknown>};
}

/** `run` until `condition` holds, then stop it and wait for it to stop: no loop outlives a test. */
async function runUntil(service: NodeService, condition: () => boolean | Promise<boolean>) {
	const controller = new AbortController();
	const errors: {app: string; error: unknown}[] = [];
	const running = service.run({
		signal: controller.signal,
		intervalMs: 10,
		onError: (app, error) => errors.push({app, error}),
	});
	try {
		await eventually(condition);
	} finally {
		controller.abort();
		await running;
	}
	return errors;
}

describe('two apps over one shared database', () => {
	it("run follows each app's own feed, and each app's deliveries reach its own adapters only", async () => {
		const shared = `file:${join(dir, 'triggers.db')}`;
		const notifyA = recordingAction();
		const notifyB = recordingAction();
		const feedA = scriptedFeed('board', [[post(101, BOB, 3n, 'on board')]]);
		const feedB = scriptedFeed('forum', [[post(7, BOB, 1n, 'on forum')]]);
		const node = await start(
			defineConfig({
				database: shared,
				apps: {
					a: appConfig({indexer: 'board', chainId: '1', domain: 'a.test', feed: feedA.fetch, action: notifyA}),
					b: appConfig({indexer: 'forum', chainId: '10', domain: 'b.test', feed: feedB.fetch, action: notifyB}),
				},
			}),
		);
		const alice = await appUser('a.test');
		const bob = await appUser('b.test');
		expect((await subscribe(node, '/a/subscriptions', alice)).status).toBe(200);
		expect((await subscribe(node, '/b/subscriptions', bob)).status).toBe(200);

		await runUntil(node, () => notifyA.delivered.length === 2 && notifyB.delivered.length === 1);

		// a: alice's subscription and bob's third post; b: bob's subscription only (his count is 1 there)
		expect(notifyA.delivered.map((d) => d.app)).toEqual(['a', 'a']);
		expect(notifyA.delivered.map((d) => d.recipient).sort()).toEqual([alice.address, BOB.toLowerCase()].sort());
		expect(notifyB.delivered.map((d) => [d.app, d.recipient, d.payload])).toEqual([
			['b', bob.address, {text: 'on forum'}],
		]);
		expect(feedA.seen.reads).toBeGreaterThan(0);
		expect(feedB.seen.reads).toBeGreaterThan(0);
		expect(await rowsByApp(shared, 'consumers')).toEqual(['a', 'b']);
		expect((await listDeliveries(node.apps['a']!.db, 'a')).every((d) => d.app === 'a')).toBe(true);
	});

	it('an app naming its own database keeps its rows there and none in the shared one', async () => {
		const shared = `file:${join(dir, 'triggers.db')}`;
		const own = `file:${join(dir, 'b.db')}`;
		const notifyA = recordingAction();
		const notifyB = recordingAction();
		const node = await start({
			database: shared,
			apps: {
				a: appConfig({
					indexer: 'board',
					chainId: '1',
					domain: 'a.test',
					feed: scriptedFeed('board', [[post(101, BOB, 3n)]]).fetch,
					action: notifyA,
				}),
				b: appConfig({
					indexer: 'forum',
					chainId: '10',
					domain: 'b.test',
					feed: scriptedFeed('forum', [[post(7, BOB, 3n)]]).fetch,
					action: notifyB,
					extra: {database: own},
				}),
			},
		});
		expect((await subscribe(node, '/b/subscriptions', await appUser('b.test'))).status).toBe(200);
		for (const report of await node.tick()) expect(report).not.toHaveProperty('error');

		expect(await rowsByApp(own, 'consumers')).toEqual(['b']);
		expect(await rowsByApp(own, 'subscriptions')).toEqual(['b']);
		expect(await rowsByApp(own, 'deliveries')).toEqual(['b', 'b']);
		expect(await rowsByApp(shared, 'consumers')).toEqual(['a']);
		expect(await rowsByApp(shared, 'subscriptions')).toEqual([]);
		expect(await rowsByApp(shared, 'deliveries')).toEqual(['a']);
	});

	it('apps naming the same database share one connection', async () => {
		const shared = `file:${join(dir, 'triggers.db')}`;
		const feed = scriptedFeed('board', []).fetch;
		const node = await start({
			database: shared,
			apps: {
				a: appConfig({indexer: 'board', chainId: '1', feed, action: recordingAction()}),
				b: appConfig({indexer: 'board', chainId: '1', feed, action: recordingAction(), extra: {database: shared}}),
				c: appConfig({
					indexer: 'board',
					chainId: '1',
					feed,
					action: recordingAction(),
					extra: {database: `file:${join(dir, 'c.db')}`},
				}),
			},
		});
		expect(node.apps['a']!.db).toBe(node.apps['b']!.db);
		expect(node.apps['c']!.db).not.toBe(node.apps['a']!.db);
		// an app without a verifier serves no routes
		expect(node.api).toBeUndefined();
	});
});

describe('one app', () => {
	function single(): NodeConfig {
		return {
			database: `file:${join(dir, 'triggers.db')}`,
			apps: {
				game: appConfig({
					indexer: 'board',
					chainId: '1',
					domain: 'game.test',
					feed: scriptedFeed('board', []).fetch,
					action: recordingAction(),
				}),
			},
		};
	}

	it('is an `apps` of one, served under `/{name}/`, with its registration and CORS there', async () => {
		const node = await start(single());
		const user = await appUser('game.test');
		const answer = await subscribe(node, '/game/subscriptions', user);
		expect(answer).toMatchObject({status: 200, body: {success: true, subscription: {recipient: user.address}}});

		const listed = await node.api!.request(
			`${SERVER_ORIGIN}/game/subscriptions/list`,
			await signedPost(user, {serverOrigin: SERVER_ORIGIN, path: '/game/subscriptions/list'}),
		);
		expect(((await listed.json()) as {subscriptions: unknown[]}).subscriptions).toHaveLength(1);

		const preflight = await node.api!.request(`${SERVER_ORIGIN}/game/subscriptions`, {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://game.test',
				'Access-Control-Request-Method': 'POST',
				'Access-Control-Request-Headers': 'content-type,signature',
			},
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://game.test');

		// nothing is served at the unprefixed path
		expect(
			(
				await node.api!.request(
					`${SERVER_ORIGIN}/subscriptions`,
					await signedPost(user, {serverOrigin: SERVER_ORIGIN, path: '/subscriptions', fields: {kind: 'new-post'}}),
				)
			).status,
		).toBe(404);
	});

	it('is refused in the old flat shape, with a message showing the `apps` shape', async () => {
		const {apps, ...rest} = single();
		const flat = {...rest, ...apps['game']!, name: 'game'};
		await expect(createNodeService(flat as unknown as NodeConfig)).rejects.toThrow(
			/no `apps`[\s\S]*apps: \{[\s\S]*chainId/,
		);
	});
});

describe('the path a client signed, prefix included', () => {
	let node: NodeService;
	beforeEach(async () => {
		node = await start({
			database: `file:${join(dir, 'triggers.db')}`,
			apps: {
				a: appConfig({
					indexer: 'board',
					chainId: '1',
					domain: 'a.test',
					feed: scriptedFeed('board', []).fetch,
					action: recordingAction(),
				}),
				b: appConfig({
					indexer: 'forum',
					chainId: '1',
					domain: 'b.test',
					feed: scriptedFeed('forum', []).fetch,
					action: recordingAction(),
				}),
			},
		});
	});

	const send = async (path: string, init: RequestInit) =>
		(await node.api!.request(`${SERVER_ORIGIN}${path}`, init)).status;

	it("refuses a proof for app a's domain on b's routes", async () => {
		const user = await appUser('a.test');
		const init = await signedPost(user, {
			serverOrigin: SERVER_ORIGIN,
			path: '/b/subscriptions',
			fields: {kind: 'new-post'},
		});
		expect(await send('/b/subscriptions', init)).toBe(401);
	});

	it('accepts a request signed for `/a/subscriptions` there, once, and refuses one signed for the unprefixed path', async () => {
		const user = await appUser('a.test');
		const init = await signedPost(user, {
			serverOrigin: SERVER_ORIGIN,
			path: '/a/subscriptions',
			fields: {kind: 'new-post'},
		});
		expect(await send('/a/subscriptions', init)).toBe(200);
		expect(await send('/a/subscriptions', init)).toBe(401);

		const unprefixed = await signedPost(user, {
			serverOrigin: SERVER_ORIGIN,
			path: '/a/subscriptions',
			signedPath: '/subscriptions',
			fields: {kind: 'new-post'},
		});
		expect(await send('/a/subscriptions', unprefixed)).toBe(401);
	});

	it("answers CORS for app a's origin on `/a/...` only", async () => {
		const preflight = async (path: string, origin: string) =>
			(
				await node.api!.request(`${SERVER_ORIGIN}${path}`, {
					method: 'OPTIONS',
					headers: {
						Origin: origin,
						'Access-Control-Request-Method': 'POST',
						'Access-Control-Request-Headers': 'content-type,signature',
					},
				})
			).headers.get('Access-Control-Allow-Origin');
		expect(await preflight('/a/subscriptions', 'https://a.test')).toBe('https://a.test');
		expect(await preflight('/a/subscriptions', 'https://b.test')).toBeNull();
		expect(await preflight('/b/subscriptions', 'https://a.test')).toBeNull();
		expect(await preflight('/b/subscriptions/renew', 'https://b.test')).toBe('https://b.test');
	});
});

describe('one broken app holds only itself', () => {
	async function brokenBeside(broken: Partial<AppConfig>, brokenFeed: typeof fetch) {
		const notifyA = recordingAction();
		const notifyB = recordingAction();
		const node = await start({
			database: `file:${join(dir, 'triggers.db')}`,
			apps: {
				a: appConfig({
					indexer: 'board',
					chainId: '1',
					feed: brokenFeed,
					action: notifyA,
					extra: {callTimeoutMs: 30, ...broken},
				}),
				b: appConfig({
					indexer: 'forum',
					chainId: '1',
					feed: scriptedFeed('forum', [[post(7, BOB, 3n)], [post(8, ALICE, 3n)]]).fetch,
					action: notifyB,
				}),
			},
		});
		return {node, notifyA, notifyB};
	}

	it('a predicate that always throws stalls its app, journalled under its name, while the other delivers', async () => {
		const throwing: Partial<AppConfig> = {
			triggers: {
				events: {posted: {address: '0x00000000000000000000000000000000000000b0', abi: postedAbi}},
				rules: {
					broken: {
						event: 'posted',
						recipients: (log) => log.args['author'] as string,
						predicate: () => {
							throw new Error('a broken predicate');
						},
						action: 'notify',
						key: (_log, recipient) => `broken:${recipient}`,
						render: () => ({}),
					},
				},
			},
		};
		const {node, notifyA, notifyB} = await brokenBeside(throwing, scriptedFeed('board', [[post(101, BOB, 3n)]]).fetch);
		const errors = await runUntil(
			node,
			async () =>
				notifyB.delivered.length === 2 && (await readJournal(node.apps['a']!.db, 'a', {kind: 'stalled'})).length > 0,
		);
		expect(notifyA.delivered).toEqual([]);
		expect(await readJournal(node.apps['a']!.db, 'a', {kind: 'stalled'})).toEqual([
			expect.objectContaining({app: 'a', detail: expect.objectContaining({error: 'a broken predicate'})}),
		]);
		expect(await readJournal(node.apps['b']!.db, 'b', {kind: 'stalled'})).toEqual([]);
		expect(errors.every((e) => e.app === 'a')).toBe(true);
	});

	it('a feed that never answers stalls its app on the timeout, while the other delivers', async () => {
		const {node, notifyA, notifyB} = await brokenBeside({}, hangingFetch);
		await runUntil(
			node,
			async () =>
				notifyB.delivered.length === 2 && (await readJournal(node.apps['a']!.db, 'a', {kind: 'stalled'})).length > 0,
		);
		expect(notifyA.delivered).toEqual([]);
		expect(await readJournal(node.apps['a']!.db, 'a', {kind: 'stalled'})).toEqual([
			expect.objectContaining({app: 'a', detail: expect.objectContaining({code: 'feed-timeout'})}),
		]);
		expect(await readJournal(node.apps['b']!.db, 'b', {kind: 'stalled'})).toEqual([]);
	});
});

describe("an app's round is bounded", () => {
	it('in feed pages and in deliveries, the rest left for its next round', async () => {
		const notify = recordingAction();
		const feed = scriptedFeed('board', [
			[post(101, BOB, 3n)],
			[post(102, ALICE, 3n)],
			[post(103, '0x00000000000000000000000000000000000000c1', 3n)],
		]);
		const node = await start({
			database: `file:${join(dir, 'triggers.db')}`,
			apps: {
				a: appConfig({
					indexer: 'board',
					chainId: '1',
					feed: feed.fetch,
					action: notify,
					extra: {maxPagesPerRound: 2, maxDeliveriesPerRound: 1},
				}),
			},
		});
		const [first] = await node.tick();
		expect(first).toMatchObject({app: 'a', consumed: 2, hasMore: true, delivery: {attempted: 1}});
		expect(feed.seen.reads).toBe(2);
		const [second] = await node.tick();
		expect(second).toMatchObject({app: 'a', consumed: 1, hasMore: false, delivery: {attempted: 1}});
		expect((await node.tick())[0]).toMatchObject({delivery: {attempted: 1}});
		expect(notify.delivered).toHaveLength(3);
		expect(await readJournal(node.apps['a']!.db, 'a', {kind: 'stalled'})).toEqual([]);
	});
});

describe('an app name', () => {
	it('is a URL-safe slug, or the config is refused', () => {
		const app = appConfig({indexer: 'board', chainId: '1', feed: hangingFetch, action: recordingAction()});
		for (const name of ['Game', 'my game', 'a/b', '', '-a', 'a-', 'jeu-é', 'a.b', 'x'.repeat(65)]) {
			expect(() => validateConfig({apps: {[name]: app}}), name).toThrow(/is not a URL-safe slug/);
		}
		for (const name of ['a', 'game-1', 'jolly-roger', '0x']) {
			expect(() => validateConfig({apps: {[name]: app}}), name).not.toThrow();
		}
	});

	it('is the key of `apps`: an app config naming itself, or no app at all, is refused', () => {
		const app = appConfig({indexer: 'board', chainId: '1', feed: hangingFetch, action: recordingAction()});
		expect(() => validateConfig({apps: {a: {...app, name: 'a'}}})).toThrow(/the key of `apps`/);
		expect(() => validateConfig({apps: {}})).toThrow(/declares no app/);
	});
});

describe('a database holding an app the config does not declare for it', () => {
	/** An app over `database`, its feed one page with bob's third post: a round writes its consumer and a delivery. */
	function appOn(indexer: string, database?: string): AppConfig {
		return appConfig({
			indexer,
			chainId: '1',
			feed: scriptedFeed(indexer, [[post(101, BOB, 3n)]]).fetch,
			action: recordingAction(),
			...(database ? {extra: {database}} : {}),
		});
	}

	/** Run one round of `config`'s every app, then close it: the rows it leaves behind. */
	async function seed(config: NodeConfig): Promise<void> {
		const node = await createNodeService(config);
		try {
			for (const report of await node.tick()) expect(report).not.toHaveProperty('error');
		} finally {
			node.close();
		}
	}

	it('is refused at start, naming the app and the database', async () => {
		const shared = `file:${join(dir, 'triggers.db')}`;
		await seed({database: shared, apps: {a: appOn('board')}});
		await expect(createNodeService({database: shared, apps: {b: appOn('forum')}})).rejects.toThrow(
			new RegExp(`${shared}[\\s\\S]*"a"[\\s\\S]*retired`),
		);
		// refused before any app of the config wrote a row
		expect(await rowsByApp(shared, 'consumers')).toEqual(['a']);
	});

	it('names the database without its query string, which may carry a token', async () => {
		const shared = `file:${join(dir, 'triggers.db')}`;
		await seed({database: shared, apps: {a: appOn('board')}});
		const refusal = createNodeService({database: `${shared}?authToken=secret`, apps: {b: appOn('forum')}});
		await expect(refusal).rejects.toThrow(shared);
		await expect(refusal).rejects.not.toThrow(/secret/);
	});

	it('starts once the app is `retired`, and leaves every row of it where it was', async () => {
		const shared = `file:${join(dir, 'triggers.db')}`;
		await seed({database: shared, apps: {a: appOn('board'), b: appOn('forum')}});
		const before = {
			consumers: await rowsByApp(shared, 'consumers'),
			deliveries: await rowsByApp(shared, 'deliveries'),
		};
		expect(before).toEqual({consumers: ['a', 'b'], deliveries: ['a', 'b']});

		// `a` removed from `apps`, and retired: `b` goes on, `a`'s rows stay
		const node = await start({database: shared, retired: ['a'], apps: {b: appOn('forum')}});
		for (const report of await node.tick()) expect(report).toMatchObject({app: 'b'});
		expect(Object.keys(node.apps)).toEqual(['b']);
		expect(await rowsByApp(shared, 'consumers')).toEqual(['a', 'b']);
		expect(await rowsByApp(shared, 'deliveries')).toEqual(['a', 'b']);
		expect(await listDeliveries(node.apps['b']!.db, 'a')).toHaveLength(1);
	});

	it('accepts the shared database still holding a moved app once it is `retired`, the app running on its own', async () => {
		const shared = `file:${join(dir, 'triggers.db')}`;
		const own = `file:${join(dir, 'a.db')}`;
		await seed({database: shared, apps: {a: appOn('board'), b: appOn('forum')}});

		// moved without retiring it: the shared database holds an app the config declares elsewhere
		await expect(
			createNodeService({database: shared, apps: {a: appOn('board', own), b: appOn('forum')}}),
		).rejects.toThrow(new RegExp(`${shared}[\\s\\S]*"a"`));

		const node = await start({database: shared, retired: ['a'], apps: {a: appOn('board', own), b: appOn('forum')}});
		expect(node.apps['a']!.database).toBe(own);
		for (const report of await node.tick()) expect(report).not.toHaveProperty('error');
		expect(await rowsByApp(own, 'consumers')).toEqual(['a']);
		expect(await rowsByApp(own, 'deliveries')).toEqual(['a']);
		// the old rows stay in the shared database, untouched
		expect(await rowsByApp(shared, 'consumers')).toEqual(['a', 'b']);
		expect(await rowsByApp(shared, 'deliveries')).toEqual(['a', 'b']);
	});

	it('lets an app both in `apps` and `retired` start normally on its declared database', async () => {
		const shared = `file:${join(dir, 'triggers.db')}`;
		await seed({database: shared, apps: {a: appOn('board')}});
		const node = await start({database: shared, retired: ['a'], apps: {a: appOn('board')}});
		expect((await node.tick())[0]).toMatchObject({app: 'a'});
		expect((await node.tick())[0]).not.toHaveProperty('error');
	});

	it('starts over an empty database, and over one holding only the apps it declares', async () => {
		const shared = `file:${join(dir, 'triggers.db')}`;
		await seed({database: shared, apps: {a: appOn('board')}});
		await start({database: shared, apps: {a: appOn('board'), b: appOn('forum')}});
	});

	it('`retired` is a list of app names, or the config is refused', () => {
		const apps = {a: appOn('board')};
		expect(() => validateConfig({apps, retired: 'a'})).toThrow(/`retired`/);
		expect(() => validateConfig({apps, retired: [1]})).toThrow(/`retired`/);
		expect(() => validateConfig({apps, retired: ['old-app']})).not.toThrow();
	});
});
