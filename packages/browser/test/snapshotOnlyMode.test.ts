import 'fake-indexeddb/auto';
import {resolveStreamConfig, type LastSync} from '@etherfold/core';
import {
	createSnapshot,
	entityProcessorVersionHash,
	openAndBootstrap,
	type EntityProcessor,
	type Mutation,
	type StateSnapshot,
	type StateStore,
} from '@etherfold/processor-entities';
import {get, keys as allKeys} from 'idb-keyval';
import {describe, expect, it} from 'vitest';
import {createBrowserStateStore, keepStreamOnIndexedDB, streamAddress} from '../src/index.js';
import {
	BRANCH_A,
	BRANCH_A_EXTENDED,
	BRANCH_A_EXTENDED_TIP,
	BRANCH_A_TIP,
	BRANCH_B,
	BRANCH_B_TIP,
	fakeChain,
	FINALITY,
	indexToTip,
	SOURCE,
	START_BLOCK,
	timestampOf,
	type TestABI,
} from '../browser/workload.js';
import {appliedIn, applyingProcessor, indexerOver, keysOf} from './utils/applied.js';

/**
 * THE SNAPSHOT-ONLY MODE: a snapshot-seeded generation that keeps NO stream.
 *
 * The configuration most browser apps should run, and the one the reference
 * deployment actually ran: the state arrives as a published **snapshot**, the
 * generation indexes forward from the snapshot's block, and `keepStream` is
 * ABSENT, so nothing under the stream keyspace is ever written or read. It buys
 * a tab that starts in a second on a public node that will not serve the
 * historical `eth_getLogs` a backfill needs; what it costs is stated by
 * `work/specs/tasked/a-browser-app-starts-from-a-published-artifact.md` and is
 * not this file's subject: the generation is a LEAF (ADR-0028's retention floor,
 * and no stream beneath it to re-fold), so a later processor-only change waits
 * for a republished snapshot instead of being free.
 *
 * Nothing here is a new seam. `keepStream` is already optional, `promiseToSave`
 * already answers `'skipped'` without one, and `bootstrapFromSnapshot` already
 * ships. What was missing is that the COMBINATION is a supported mode rather
 * than an accident: nothing named it and nothing asserted it, so an author
 * choosing it was guessing. `snapshotOnlyClient` below is that name, and the
 * cases are the assertion.
 *
 * The load-bearing claim is stated as external behaviour and proved by READING
 * KEYS: after a full run there is no segment and no cursor record at the address
 * a keeper would have used, and nothing anywhere else under `['stream', ...]`
 * either. A spy would only say that one call did not happen on one path; the
 * keys say that nothing was written on ANY path, including the load path, the
 * reorg re-scan and a reload. Each claim is made against a CONTROL in the same
 * case -- the neighbouring mode, snapshot-seeded WITH a keeper, over the same
 * snapshot and the same events -- so "empty" is measured with an instrument the
 * case has just shown to be capable of reading something.
 */

