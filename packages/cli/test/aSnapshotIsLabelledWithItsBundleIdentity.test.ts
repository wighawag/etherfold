import {createClient} from '@libsql/client';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
	bootstrapFromSnapshot,
	createSnapshot,
	deserializeLastSync,
	EntityEventProcessor,
	localPosition,
	openForWriting,
	openSnapshotAware,
	SnapshotProcessorMismatchError,
	SYNC_CURSOR_KEY,
	type EntityProcessor,
	type Mutation,
	type SnapshotAwareStateStore,
	type StateSnapshot,
	type StateStore,
} from '@etherfold/processor-entities';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {loadProcessorArtifact, processorArtifactIdentity} from '@etherfold/utils';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {canonicalGenerationIn, prepareIndexing, type IndexingDependencies} from '../src/index.js';
import type {Options} from '../src/types.js';
import {abi, ALICE, BOB, fakeChain, SOURCE, START_BLOCK, timestampOf, transfer, ZERO} from './utils/chain.js';
import {canonicalStoreIn} from './utils/reads.js';

// ---------------------------------------------------------------------------------------------------
// A SNAPSHOT IS LABELLED WITH THE IDENTITY IT WAS COMPUTED UNDER, SO THE CANDIDATE RULE KEEPS WORKING
// ---------------------------------------------------------------------------------------------------
// A published snapshot carries a `processor` label, and the client-side rule is
// that a snapshot from another processor IS NOT A CANDIDATE at all. The rule is
// unchanged; what moved is where the VALUE comes from -- the identity the
// producing deployment's ARRIVAL derived (ADR-0086), which for a deployment
// running a bundle is the SHA-256 of those octets.
//
// ## Why this is asserted HERE, and end to end rather than as a string compare
//
// The two halves of the round trip live in two packages that never meet in
// either of them: the artifact and its identity are `@etherfold/utils`, the
// producer and the candidate rule are `@etherfold/processor-entities`. This
// package is where a deployment actually runs a bundle, so it is the only place
// the whole sentence can be said in one breath: FOLD some blocks through a real
// committed bundle, publish what that fold computed, and hand the envelope to a
// client that derived ITS identity independently, from the same bytes, through
// the loader an arrival uses. Nothing here passes a literal from one side to the
// other -- which is the point, because two string constants agreeing proves
// nothing about the two derivations agreeing.
//
// ## Why the leaf property makes this worth a suite of its own
//
// A snapshot-seeded generation is a LEAF: it has no stream to re-fold and no
// history below its own block (`CONTEXT.md`, `seeding`; ADR-0028). Such a client
// cannot recover from a mislabelled snapshot by re-indexing -- on a public node
// the historical `eth_getLogs` a backfill needs is frequently refused outright --
// so "the label is right" and "the rule is exactly as strict as it was" are the
// two halves of whether a browser app survives its own next deploy.
//
// ## The FORMAT number did NOT move, deliberately
//
// This is a VALUE change and not a FORMAT change: the envelope's shape is
// identical, `processor` is the same field with the same meaning, and it is
// opaque on both sides (compared for equality, never parsed). A label derived
// the old way does not become half-readable under the new one, it becomes NOT A
// CANDIDATE, which is the refusal this suite asserts rather than a document read
// in part. The reasoning is recorded beside the constant
// (`ENTITY_SNAPSHOT_FORMAT`, `@etherfold/state-store`).
// ---------------------------------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL('./fixtures/processor-bundle/', import.meta.url));
/** What a deployment ships, and what the app a client loads is built from. */
const BUNDLE = join(FIXTURES, 'nfts.bundle.js');
/** THE SAME FILE with one handler line changed: a different fold, declaring nothing different. */
const EDITED_BUNDLE = join(FIXTURES, 'nfts-edited.bundle.js');

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
];
const TIP = START_BLOCK + 100;
const TOKEN = '1'.padStart(78, '0');
/** The reorg depth a client states when it loads: what the stream config carries, nothing more. */
const FINALITY = 12;

/** Bounded fetch ranges, read from the environment the way every fetcher host reads them. */
const SMALL_RANGES = {MAX_BLOCKS_PER_FETCH: '20'};

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

function optionsFor(processor: string): Options {
	return {processor, nodeUrl: 'http://localhost:0', store: 'sqlite', db: ':memory:'};
}

