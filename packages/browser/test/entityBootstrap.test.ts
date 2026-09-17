import 'fake-indexeddb/auto';
import {
	bootstrapFromSnapshot,
	createSnapshot,
	openSnapshotAware,
	type SnapshotAwareStateStore,
} from '@etherfold/processor-entities';
import {
	BlockNotRetainedError,
	openForWriting,
	type Mutation,
	type StateSnapshot,
	type StateStore,
} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {
	BRANCH_A_TIP,
	EXPECTED_A,
	fakeChain,
	FINALITY,
	processor,
	runWorkload,
	START_BLOCK,
	timestampOf,
	type TestABI,
} from '../browser/workload.js';
import {createBrowserStateStore} from '../src/index.js';
import {identityOf} from './utils/processorIdentity.js';

/**
 * A tab that comes up from state somebody else computed.
 *
 * This is where the capability is worth having, and it is the one the retired
 * free-form path had first: its `keepStateOnIndexedDB(name, remote)` let a new
 * tab of a shipped app download a published snapshot instead of replaying every
 * log the contract emitted, and the entity path would have quietly lost that
 * when the free-form one was deleted (ADR-0037). The mechanism lives in `@etherfold/processor-entities` (the store's
 * cursor is an opaque string, so only the layer that owns its codec can ask "is
 * local already ahead"), and these cases check it through the hook an
 * application actually wires.
 *
 * The assertion that matters is about the RANGES the tab asks its node for, not
 * about the state it ends on: re-indexing from the start block lands on the same
 * rows, so only the requests can tell the two apart. It is the same shape as the
 * reload case in `entityIndexing.test.ts`, one door further out -- there the tab
 * resumes from state IT computed, here from state it was given.
 */