let counter = 0;
const freshName = () => `snapshot-only-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

const CONFIG = {stream: {finality: FINALITY}};

/**
 * The block the published snapshot is taken at, and it is deliberately BELOW the
 * block the reorg replaces.
 *
 * A snapshot carries nothing under its own block, so the store refuses a revert
 * reaching there (`RevertBeyondSnapshotError`). The reorg case retracts block
 * 104, which reverts to 103, so a publisher at the branch tip would be asserting
 * that a client cannot survive the very reorg this mode has to survive. 102 is
 * also inside the finality window the publisher's own cursor carries, which is
 * what lets a resumed client re-read blocks 100 and 102 without applying them a
 * second time.
 */
const SNAPSHOT_TIP = 102;

/**
 * The chain tip the PUBLISHER had seen when it took that snapshot.
 *
 * ADR-0028's producer rule, made real in the fixture rather than only written
 * down: a snapshot is taken at least the finality depth behind the tip, because
 * it carries nothing below its own block and so cannot absorb a reorg reaching
 * under it. `SNAPSHOT_TIP + FINALITY` is exactly that bound, which is the
 * shallowest LEGAL publisher and therefore the value that would catch an
 * off-by-one in the consumer's check.
 *
 * It matters that this is a SEPARATE number from `SNAPSHOT_TIP`. An earlier
 * version of this fixture published a cursor whose `latestBlock` WAS the
 * snapshot's own block, which is what a run that indexes straight to the tip
 * produces -- and against that, `insideReorgWindow` is true for any positive
 * depth, so every case here would have been refused the moment the client
 * started passing `finalityDepth`. The guard was therefore never exercised, and
 * the mode this file documents omitted half of ADR-0028's two-sided defence
 * (`the-snapshot-only-mode-test-never-exercises-the-inside-reorg-window-guard`).
 */
const PUBLISHER_OBSERVED_TIP = SNAPSHOT_TIP + FINALITY;

/** How many of branch A's events are already IN the snapshot rather than indexed. */
const IN_SNAPSHOT = BRANCH_A.filter((log) => parseInt(log.blockNumber.slice(2), 16) <= SNAPSHOT_TIP).length;

/**
 * The LIVE rows of the `applied` entity, as the upserts that reproduce them.
 *
 * A real publisher needs a ledger of the ids its run touched or a backend's own
 * query surface (the seam has no "list everything" read, ADR-0021). This
 * fixture's entity is keyed `{bucket, at}` under one constant bucket precisely
 * so that "everything this processor applied" IS a bounded id-prefix listing, so
 * the minimal producer needs nothing the seam does not already have.
 */
async function liveRowsOf(store: StateStore): Promise<Mutation[]> {
	const listing = await store.listCurrent<{bucket: string; at: string; key: string; times: number}>(
		'applied',
		{bucket: 'all'},
		500,
	);
	expect(listing.truncated).toBe(false);
	return listing.rows.map((row) => ({
		type: 'upsert',
		entity: 'applied',
		id: {bucket: row.bucket, at: row.at},
		values: {key: row.key, times: Number(row.times)},
	}));
}

/** A publisher tab: index to `SNAPSHOT_TIP` and publish what it computed. */
async function publishSnapshot(definition: EntityProcessor<TestABI>): Promise<StateSnapshot> {
	const store = await createBrowserStateStore(definition.entities, {databaseName: freshName()});
	const indexer = indexerOver(definition, store);
	await indexer.init({provider: fakeChain(BRANCH_A, SNAPSHOT_TIP).provider, source: SOURCE, config: CONFIG});
	const lastSync = await indexToTip(indexer as never);
	const rows = await liveRowsOf(store);
	indexer.dispose();

	expect(lastSync.lastToBlock).toBe(SNAPSHOT_TIP);
	expect(rows).toHaveLength(IN_SNAPSHOT);
	return snapshotOf(definition, lastSync, rows, PUBLISHER_OBSERVED_TIP);
}

/**
 * The published document, with the tip its producer says it had SEEN.
 *
 * `observedTip` is read off the published CURSOR's `latestBlock`, so that is the
 * one field a publisher varies to say "I took this behind my own tip". Raising
 * it here rather than driving the publisher's fake chain higher is deliberate:
 * `indexToTip` ends with `lastToBlock === latestBlock` by construction, so no
 * amount of fixture chain-wrangling produces a snapshot that is legally behind
 * its own tip. A real publisher reads its rows as-of a block below the tip; this
 * fixture states the same relationship directly, which is what the check reads.
 */
function snapshotOf(
	definition: EntityProcessor<TestABI>,
	lastSync: LastSync<TestABI>,
	rows: Mutation[],
	observedTip: number,
): StateSnapshot {
	return createSnapshot<TestABI>({
		takenAt: {
			number: lastSync.lastToBlock,
			hash: `0xsnap${lastSync.lastToBlock.toString(16)}`,
			timestamp: timestampOf(lastSync.lastToBlock),
		},
		rows,
		lastSync: {...lastSync, latestBlock: observedTip},
		processor: entityProcessorVersionHash(definition),
	});
}

/** A mirror that serves one snapshot. */
function mirror(snapshot: StateSnapshot) {
	const fetch = (async () => ({json: async () => snapshot}) as Response) as unknown as typeof globalThis.fetch;
	return {url: 'https://mirror.example/state.json', fetch};
}

type ClientOptions = {
	databaseName: string;
	definition: EntityProcessor<TestABI>;
	snapshot: StateSnapshot;
	/** The indexer NAME a stream would be addressed under. See `snapshotOnlyClient`. */
	name: string;
};

/**
 * THE MODE, as one call: bootstrap from the published snapshot, then index with
 * NO stream keeper.
 *
 * `openAndBootstrap` is the boot path an app writes -- it opens the store
 * snapshot-aware (which is what recovers a floor a previous run recorded) and
 * only then decides whether to fetch anything -- so the same call is the first
 * run AND the reload, which is why the reload case below is this function a
 * second time over the same database name.
 *
 * The absent `keepStream` is the whole of the mode. `name` is carried anyway,
 * unused by anything here, because it is the name a keeper WOULD have been
 * opened under and therefore the name the emptiness assertion has to read: an
 * assertion that could not say WHERE it looked would be vacuous.
 */
async function snapshotOnlyClient(options: ClientOptions) {
	const {store, outcome} = await seededFromTheSnapshot(options);
	return {store, outcome, indexer: indexerOver(options.definition, store)};
}

/**
 * The NEIGHBOURING mode, and the control: the same snapshot, the same events,
 * and a real IndexedDB stream keeper under it.
 *
 * It is what makes the empty-keyspace claim mean something. Reading no keys
 * proves nothing unless the same reader, in the same case, over the same
 * workload, reads keys when a keeper is present.
 */
async function keptStreamClient(options: ClientOptions) {
	const {store, outcome} = await seededFromTheSnapshot(options);
	return {
		store,
		outcome,
		indexer: indexerOver(options.definition, store, {keepStream: keepStreamOnIndexedDB<TestABI>(options.name)}),
	};
}

/** The half the two modes SHARE: the seeding. Only the keeper above differs. */
async function seededFromTheSnapshot(options: ClientOptions) {
	const remote = mirror(options.snapshot);
	return openAndBootstrap(
		await createBrowserStateStore(options.definition.entities, {databaseName: options.databaseName}),
		remote.url,
		// `finalityDepth` is the CONSUMER's half of ADR-0028's two-sided defence, and
		// it is passed here because a client that omits it silently runs without it:
		// `insideReorgWindow` is skipped entirely when the option is absent, so a
		// snapshot taken at its producer's own tip would install. It is the same
		// finality the indexer runs under, which is what the guide tells an author.
		{processor: entityProcessorVersionHash(options.definition), fetch: remote.fetch, finalityDepth: FINALITY},
	);
}

/**
 * Every key the stream keyspace holds, under ANY indexer name and any stream.
 *
 * Read from the object store the browser keeper actually writes to
 * (`idb-keyval`'s default, which `keyvalStore()` re-derives), because the claim
 * is about the substrate a keeper would have used and not about a substrate this
 * file invented. It is scoped to the leading `'stream'` literal, and the cases
 * compare it BEFORE and AFTER a run rather than asserting it is globally empty:
 * the control runs in this file put keys there deliberately, and what the mode
 * claims is that IT wrote nothing, not that nobody ever did.
 */
async function streamKeyspace(): Promise<IDBValidKey[][]> {
	return (await allKeys()).filter((key): key is IDBValidKey[] => Array.isArray(key) && key[0] === 'stream');
}

/** What a keeper under `name` holds: its segments, and its cursor record. */
async function streamStoredUnder(name: string): Promise<{segments: IDBValidKey[][]; cursor: unknown}> {
	const address = streamAddress(name, SOURCE, resolveStreamConfig(CONFIG.stream));
	const under = (await streamKeyspace()).filter((key) => key[1] === name);
	return {
		segments: under.filter((key) => typeof key[3] === 'number'),
		cursor: await get(address.cursor),
	};
}

/** The control's evidence that the reader above can see a stream when there is one. */
async function expectStreamStoredUnder(name: string): Promise<void> {
	const stored = await streamStoredUnder(name);
	expect(stored.segments.length).toBeGreaterThan(0);
	expect(stored.cursor).toBeDefined();
}

/**
 * The load-bearing assertion: NOTHING under the stream keyspace, by the keys.
 *
 * Both halves, because a keeper writes both and either alone would be a stream:
 * no segment at the address, and no cursor record -- a cursor with no segments
 * is not damage but a scanned-and-found-nothing stream, so its absence has to be
 * asserted in its own right. And then the whole keyspace, unchanged across the
 * run, which is the half that catches a write under a name this case never chose.
 */
async function expectNoStreamWritten(name: string, before: IDBValidKey[][]): Promise<void> {
	const stored = await streamStoredUnder(name);
	expect(stored.segments).toEqual([]);
	expect(stored.cursor).toBeUndefined();
	expect(await streamKeyspace()).toEqual(before);
}

describe('the snapshot-only mode: a snapshot-seeded generation with NO stream keeper', () => {
	it('lands where a kept-stream run lands, and leaves the stream keyspace it would have used EMPTY', async () => {
		const definition = applyingProcessor();
		const snapshot = await publishSnapshot(definition);

		// the control: the same snapshot and the same events, with a keeper under it
		const keptName = freshName();
		const kept = await keptStreamClient({databaseName: keptName, definition, snapshot, name: keptName});
		expect(kept.outcome).toMatchObject({status: 'bootstrapped', at: SNAPSHOT_TIP});
		const keptChain = fakeChain(BRANCH_A, BRANCH_A_TIP);
		await kept.indexer.init({provider: keptChain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(kept.indexer as never);
		const keptApplied = await appliedIn(kept.indexer.state.$state);
		kept.indexer.dispose();
		await expectStreamStoredUnder(keptName);

		// THE MODE
		const soloName = freshName();
		const before = await streamKeyspace();
		const solo = await snapshotOnlyClient({databaseName: soloName, definition, snapshot, name: soloName});
		expect(solo.outcome).toMatchObject({status: 'bootstrapped', at: SNAPSHOT_TIP});
		const soloChain = fakeChain(BRANCH_A, BRANCH_A_TIP);
		await solo.indexer.init({provider: soloChain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(solo.indexer as never);
		const soloApplied = await appliedIn(solo.indexer.state.$state);
		solo.indexer.dispose();

		// the same state, the whole branch, and nothing applied twice: the rows the
		// snapshot installed plus the ones this tab indexed on top of them
		expect(soloApplied).toEqual(keptApplied);
		expect(soloApplied).toHaveLength(BRANCH_A.length);
		expect(soloApplied.map((row) => row.times)).toEqual(soloApplied.map(() => 1));
		// and it started from the snapshot's cursor rather than from nothing: the first
		// range is the reorg window below the tip that cursor OBSERVED, and everything
		// in it was already accounted for, which is why every row above is applied
		// exactly once. It is the observed tip and not the snapshot's own block that
		// sets this, which is visible here only because the publisher now reports the
		// two as different numbers, as a legal publisher must.
		expect(soloChain.ranges[0].from).toBe(PUBLISHER_OBSERVED_TIP - FINALITY);
		// and the claim that makes that assertion mean something: a run starting from
		// nothing would have asked from the source's own start block
		expect(soloChain.ranges[0].from).toBeGreaterThan(START_BLOCK);

		await expectNoStreamWritten(soloName, before);
	});

	it('survives a reorg inside the finality window, still writing nothing', async () => {
		const definition = applyingProcessor();
		const snapshot = await publishSnapshot(definition);

		/**
		 * Index branch A to its tip, then the reorged branch B on top of it.
		 *
		 * The state BEFORE the reorg is returned too, because "the dead branch is not
		 * in the final state" is satisfied just as well by never having applied it:
		 * what makes this a reorg rather than a different chain is that block 104 was
		 * applied and then taken back.
		 */
		async function throughTheReorg(client: {indexer: ReturnType<typeof indexerOver>}) {
			const chain = fakeChain(BRANCH_A, BRANCH_A_TIP);
			await client.indexer.init({provider: chain.provider, source: SOURCE, config: CONFIG});
			await indexToTip(client.indexer as never);
			const before = await appliedIn(client.indexer.state.$state);
			chain.serve(BRANCH_B, BRANCH_B_TIP);
			await indexToTip(client.indexer as never);
			const after = await appliedIn(client.indexer.state.$state);
			client.indexer.dispose();
			return {before, after};
		}

		const keptName = freshName();
		const kept = await throughTheReorg(
			await keptStreamClient({databaseName: keptName, definition, snapshot, name: keptName}),
		);
		await expectStreamStoredUnder(keptName);

		const soloName = freshName();
		const before = await streamKeyspace();
		const solo = await throughTheReorg(
			await snapshotOnlyClient({databaseName: soloName, definition, snapshot, name: soloName}),
		);

		// the reorged block WAS applied, and inside the window a reorg can still reach:
		// the tip was 105 and the finality window is 3, so 104 is retractable
		expect(keysOf(solo.before)).toContain('0xa104:0');
		expect(BRANCH_A_TIP - FINALITY).toBeLessThan(104);
		// and then taken back: the dead branch is gone, the replacement is in, and the
		// revert stopped at the snapshot's own block rather than reaching under it
		expect(keysOf(solo.after)).toContain('0xb104:0');
		expect(keysOf(solo.after).filter((key) => key.startsWith('0xa104'))).toEqual([]);
		expect(solo.after.map((row) => row.times)).toEqual(solo.after.map(() => 1));
		expect(solo.after).toEqual(kept.after);

		await expectNoStreamWritten(soloName, before);
	});

	it('comes back on a RELOAD, keeps its state, continues, and still writes nothing', async () => {
		const definition = applyingProcessor();
		const snapshot = await publishSnapshot(definition);
		const soloName = freshName();
		const client = {databaseName: soloName, definition, snapshot, name: soloName};

		const first = await snapshotOnlyClient(client);
		const chain = fakeChain(BRANCH_A, BRANCH_A_TIP);
		await first.indexer.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		const reached = await indexToTip(first.indexer as never);
		const applied = await appliedIn(first.indexer.state.$state);
		first.indexer.dispose();
		expect(reached.lastToBlock).toBe(BRANCH_A_TIP);

		// THE RELOAD: the same database, opened by the same boot path. It keeps what
		// it has and downloads nothing -- which is what makes this a reload and not a
		// second bootstrap -- and the store still reports the floor the snapshot gave
		// it, because the origin was persisted.
		const before = await streamKeyspace();
		chain.serve(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP);
		const reloaded = await snapshotOnlyClient(client);
		expect(reloaded.outcome).toEqual({status: 'kept-local', at: BRANCH_A_TIP});
		expect(reloaded.store.snapshotOrigin).toBe(SNAPSHOT_TIP);
		expect(await appliedIn(reloaded.store)).toEqual(applied);

		await reloaded.indexer.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(reloaded.indexer as never);
		const continued = await appliedIn(reloaded.indexer.state.$state);
		reloaded.indexer.dispose();

		// it carried on from where it was rather than starting over
		expect(keysOf(continued)).toEqual([...keysOf(applied), '0xa106:0']);
		expect(continued.map((row) => row.times)).toEqual(continued.map(() => 1));

		await expectNoStreamWritten(soloName, before);
	});

	it('REFUSES a snapshot its producer took inside the reorg window, and comes up with nothing rather than with a branch that may have lost', async () => {
		// The guard the cases above rely on, asserted to be LIVE. Without this, every
		// case here passes just as well with `finalityDepth` omitted -- which is exactly
		// how this fixture used to be written, and it meant the mode a developer copies
		// from this file showed only the PRODUCER half of ADR-0028's two-sided defence.
		//
		// A snapshot carries nothing below its own block, so one taken too close to the
		// tip can record a branch that later loses and cannot be reverted out of. The
		// producer's job is to stay the finality depth behind; the consumer's is to
		// refuse one that did not, and only the consumer can protect a client from a
		// publisher that got it wrong.
		const definition = applyingProcessor();
		const store = await createBrowserStateStore(definition.entities, {databaseName: freshName()});
		const indexer = indexerOver(definition, store);
		await indexer.init({provider: fakeChain(BRANCH_A, SNAPSHOT_TIP).provider, source: SOURCE, config: CONFIG});
		const lastSync = await indexToTip(indexer as never);
		const rows = await liveRowsOf(store);
		indexer.dispose();

		// the one thing that differs from `publishSnapshot`: this publisher reports the
		// snapshot's OWN block as the tip it had seen, which is what indexing straight
		// to the tip and publishing produces
		const atTheTip = snapshotOf(definition, lastSync, rows, SNAPSHOT_TIP);
		const soloName = freshName();
		const before = await streamKeyspace();

		const refused = await snapshotOnlyClient({
			databaseName: soloName,
			definition,
			snapshot: atTheTip,
			name: soloName,
		});

		expect(refused.outcome).toEqual({status: 'not-bootstrapped', reason: 'inside-reorg-window'});
		// refused, so NOTHING was installed: the tab comes up empty and indexes from the
		// start block, which is slow and correct rather than fast and possibly wrong
		expect(await appliedIn(refused.store)).toEqual([]);
		expect(refused.store.snapshotOrigin).toBeUndefined();
		// and the mode's own claim still holds on the refusal path
		await expectNoStreamWritten(soloName, before);

		// the SAME publisher, one block deeper, is admitted: the refusal is about the
		// depth and not about anything else in the document
		const legal = snapshotOf(definition, lastSync, rows, SNAPSHOT_TIP + FINALITY);
		const admittedName = freshName();
		const admitted = await snapshotOnlyClient({
			databaseName: admittedName,
			definition,
			snapshot: legal,
			name: admittedName,
		});
		expect(admitted.outcome).toMatchObject({status: 'bootstrapped', at: SNAPSHOT_TIP});
	});
});
