import 'fake-indexeddb/auto';
import {createClient} from '@libsql/client';
import {
	createBrowserStateStore,
	createIndexerState,
	keepStreamOnIndexedDB,
	type InstantiatedProcessorBundle,
	type PublicationSnapshot,
} from '@etherfold/browser';
import {resolveStreamConfig, streamDigestOf, type LastSync} from '@etherfold/core';
import {
	EntityEventProcessor,
	openAndBootstrap,
	openForWriting,
	type BootstrapOutcome,
	type EntityProcessor,
	type EntityStateView,
	RevertBeyondSnapshotError,
	type SnapshotAwareStateStore,
} from '@etherfold/processor-entities';
import {PUBLICATION_INDEX_NAME, type PublicationIndex} from '@etherfold/server';
import {loadProcessorArtifact} from '@etherfold/utils';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {build, canonicalGenerationIn, type IndexingDependencies} from '../src/index.js';
import type {Options} from '../src/types.js';
import {canonicalStoreIn} from './utils/reads.js';
import {
	abi,
	ALICE,
	BOB,
	CAROL,
	CONTRACT,
	fakeChain,
	SOURCE,
	START_BLOCK,
	transfer,
	ZERO,
	type RawLog,
} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// AN APP BUILT AND PUBLISHED WITH THE CLI STARTS FROM ITS OWN PUBLICATION (ADR-0095)
// ---------------------------------------------------------------------------------------------------
// The whole path, end to end, with nothing between the two halves but a directory
// a static host serves:
//
//  - the PUBLISHER is `etherfold build --publish <dir>`, a real committed processor
//    bundle folding a fixture chain whose contracts come from a `--deployments`
//    folder, exactly as a scheduled job runs it;
//  - the APP is a browser tab (`@etherfold/browser` over fake IndexedDB) that runs
//    THE SAME BUNDLE FILE, fetched from the host and hashed (`processorBundle`), and
//    starts from the publication index (`publication`) through the existing
//    bootstrap in its own `createState`, as the browser guide wires it.
//
// The only things the two share are the ones an app and its publisher really
// share: the bundle's bytes, the contracts (as the deployments folder on one side
// and the source object on the other) and the finality. The digest of those is the
// index key, and it is ASSERTED equal, because a mismatch is the difference
// between starting from the snapshot and a refusal.
//
// Every case asserts on the REQUESTS the host and the chain were asked for,
// because the claim a published snapshot exists for is about what a tab does NOT
// download: nothing whose size follows the stream, unless it asked for the seed.
// ---------------------------------------------------------------------------------------------------

type ABI = typeof abi;

const FIXTURES = fileURLToPath(new URL('./fixtures/processor-bundle/', import.meta.url));
const BUNDLE = join(FIXTURES, 'nfts.bundle.js');
/** The same file with one handler line changed: a PROCESSOR-ONLY change, on the same stream. */
const EDITED_BUNDLE = join(FIXTURES, 'nfts-edited.bundle.js');

const FINALITY = 12;
const TIP = START_BLOCK + 100;
const CUT = TIP - FINALITY;
const SAVED_AT = '2026-09-27T00:00:00.000Z';

/** What the publisher's job sets, and the one stream setting the app states too. */
const ENV = {MAX_BLOCKS_PER_FETCH: '20', STREAM_FINALITY: String(FINALITY)};
const TAB_CONFIG = {stream: {finality: FINALITY}};

/** Where the app is served from: its bundle beside the published directory. */
const APP = 'https://app.example';
const INDEX = `${APP}/published/${PUBLICATION_INDEX_NAME}`;
const BUNDLE_URL = `${APP}/processor.bundle.js`;
const EDITED_BUNDLE_URL = `${APP}/processor-edited.bundle.js`;

/** The chain: transfers before the cut, one just below it, and two inside the reorg window. */
const LOGS: RawLog[] = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
	transfer(START_BLOCK + 40, '0xa40', ZERO, CAROL, 2n),
	transfer(START_BLOCK + 60, '0xa60', CAROL, ALICE, 2n),
	transfer(CUT - 3, '0xabelow', BOB, CAROL, 1n),
	transfer(CUT + 2, '0xaabove', CAROL, BOB, 1n),
	transfer(TIP - 1, '0xatip', ZERO, BOB, 3n),
];