let counter = 0;
const freshName = () => `entity-bootstrap-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** The lowest block a resumed round may ask for: the window a reorg can still reach. */
const RESUME_FLOOR = BRANCH_A_TIP - FINALITY;

const IDS = ['1', '2', '3', '4'];

/**
 * The minimal producer, in its natural habitat: a store that HAS the state, and
 * a caller that knows which ids it wrote.
 *
 * That last clause is why publishing is its own design rather than a function
 * here. The seam has no "list everything" read and deliberately never will
 * (ADR-0021), so a producer needs either a ledger of the ids a run touched or a
 * backend's own query surface. A test knows its four ids; a publisher does not
 * get off so lightly.
 */
async function publish(store: StateStore, lastSync: Parameters<typeof createSnapshot<TestABI>>[0]['lastSync']) {
	const rows: Mutation[] = [];
	for (const id of IDS) {
		const token = await store.getCurrent<{owner: string}>('token', {id});
		if (token) rows.push({type: 'upsert', entity: 'token', id: {id}, values: {owner: token.owner}});
	}
	const tally = await store.getCurrent<{value: number}>('counter', {name: 'transfers'});
	if (tally) rows.push({type: 'upsert', entity: 'counter', id: {name: 'transfers'}, values: {value: tally.value}});

	return createSnapshot<TestABI>({
		takenAt: {
			number: lastSync.lastToBlock,
			hash: `0xsnap${lastSync.lastToBlock.toString(16)}`,
			timestamp: timestampOf(lastSync.lastToBlock),
		},
		rows,
		lastSync,
		// the identity the fold that computed these rows was handed, which is what
		// makes this snapshot adoptable at all.
		processor: APP_IDENTITY,
	});
}

/**
 * WHICH FOLD computed these rows, and which fold may adopt them: the identity the
 * app's ARRIVAL derived (ADR-0086), supplied to every indexer in this file and
 * written into every snapshot it publishes.
 *
 * It used to be taken from the runtime, by building a processor and asking it for
 * its declared version hash. An author cannot STATE an identity any more: a
 * browser app is handed one, derived from what its processor IS, so the test does
 * what an arrival does -- it has BYTES and it hashes them. Nothing here parses the
 * result; the candidate rule is an equality between the label a producer wrote and
 * the identity the client says it is running, which is exactly what this value is
 * on both sides.
 *
 * The DERIVATION a producer should use for that label is
 * `a-snapshot-is-labelled-with-the-identity-it-was-computed-under`; what this file
 * is about is the bootstrap, which compares the two and never computes either.
 */
const APP_IDENTITY = identityOf('published-app');

/** A mirror that serves one snapshot, and records what was asked for. */
function mirror(snapshot: StateSnapshot) {
	const asked: string[] = [];
	const fetch = (async (input: string | URL | Request) => {
		asked.push(String(input));
		return {json: async () => snapshot} as Response;
	}) as unknown as typeof globalThis.fetch;
	return {url: 'https://mirror.example/state.json', fetch, asked};
}

/** A store the tab may have been bootstrapped into, opened the way the boot path must open it. */
async function browserStore(databaseName = freshName()): Promise<SnapshotAwareStateStore> {
	return openSnapshotAware(await createBrowserStateStore(processor.entities, {databaseName}));
}

describe('a new tab that starts from a published snapshot', () => {
	it('resumes from the snapshot instead of asking for the start block', async () => {
		// tab A does the work, and publishes what it computed
		const publisher = await openForWriting(
			await createBrowserStateStore(processor.entities, {databaseName: freshName()}),
		);
		const first = await runWorkload(publisher, fakeChain(), APP_IDENTITY);
		expect(first.state).toEqual(EXPECTED_A);
		expect(first.ranges[0].from).toBe(START_BLOCK);
		const snapshot = await publish(publisher, first.lastSync);

		// tab B is a different browser, on a different machine: an empty database
		const store = await browserStore();
		const remote = mirror(snapshot);
		const outcome = await bootstrapFromSnapshot(store, remote.url, {
			// a real publisher takes a snapshot at least the finality depth behind
			// the tip, and `finalityDepth` here is how a client insists on it; this
			// fixture's tip IS the snapshot block, so the option is left off.
			processor: APP_IDENTITY,
			fetch: remote.fetch,
		});
		expect(outcome).toMatchObject({status: 'bootstrapped', at: BRANCH_A_TIP});

		const second = await runWorkload(await openForWriting(store), fakeChain(), APP_IDENTITY);

		expect(second.state).toEqual(EXPECTED_A);
		// the point: this tab never asked for the start block. It asked from inside
		// the unconfirmed window the snapshot's cursor carried.
		expect(second.ranges[0].from).toBeGreaterThan(START_BLOCK);
		expect(second.ranges[0].from).toBeGreaterThanOrEqual(RESUME_FLOOR);
	});

	it('refuses the history it never received, rather than answering from the rows it was given', async () => {
		const publisher = await openForWriting(
			await createBrowserStateStore(processor.entities, {databaseName: freshName()}),
		);
		const first = await runWorkload(publisher, fakeChain(), APP_IDENTITY);
		const snapshot = await publish(publisher, first.lastSync);

		const store = await browserStore();
		const remote = mirror(snapshot);
		await bootstrapFromSnapshot(store, remote.url, {processor: APP_IDENTITY, fetch: remote.fetch});

		// the tab that computed the state can answer about the block token 1 moved in
		expect(await publisher.getAsOf('token', {id: '1'}, START_BLOCK)).toMatchObject({owner: expect.any(String)});
		// the tab that was GIVEN the state cannot, and says so
		await expect(store.getAsOf('token', {id: '1'}, START_BLOCK)).rejects.toBeInstanceOf(BlockNotRetainedError);
		expect(store.capabilities.retention).toMatchObject({kind: 'window'});
	});

	it('keeps its own state when a mirror is behind it, and downloads nothing more', async () => {
		const databaseName = freshName();
		const publisher = await openForWriting(await createBrowserStateStore(processor.entities, {databaseName}));
		const first = await runWorkload(publisher, fakeChain(), APP_IDENTITY);
		// only its HEAD is ever read (it loses the comparison), so the rows it
		// carries never matter; what is under test is the choice, not the payload.
		const stale = await publish(publisher, {...first.lastSync, lastToBlock: START_BLOCK - 1});

		// the same tab, reopened: it has a cursor at the tip already
		const store = await browserStore(databaseName);
		const remote = mirror(stale);
		const outcome = await bootstrapFromSnapshot(store, remote.url, {
			processor: APP_IDENTITY,
			fetch: remote.fetch,
		});

		expect(outcome).toEqual({status: 'kept-local', at: first.lastSync.lastToBlock});
		// the head was read to compare; nothing was installed over the local state
		expect(store.snapshotOrigin).toBeUndefined();
		expect(await store.getCurrent('counter', {name: 'transfers'})).toMatchObject({value: EXPECTED_A.transfers});
	});
});