function depsFor(chain: ReturnType<typeof fakeChain>, db: RemoteSQL): IndexingDependencies {
	// `importModule` is ABSENT on purpose: an injected arrival would name the fold
	// something a test chose, and what is under test is the name the BYTES have.
	return {provider: chain.provider, createDB: () => db, sleep: async () => {}, env: SMALL_RANGES};
}

/**
 * A DEPLOYMENT RUNNING A BUNDLE, folded to the tip, plus what it published.
 *
 * The label is read off the generation the deployment REGISTERED rather than
 * hashed again here, and that is the criterion rather than an economy: the value
 * has to be the identity of the artifact this fold actually ran under, so it
 * comes from the fold. A producer is otherwise free to hand `createSnapshot`
 * anything, which is exactly the silent lie ADR-0086 exists to delete.
 */
async function aDeploymentPublishing(bundle: string): Promise<StateSnapshot> {
	const db = oneDatabase();
	const chain = fakeChain().serve(LOGS, TIP);
	const prepared = await prepareIndexing('build', optionsFor(bundle), depsFor(chain, db));
	expect((await prepared.index()).stoppedBecause).toBe('stopped');

	const canonical = await canonicalGenerationIn(db);
	if (canonical === undefined) throw new Error(`this deployment registered no generation at all`);
	const store = await canonicalStoreIn(db, (await theBundleAt(bundle)).processor.entities);
	const lastSync = deserializeLastSync<typeof abi>((await store.readCursor(SYNC_CURSOR_KEY)) ?? '');

	const snapshot = createSnapshot<typeof abi>({
		takenAt: {
			number: lastSync.lastToBlock,
			hash: `0xsnap${lastSync.lastToBlock.toString(16)}`,
			timestamp: timestampOf(lastSync.lastToBlock),
		},
		rows: await liveRowsOf(store),
		lastSync,
		processor: canonical.processor,
		savedAt: '2026-09-18T00:00:00.000Z',
	});

	// THROUGH JSON, because that is what a mirror serves and what a client parses.
	// A snapshot that could only travel as an in-process object would be a
	// publishing format in name only.
	return JSON.parse(JSON.stringify(snapshot)) as StateSnapshot;
}

/**
 * The live rows, as the upserts that reproduce them.
 *
 * A publisher needs a ledger of the ids its run touched or a backend's own query
 * surface, because the seam has no "list everything" read and deliberately never
 * will (ADR-0021); this fixture knows its one token and its one counter.
 */
async function liveRowsOf(store: StateStore): Promise<Mutation[]> {
	const rows: Mutation[] = [];
	const nft = await store.getCurrent<{owner: string}>('nft', {tokenID: TOKEN});
	if (nft) rows.push({type: 'upsert', entity: 'nft', id: {tokenID: TOKEN}, values: {owner: nft.owner}});
	const tally = await store.getCurrent<{value: number}>('counter', {name: 'transfers'});
	if (tally) rows.push({type: 'upsert', entity: 'counter', id: {name: 'transfers'}, values: {value: tally.value}});
	return rows;
}

/**
 * A CLIENT RUNNING A BUNDLE: what it folds with, and what it is called.
 *
 * Both come out of the bytes through the loader an arrival uses, so the client
 * is told nothing about the producer. That is what makes the candidate rule
 * below an assertion about two DERIVATIONS agreeing rather than about two
 * constants being spelled the same.
 */
async function theBundleAt(path: string): Promise<{identity: string; processor: EntityProcessor<typeof abi>}> {
	const outcome = await loadProcessorArtifact<typeof abi, unknown, EntityProcessor<typeof abi>>(
		new Uint8Array(readFileSync(path)),
	);
	if (outcome.status !== 'instantiated') throw new Error(`the fixture bundle was refused: ${outcome.why}`);
	return {identity: outcome.identity, processor: outcome.processor};
}

/** An empty client: a second machine, a fresh tab, nothing indexed yet. */
async function aClientStore(app: {processor: EntityProcessor<typeof abi>}): Promise<SnapshotAwareStateStore> {
	return openSnapshotAware(await openForWriting(new VersionedStateStore(oneDatabase(), app.processor.entities)));
}

/** A mirror that serves one snapshot: the whole network a published artifact needs. */
function mirror(snapshot: StateSnapshot) {
	const fetch = (async () => ({json: async () => snapshot}) as Response) as unknown as typeof globalThis.fetch;
	return {url: 'https://mirror.example/state.json', fetch};
}