// ---------------------------------------------------------------------------------------------------
// the PUBLISHER's side
// ---------------------------------------------------------------------------------------------------

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

function aWorkspace(): string {
	const root = mkdtempSync(join(tmpdir(), 'etherfold-published-app-'));
	directories.push(root);
	return root;
}

/**
 * THE CONTRACTS, as the publisher's job has them: a hardhat-deploy / rocketh
 * deployments folder, written from the very source object the app is given, so
 * "the two hash the same" is a claim about two REPRESENTATIONS of one deployment.
 */
function aDeploymentsFolder(root: string): string {
	const folder = join(root, 'deployments');
	mkdirSync(folder, {recursive: true});
	writeFileSync(join(folder, '.chainId'), SOURCE.chainId);
	writeFileSync(
		join(folder, 'NFTs.json'),
		JSON.stringify({address: CONTRACT, abi, receipt: {blockNumber: START_BLOCK}}, null, '\t'),
	);
	return folder;
}

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

function dependencies(db: RemoteSQL, chain: ReturnType<typeof fakeChain>): IndexingDependencies {
	return {
		provider: chain.provider,
		createDB: () => db,
		sleep: async () => {},
		env: ENV,
		publication: {savedAt: SAVED_AT},
	};
}

/** `etherfold build -p <bundle> --deployments <folder> --publish <out> ...`, over one database. */
async function buildAndPublish(
	db: RemoteSQL,
	chain: ReturnType<typeof fakeChain>,
	options: {bundle: string; deployments: string; out: string} & Options,
): Promise<void> {
	const {bundle, out, ...extra} = options;
	const summary = await build(
		{processor: bundle, nodeUrl: 'http://localhost:0', store: 'sqlite', db: ':memory:', publish: out, ...extra},
		dependencies(db, chain),
	);
	expect(summary.stoppedBecause).toBe('stopped');
}

function theIndexIn(out: string): PublicationIndex {
	return JSON.parse(readFileSync(join(out, PUBLICATION_INDEX_NAME), 'utf-8')) as PublicationIndex;
}

async function identityOf(bundle: string): Promise<string> {
	return (await loadProcessorArtifact(new Uint8Array(readFileSync(bundle)))).identity;
}

// ---------------------------------------------------------------------------------------------------
// the STATIC HOST between them
// ---------------------------------------------------------------------------------------------------

/**
 * A static host serving the app's bundles and the published directory, read from
 * disk at request time (so a republication is seen by the next request), and
 * recording every URL asked for with the size of what it answered.
 */
function aStaticHost(out: string) {
	const asked: {url: string; bytes: number}[] = [];
	const files: Record<string, () => Uint8Array | undefined> = {
		[BUNDLE_URL]: () => readFileSync(BUNDLE),
		[EDITED_BUNDLE_URL]: () => readFileSync(EDITED_BUNDLE),
	};
	const fetch = (async (input: unknown) => {
		const url = String(input);
		let bytes: Uint8Array | undefined;
		if (files[url]) bytes = files[url]();
		else if (url.startsWith(`${APP}/published/`)) {
			try {
				bytes = readFileSync(join(out, url.slice(`${APP}/published/`.length)));
			} catch {
				bytes = undefined;
			}
		}
		asked.push({url, bytes: bytes?.length ?? 0});
		if (!bytes) return new Response('not found', {status: 404, statusText: 'Not Found'});
		return new Response(new Uint8Array(bytes), {status: 200});
	}) as typeof globalThis.fetch;
	return {asked, fetch, urls: () => asked.map((request) => request.url)};
}

// ---------------------------------------------------------------------------------------------------
// the APP's side: a tab, wired as the browser guide wires it
// ---------------------------------------------------------------------------------------------------