describe('a snapshot published by a deployment running a bundle', () => {
	it('is labelled with the identity of the bytes that fold, and nothing an author wrote', async () => {
		const snapshot = await aDeploymentPublishing(BUNDLE);

		expect(snapshot.processor).toBe(processorArtifactIdentity(new Uint8Array(readFileSync(BUNDLE))));
	});

	it('IS a candidate for a client running that same bundle, which installs it and resumes there', async () => {
		const snapshot = await aDeploymentPublishing(BUNDLE);
		const app = await theBundleAt(BUNDLE);
		const store = await aClientStore(app);
		const remote = mirror(snapshot);

		const outcome = await bootstrapFromSnapshot(store, remote.url, {processor: app.identity, fetch: remote.fetch});

		expect(outcome).toMatchObject({status: 'bootstrapped', at: snapshot.takenAt.number});
		// the rows the producer's fold computed are this client's state now
		expect(await store.getCurrent('nft', {tokenID: TOKEN})).toMatchObject({owner: BOB.toLowerCase()});
		expect(await store.getCurrent('counter', {name: 'transfers'})).toMatchObject({value: LOGS.length});
		// ...and its history begins where the snapshot does, because it received nothing below that
		expect(store.snapshotOrigin).toBe(snapshot.takenAt.number);
	});

	it('leaves the client asking the chain from the snapshot rather than from the start block', async () => {
		// the capability the whole thing is for: the core asks the fold where it is,
		// and the answer is the block somebody else indexed up to.
		const snapshot = await aDeploymentPublishing(BUNDLE);
		const app = await theBundleAt(BUNDLE);
		const store = await aClientStore(app);
		const remote = mirror(snapshot);
		await bootstrapFromSnapshot(store, remote.url, {processor: app.identity, fetch: remote.fetch});

		// the fold this client runs is the bundle's OWN authoring object, over the store
		// it just bootstrapped: the same artifact that named the generation, folding.
		const client = new EntityEventProcessor(await openForWriting(store), app.processor);
		const loaded = await client.load(SOURCE, {finality: FINALITY});

		expect(loaded?.lastSync.lastToBlock).toBe(snapshot.takenAt.number);
		expect(await localPosition(store)).toBeGreaterThan(START_BLOCK);
	});
});

describe('a snapshot computed by ANOTHER fold', () => {
	it('is not a candidate for a client running a different bundle, and nothing is installed', async () => {
		// the pair differ in ONE HANDLER LINE and in nothing an author declares, so a
		// declared identity could not have told them apart: this is the silent
		// wrong-state condition ADR-0086 deletes, arriving at the one client that
		// could never recover from it.
		const snapshot = await aDeploymentPublishing(BUNDLE);
		const other = await theBundleAt(EDITED_BUNDLE);
		const store = await aClientStore(other);
		const remote = mirror(snapshot);

		const outcome = await bootstrapFromSnapshot(store, remote.url, {processor: other.identity, fetch: remote.fetch});

		expect(outcome).toEqual({status: 'not-bootstrapped', reason: 'processor-mismatch'});
		expect(store.snapshotOrigin).toBeUndefined();
		expect(await store.getCurrent('nft', {tokenID: TOKEN})).toBeUndefined();
		expect(await localPosition(store)).toBeUndefined();
	});

	it('is REFUSED rather than translated when a host installs it anyway, naming both folds', async () => {
		const snapshot = await aDeploymentPublishing(BUNDLE);
		const other = await theBundleAt(EDITED_BUNDLE);
		const store = await aClientStore(other);

		const refusal = await store.bootstrap(snapshot, {processor: other.identity}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(SnapshotProcessorMismatchError);
		expect((refusal as SnapshotProcessorMismatchError).found).toBe(snapshot.processor);
		expect((refusal as SnapshotProcessorMismatchError).expected).toBe(other.identity);
		expect(await store.getCurrent('nft', {tokenID: TOKEN})).toBeUndefined();
	});

	it('differs from it only in the BYTES, which is why the label had to move', async () => {
		const app = await theBundleAt(BUNDLE);
		const other = await theBundleAt(EDITED_BUNDLE);

		expect(other.identity).not.toBe(app.identity);
		// nothing DECLARED differs: the same entities, and no version field left to bump
		expect(other.processor.entities).toEqual(app.processor.entities);
	});
});