let counter = 0;
const freshName = () => `published-app-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * THE TAB AN APP WRITES: the published bundle as its processor, the publication
 * index as where it starts from, and a `createState` that starts from what it is
 * handed through the existing bootstrap. `publication` absent is the SELF-INDEXING
 * tab every case compares against: the same bundle, indexing from the start block.
 */
function aTab(options: {
	host: ReturnType<typeof aStaticHost>;
	bundle?: string;
	publication?: boolean | {seed: true};
	keepStream?: string;
}) {
	const databaseName = freshName();
	const handed: (PublicationSnapshot | undefined)[] = [];
	const outcomes: BootstrapOutcome[] = [];
	let store: SnapshotAwareStateStore | undefined;
	const processorBundle = {url: options.bundle ?? BUNDLE_URL, fetch: options.host.fetch};
	const definitionOf = (bundle?: InstantiatedProcessorBundle) => {
		if (!bundle) throw new Error('this tab runs a published bundle, and was handed none');
		return bundle.processor as EntityProcessor<ABI>;
	};
	const indexer = createIndexerState<ABI, EntityStateView>(
		{
			createState: async (_context, {signal}, bundle, published) => {
				handed.push(published);
				const backend = await createBrowserStateStore(definitionOf(bundle).entities, {databaseName});
				const opened = await openAndBootstrap(backend, published?.locations ?? [], {
					processor: published?.processor ?? 'no-snapshot-was-handed',
					finalityDepth: FINALITY,
					fetch: options.host.fetch,
				});
				outcomes.push(opened.outcome);
				store = opened.store;
				return openForWriting(opened.store, {signal});
			},
			createProcessor: (state, _context, bundle) => new EntityEventProcessor<ABI>(state, definitionOf(bundle)),
			processorBundle,
		},
		{
			...(options.publication
				? {
						publication: {
							locations: [INDEX],
							fetch: options.host.fetch,
							...(typeof options.publication === 'object' ? {seed: true as const} : {}),
						},
					}
				: {}),
			...(options.keepStream ? {keepStream: keepStreamOnIndexedDB<ABI>(options.keepStream)} : {}),
		},
	);
	return {
		indexer,
		handed,
		outcomes,
		store: () => {
			if (!store) throw new Error('the tab built no store');
			return store;
		},
	};
}

type Tab = ReturnType<typeof aTab>;

/** Drive a tab to the chain's tip one advance at a time, failing loudly on a demotion rather than hanging. */
async function indexToTip(tab: Tab, maxRounds = 40): Promise<LastSync<ABI>> {
	const advance = async () => {
		const lastSync = await tab.indexer.indexMore();
		if (!lastSync) throw new Error(`the tab was demoted: ${tab.indexer.syncing.$state.demotion?.reason}`);
		return lastSync as LastSync<ABI>;
	};
	let lastSync = await advance();
	for (let round = 0; lastSync.lastToBlock < lastSync.latestBlock && round < maxRounds; round++) {
		lastSync = await advance();
	}
	return lastSync;
}

const tokenKey = (id: bigint) => id.toString().padStart(78, '0');

/** The state as an app renders it: every token's owner, and how many transfers were counted. */
async function stateOf(view: {getCurrent: EntityStateView['getCurrent']}) {
	const owners: Record<string, string | undefined> = {};
	for (const id of [1n, 2n, 3n]) {
		owners[id.toString()] = (await view.getCurrent<{owner: string}>('nft', {tokenID: tokenKey(id)}))?.owner;
	}
	const transfers = (await view.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value;
	return {owners, transfers: transfers === undefined ? undefined : Number(transfers)};
}

/** Boot a tab on a chain, index it to the tip, read its state. */
async function booted(tab: Tab, chain: ReturnType<typeof fakeChain>) {
	await tab.indexer.init({provider: chain.provider, source: SOURCE, config: TAB_CONFIG});
	await indexToTip(tab);
	return stateOf(tab.indexer.state.$state);
}

// ---------------------------------------------------------------------------------------------------
// the cases
// ---------------------------------------------------------------------------------------------------

describe('an app built and published with the CLI starts from its own publication', () => {
	it('THE PRIMARY CASE (history none, no seed): same state as a self-indexing tab, a reorg absorbed, nothing proportional to the stream', async () => {
		const root = aWorkspace();
		const out = join(root, 'published');
		const deployments = aDeploymentsFolder(root);
		const db = oneDatabase();
		await buildAndPublish(db, fakeChain().serve(LOGS, TIP), {bundle: BUNDLE, deployments, out});

		// the index key IS what the tab computes: the app's source and finality hash as the publisher's
		const canonical = (await canonicalGenerationIn(db))!;
		const index = theIndexIn(out);
		const [entry] = Object.values(index.snapshots);
		expect(streamDigestOf(SOURCE, resolveStreamConfig(TAB_CONFIG.stream))).toBe(canonical.stream);
		expect(entry).toMatchObject({stream: canonical.stream, processor: await identityOf(BUNDLE), cut: CUT});
		expect(index.seeds ?? {}).toEqual({});

		const host = aStaticHost(out);
		const chain = fakeChain().serve(LOGS, TIP);
		const tab = aTab({host, publication: true});
		const selfChain = fakeChain().serve(LOGS, TIP);
		const selfIndexing = aTab({host});
		try {
			const started = await booted(tab, chain);
			const body = `${APP}/published/${entry!.body}`;

			// it started from the snapshot, KEPT it across the first load, and folded forward from the cut
			expect(tab.handed.map((handed) => handed?.entry)).toEqual([entry]);
			expect(tab.outcomes).toEqual([{status: 'bootstrapped', at: expect.any(Number), from: body}]);
			expect(tab.indexer.syncing.$state.publication).toMatchObject({status: 'found', from: INDEX, snapshot: body});
			expect(tab.indexer.canonical?.record).toMatchObject({stream: canonical.stream, processor: entry!.processor});
			expect(Math.min(...chain.logRanges.map((range) => range.from))).toBeGreaterThanOrEqual(CUT);

			// the same state as a tab that indexed the whole chain itself
			const itself = await booted(selfIndexing, selfChain);
			expect(Math.min(...selfChain.logRanges.map((range) => range.from))).toBe(START_BLOCK);
			expect(started).toEqual(itself);
			expect(started).toEqual({
				owners: {'1': BOB, '2': ALICE, '3': BOB},
				transfers: LOGS.length,
			});

			// NOTHING PROPORTIONAL TO THE STREAM: the bundle, the index and the snapshot, and no seed
			expect(host.urls().filter((url) => url.startsWith(`${APP}/published/`))).toEqual([INDEX, body]);

			// A REORG inside the finality window: the two transfers above the cut are replaced
			const reorged: RawLog[] = [
				...LOGS.filter((log) => parseInt(log.blockNumber.slice(2), 16) < CUT),
				transfer(CUT + 2, '0xbabove', CAROL, ALICE, 1n),
				transfer(TIP + 3, '0xbtip', ZERO, CAROL, 3n),
			];
			chain.serve(reorged, TIP + 5);
			selfChain.serve(reorged, TIP + 5);
			await indexToTip(tab);
			await indexToTip(selfIndexing);
			const afterReorg = await stateOf(tab.indexer.state.$state);
			expect(afterReorg).toEqual(await stateOf(selfIndexing.indexer.state.$state));
			expect(afterReorg).toEqual({owners: {'1': ALICE, '2': ALICE, '3': CAROL}, transfers: reorged.length});

			// and a tab indexing the reorged chain from scratch agrees
			const fresh = aTab({host});
			try {
				expect(await booted(fresh, fakeChain().serve(reorged, TIP + 5))).toEqual(afterReorg);
			} finally {
				fresh.indexer.dispose();
			}
		} finally {
			tab.indexer.dispose();
			selfIndexing.indexer.dispose();
		}
	});

	it('downloads a snapshot sized by the STATE: ten times the stream, the same body', async () => {
		const root = aWorkspace();
		const deployments = aDeploymentsFolder(root);
		// the same three tokens and the same final owners, reached through ten times the transfers
		const churn: RawLog[] = [];
		for (let round = 0; round < 30; round++) {
			churn.push(transfer(START_BLOCK + 61 + round, `0xc${round}a`, ALICE, BOB, 2n));
			churn.push(transfer(START_BLOCK + 61 + round, `0xc${round}a`, BOB, ALICE, 2n, 1));
		}
		const blockOf = (log: RawLog) => parseInt(log.blockNumber.slice(2), 16);
		const longer = [...LOGS, ...churn.filter((log) => blockOf(log) < CUT - 3)].sort((a, b) => blockOf(a) - blockOf(b));
		expect(longer.length).toBeGreaterThan(LOGS.length * 5);

		const bodies: number[] = [];
		for (const [name, logs] of [
			['short', LOGS],
			['long', longer],
		] as const) {
			const out = join(root, name);
			await buildAndPublish(oneDatabase(), fakeChain().serve(logs, TIP), {bundle: BUNDLE, deployments, out});
			const host = aStaticHost(out);
			const tab = aTab({host, publication: true});
			try {
				const state = await booted(tab, fakeChain().serve(logs, TIP));
				expect(state.owners).toEqual({'1': BOB, '2': ALICE, '3': BOB});
				expect(state.transfers).toBe(logs.length);
			} finally {
				tab.indexer.dispose();
			}
			const published = host.asked.filter((request) => request.url.startsWith(`${APP}/published/`));
			expect(published.map((request) => request.url)).toEqual([
				INDEX,
				`${APP}/published/${Object.values(theIndexIn(out).snapshots)[0]!.body}`,
			]);
			bodies.push(published[1]!.bytes);
		}
		// the rows are the same three tokens and one counter: the body does not grow with the stream
		expect(Math.abs(bodies[1]! - bodies[0]!)).toBeLessThan(16);
	});

	it('THE SEED CASE (--seed): a processor-only change re-folds the published stream locally', async () => {
		const root = aWorkspace();
		const out = join(root, 'published');
		const deployments = aDeploymentsFolder(root);
		const db = oneDatabase();
		await buildAndPublish(db, fakeChain().serve(LOGS, TIP), {bundle: BUNDLE, deployments, out, seed: true});
		const canonical = (await canonicalGenerationIn(db))!;
		const seed = theIndexIn(out).seeds?.[canonical.stream];
		expect(seed).toMatchObject({stream: canonical.stream, coverage: {toBlock: CUT}});

		// the app ships the EDITED bundle, which nobody has published a snapshot of
		const host = aStaticHost(out);
		const chain = fakeChain().serve(LOGS, TIP);
		const tab = aTab({host, bundle: EDITED_BUNDLE_URL, publication: {seed: true}, keepStream: freshName()});
		const selfChain = fakeChain().serve(LOGS, TIP);
		const selfIndexing = aTab({host, bundle: EDITED_BUNDLE_URL});
		try {
			const started = await booted(tab, chain);
			const seedBody = `${APP}/published/${seed!.body}`;

			// no snapshot for this processor, so the state is re-folded from the SEED rather than the chain
			expect(tab.indexer.syncing.$state.publication).toEqual({status: 'refused', reason: 'no-entry', from: INDEX});
			expect(tab.indexer.syncing.$state.streamSeed).toMatchObject({status: 'seeded', from: seedBody, at: CUT});
			expect(tab.indexer.canonical?.record).toMatchObject({
				stream: canonical.stream,
				processor: await identityOf(EDITED_BUNDLE),
			});
			expect(Math.min(...chain.logRanges.map((range) => range.from))).toBe(CUT);
			expect(host.urls().filter((url) => url.startsWith(`${APP}/published/`))).toEqual([INDEX, seedBody]);

			// and it lands where the EDITED fold of the whole chain lands, which is not the published one
			const itself = await booted(selfIndexing, selfChain);
			expect(Math.min(...selfChain.logRanges.map((range) => range.from))).toBe(START_BLOCK);
			expect(started).toEqual(itself);
			expect(started.owners).not.toEqual({'1': BOB, '2': ALICE, '3': BOB});
		} finally {
			tab.indexer.dispose();
			selfIndexing.indexer.dispose();
		}
	});

	it('THE HISTORY CASE (--history <depth>): a revert inside the published history, refused under its floor', async () => {
		const root = aWorkspace();
		const deployments = aDeploymentsFolder(root);
		const depth = 30;
		// the floor points at the highest recorded block at or below `cut - depth` (ADR-0095)
		const floor = START_BLOCK + 40;
		const inside = START_BLOCK + 50;

		const published: {db: RemoteSQL; tab: Tab}[] = [];
		for (const history of [String(depth), 'none']) {
			const out = join(root, history);
			const db = oneDatabase();
			await buildAndPublish(db, fakeChain().serve(LOGS, TIP), {bundle: BUNDLE, deployments, out, history});
			const tab = aTab({host: aStaticHost(out), publication: true});
			await booted(tab, fakeChain().serve(LOGS, TIP));
			tab.indexer.dispose();
			published.push({db, tab});
		}
		const [withHistory, withNone] = published;
		expect(withHistory!.tab.handed[0]?.entry.floor).toBe(floor);
		expect(withNone!.tab.handed[0]?.entry.floor).toBe(withNone!.tab.handed[0]?.entry.takenAt.number);

		// the tab answers as of any block inside the history exactly as the publisher's database does
		const loaded = await loadProcessorArtifact<ABI, unknown, EntityProcessor<ABI>>(
			new Uint8Array(readFileSync(BUNDLE)),
		);
		if (loaded.status !== 'instantiated') throw new Error(`the fixture bundle was refused: ${loaded.why}`);
		const database = await canonicalStoreIn(withHistory!.db, loaded.processor.entities);
		const store = withHistory!.tab.store();
		for (const at of [floor, inside, START_BLOCK + 70, CUT]) {
			expect(await stateOf(asOf(store, at))).toEqual(await stateOf(asOf(database, at)));
		}

		// a revert inside it lands on the state the publisher had there
		await store.revertTo(inside);
		expect(await stateOf(store)).toEqual(await stateOf(asOf(database, inside)));
		expect(await stateOf(store)).toEqual({owners: {'1': BOB, '2': CAROL, '3': undefined}, transfers: 3});
		// ...and under the floor it is refused, as it is under the cut of a snapshot published with none
		await expect(store.revertTo(floor - 1)).rejects.toThrow(RevertBeyondSnapshotError);
		await expect(withNone!.tab.store().revertTo(inside)).rejects.toThrow(RevertBeyondSnapshotError);
	});

	it('THE OLD-BUILD CASE: after a new processor is published, a tab still running the old bundle starts from its own entry', async () => {
		const root = aWorkspace();
		const out = join(root, 'published');
		const deployments = aDeploymentsFolder(root);
		const db = oneDatabase();
		await buildAndPublish(db, fakeChain().serve(LOGS, TIP), {bundle: BUNDLE, deployments, out});

		// the chain moves on, and the next scheduled job runs the NEW bundle over the same database
		const later: RawLog[] = [...LOGS, transfer(TIP + 20, '0xa120', BOB, CAROL, 3n)];
		const laterTip = TIP + 40;
		await buildAndPublish(db, fakeChain().serve(later, laterTip), {bundle: EDITED_BUNDLE, deployments, out});
		const oldIdentity = await identityOf(BUNDLE);
		const newIdentity = await identityOf(EDITED_BUNDLE);
		expect((await canonicalGenerationIn(db))!.processor).toBe(newIdentity);

		// NEVER FORGETS: the old generation's entry is still there beside the new one
		const entries = Object.values(theIndexIn(out).snapshots);
		const oldEntry = entries.find((entry) => entry.processor === oldIdentity);
		const newEntry = entries.find((entry) => entry.processor === newIdentity);
		expect(oldEntry).toMatchObject({cut: CUT});
		expect(newEntry).toMatchObject({cut: laterTip - FINALITY});
		expect(oldEntry!.stream).toBe(newEntry!.stream);

		const host = aStaticHost(out);
		const chain = fakeChain().serve(later, laterTip);
		const oldTab = aTab({host, publication: true});
		const selfChain = fakeChain().serve(later, laterTip);
		const oldSelfIndexing = aTab({host});
		const newTab = aTab({host, bundle: EDITED_BUNDLE_URL, publication: true});
		try {
			const started = await booted(oldTab, chain);
			expect(oldTab.handed.map((handed) => handed?.entry)).toEqual([oldEntry]);
			expect(oldTab.outcomes).toEqual([
				{status: 'bootstrapped', at: oldEntry!.takenAt.number, from: `${APP}/published/${oldEntry!.body}`},
			]);
			// stale but valid: it indexes forward from its own cut to the chain's new tip
			expect(Math.min(...chain.logRanges.map((range) => range.from))).toBe(CUT);
			expect(started).toEqual(await booted(oldSelfIndexing, selfChain));
			expect(started).toEqual({owners: {'1': BOB, '2': ALICE, '3': CAROL}, transfers: later.length});

			// and the new build starts from the new entry
			await booted(newTab, fakeChain().serve(later, laterTip));
			expect(newTab.handed.map((handed) => handed?.entry)).toEqual([newEntry]);
		} finally {
			oldTab.indexer.dispose();
			oldSelfIndexing.indexer.dispose();
			newTab.indexer.dispose();
		}
	});
});

/** A store's reads as of one block, in the shape `stateOf` reads. */
function asOf(store: Pick<SnapshotAwareStateStore, 'getAsOf'>, at: number) {
	return {getCurrent: ((entity: string, id: never) => store.getAsOf(entity, id, at)) as EntityStateView['getCurrent']};
}
