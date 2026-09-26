import {generationDigestOf} from '@etherfold/core';
import {GENERATION_TABLE, MAX_UPLOAD_BYTES, UPLOAD_CONTENT_TYPE} from '@etherfold/server';
import {processorArtifactIdentity} from '@etherfold/utils';
import {createClient} from '@libsql/client';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {node, run, type RunDependencies, type RunningIndexer} from '../src/index.js';
import type {Options} from '../src/types.js';
import {ALICE, BOB, fakeChain, START_BLOCK, transfer, ZERO} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// A BUNDLE IS UPLOADED TO A RUNNING NODE, AND IS INDEXED BESIDE THE LIVE VERSION BEFORE IT SWITCHES
// ---------------------------------------------------------------------------------------------------
// The Graph's deploy experience on a Node deployment (ADR-0085's amendment of
// 2026-09-22): the BYTES of an already-built bundle go to a running `etherfold node`
// over its admin credential, and the node registers the generation they name as
// `successor` beside the incumbent. From there it is existing machinery: the incumbent
// answers every read, the successor catches up, and `on-catch-up` moves the pointer.
//
// It was asserted against a `run` started with `-p`; the route MOVED to `node` with
// ADR-0094, and so did this suite, assertions and all: the incumbent is now the node's
// FIRST upload rather than its configured processor. A configured `run` serves no
// upload route, which is asserted at the end.
//
// Asserted END TO END, against a real `node`, with the committed REAL bundles
// (`fixtures/processor-bundle/`) for everything that must evaluate:
//
//  - `nfts.bundle.js` is the node's first upload, its incumbent;
//  - `nfts-edited.bundle.js` is the same contracts with one handler line changed;
//  - `nfts-with-approval.bundle.js` carries DIFFERENT contracts (an added event);
//  - `not-self-contained.bundle.js` and `throws-on-evaluation.bundle.js` are the two
//    small hand-written refusals.
//
// The claim every refusal case makes is the one that separates REFUSING BEFORE
// REGISTERING from unwinding afterwards: the registry, the slots and the folds this
// process holds are EXACTLY as they were, read back through the operator's listing
// and the container, not inferred from a status code.
// ---------------------------------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL('./fixtures/processor-bundle/', import.meta.url));
const BUNDLE = join(FIXTURES, 'nfts.bundle.js');
const EDITED_BUNDLE = join(FIXTURES, 'nfts-edited.bundle.js');
const APPROVAL_BUNDLE = join(FIXTURES, 'nfts-with-approval.bundle.js');
const NOT_SELF_CONTAINED = join(FIXTURES, 'not-self-contained.bundle.js');
const THROWS_ON_EVALUATION = join(FIXTURES, 'throws-on-evaluation.bundle.js');

const INDEXER = 'nfts';
const INGEST_TOKEN = 'a-shared-secret';
const ADMIN_TOKEN = 'the-operators-own-secret';

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
];
const TIP = START_BLOCK + 50;

let running: RunningIndexer | undefined;

afterEach(async () => {
	await running?.stop().catch(() => undefined);
	running = undefined;
	delete process.env.ADMIN_TOKEN;
	delete process.env.INGEST_TOKEN;
});

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

function optionsFor(processor: string): Options {
	return {
		processor,
		nodeUrl: 'http://localhost:0',
		store: 'sqlite',
		db: ':memory:',
		port: '0',
		indexer: INDEXER,
	};
}

/** A `node`: the chain, the store, the database; no processor and no source (ADR-0094). */
const NODE: Options = {nodeUrl: 'http://localhost:0', store: 'sqlite', db: ':memory:', port: '0', indexer: INDEXER};

/** The drive loop's default wait in this suite: a millisecond, so a case runs fast. */
const aMoment: NonNullable<RunDependencies['sleep']> = async () => {
	await new Promise((resolve) => setTimeout(resolve, 1));
};

/** START a `node` over `db`, which may already hold generations (a restart, when it does). */
async function aNodeOver(
	db: RemoteSQL,
	chain: ReturnType<typeof fakeChain>,
	env: Record<string, string> = {},
	sleep: RunDependencies['sleep'] = aMoment,
	options: Partial<Options> = {},
): Promise<RunningIndexer> {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	running = await node(
		{...NODE, ...options},
		{
			provider: chain.provider,
			createDB: () => db,
			sleep,
			handleSignals: false,
			log: () => {},
			env: {MAX_BLOCKS_PER_FETCH: '20', ...env},
		},
	);
	return running;
}

/** START a configured `run` over `db`: the route it does not serve. */
async function aRunOver(
	db: RemoteSQL,
	processorPath: string,
	chain: ReturnType<typeof fakeChain>,
	env: Record<string, string> = {},
	sleep: RunDependencies['sleep'] = aMoment,
): Promise<RunningIndexer> {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	running = await run(optionsFor(processorPath), {
		provider: chain.provider,
		createDB: () => db,
		sleep,
		handleSignals: false,
		log: () => {},
		env: {MAX_BLOCKS_PER_FETCH: '20', ...env},
	});
	return running;
}

async function stop(): Promise<void> {
	await running?.stop().catch(() => undefined);
	running = undefined;
}

/** A node whose first upload, `nfts.bundle.js`, has folded `LOGS` and is answering reads. */
async function aNodeServing(
	env: Record<string, string> = {},
	sleep?: RunDependencies['sleep'],
): Promise<{indexer: RunningIndexer; db: RemoteSQL}> {
	const db = oneDatabase();
	const indexer = await aNodeOver(db, fakeChain().serve(LOGS, TIP), env, sleep);
	const first = await upload(indexer, await bytesOf(BUNDLE));
	expect(first.status, JSON.stringify(first.body)).toBe(200);
	await feedOf(indexer, LOGS.length);
	return {indexer, db};
}

/**
 * A HOST CLOCK a case can PARK: while parked, this host runs no further cycle and so
 * no bounded rebuild, which is how "the successor sits beside the incumbent" is read
 * before `on-catch-up` has had the chance to promote it on a two-log stream.
 */
function aParkableClock() {
	let parked: Promise<void> | undefined;
	let wake: (() => void) | undefined;
	const sleep: RunDependencies['sleep'] = async (_ms, signal) => {
		await new Promise((resolve) => setTimeout(resolve, 1));
		if (parked) {
			await Promise.race([
				parked,
				new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), {once: true})),
			]);
		}
	};
	return {
		sleep,
		park() {
			parked = new Promise<void>((resolve) => {
				wake = resolve;
			});
		},
		release() {
			parked = undefined;
			wake?.();
		},
	};
}

/**
 * READ THE FEED, refusing anything but a served answer, so "the incumbent answered
 * reads throughout" is an assertion made on every poll rather than a hope.
 */
async function feedOf(indexer: RunningIndexer, expectedEntries?: number): Promise<{generation: string}> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const res = await fetch(`${indexer.url}/${INDEXER}/feed`);
		const body = (await res.json()) as {generation: string; entries: unknown[]};
		expect(res.status, JSON.stringify(body)).toBe(200);
		if (expectedEntries === undefined || body.entries.length === expectedEntries) return body;
		if (Date.now() > deadline) throw new Error(`the feed never served ${expectedEntries} entries`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

type Uploaded = {
	status: number;
	body: {
		success?: boolean;
		arrival?: string;
		outcome?: string;
		error?: string;
		message?: string;
		generation?: {stream: string; processor: string; digest: string};
	};
};

/** WHAT A SENDER DOES: the bundle's raw bytes, on the admin credential. */
async function upload(
	indexer: RunningIndexer,
	bytes: Uint8Array,
	options: {token?: string | undefined; contentType?: string; headers?: Record<string, string>} = {},
): Promise<Uploaded> {
	const token = 'token' in options ? options.token : ADMIN_TOKEN;
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/upload`, {
		method: 'POST',
		headers: {
			'Content-Type': options.contentType ?? UPLOAD_CONTENT_TYPE,
			...(token === undefined ? {} : {Authorization: `Bearer ${token}`}),
			...options.headers,
		},
		// copied into an ArrayBuffer-backed view, which is what `BodyInit` takes
		body: new Uint8Array(bytes),
	});
	return {status: res.status, body: (await res.json()) as Uploaded['body']};
}

type Listing = {
	canonical?: {digest: string};
	slots?: Record<string, {digest: string}>;
	generations: {
		digest: string;
		stream: string;
		processor: string;
		canonical: boolean;
		slot?: string;
		folding?: string;
	}[];
};

async function listingOf(indexer: RunningIndexer): Promise<Listing> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
	});
	expect(res.status).toBe(200);
	return (await res.json()) as Listing;
}

async function canonicalOf(indexer: RunningIndexer): Promise<string | undefined> {
	return (await listingOf(indexer)).generations.find((entry) => entry.canonical)?.digest;
}

/**
 * EVERYTHING A REFUSAL MUST LEAVE AS IT WAS: the registry and the slots, as the
 * operator's listing reports them, and the folds this process holds.
 */
async function everythingHeld(indexer: RunningIndexer) {
	const listing = await listingOf(indexer);
	return {
		generations: listing.generations
			.map(({digest, canonical, slot, folding}) => ({digest, canonical, slot, folding}))
			.sort((a, b) => (a.digest < b.digest ? -1 : 1)),
		slots: listing.slots,
		held: indexer.container.held().map((fold) => generationDigestOf(fold.record)),
	};
}

/** The bytes the registry row of `processor` KEEPS (ADR-0092). */
async function storedBundleOf(db: RemoteSQL, processor: string): Promise<Uint8Array | undefined> {
	const rows = await db
		.prepare(`SELECT bundle FROM ${GENERATION_TABLE} WHERE indexer = ?1 AND processor = ?2`)
		.bind(INDEXER, processor)
		.all<{bundle: ArrayBuffer | null}>();
	const bundle = rows.results[0]?.bundle;
	return bundle ? new Uint8Array(bundle) : undefined;
}

async function waitFor(what: string, done: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		if (await done()) return;
		if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const bytesOf = async (path: string): Promise<Uint8Array> => new Uint8Array(await readFile(path));

// ---------------------------------------------------------------------------------------------------

describe('the round trip: an uploaded bundle is indexed beside the incumbent, then promoted', () => {
	it('registers the upload as `successor`, keeps the incumbent answering, and moves the pointer once it caught up', async () => {
		const clock = aParkableClock();
		const {indexer, db} = await aNodeServing({}, clock.sleep);
		const incumbent = generationDigestOf(indexer.container.generation);
		const edited = await bytesOf(EDITED_BUNDLE);
		clock.park();

		// ...with a CLAIM about identity riding along, in every place a sender could put
		// one: none of it is read, because the identity is the receiver's hash of the bytes
		const answer = await upload(indexer, edited, {
			headers: {'X-Etherfold-Processor': 'sha256:0000', 'X-Etherfold-Identity': 'v999'},
		});

		expect(answer.status, JSON.stringify(answer.body)).toBe(200);
		expect(answer.body).toMatchObject({success: true, arrival: 'upload', outcome: 'registered'});
		const successor = answer.body.generation as {stream: string; processor: string; digest: string};
		expect(successor.processor).toBe(processorArtifactIdentity(edited));
		// the same contracts, so the same stream: the successor follows what the incumbent fetches
		expect(successor.stream).toBe(indexer.container.generation.stream);

		// BESIDE, in the `successor` slot, with the incumbent still canonical: read while
		// this host's clock is PARKED, so no rebuild can have promoted it yet
		const listing = await listingOf(indexer);
		expect(listing.generations.map((entry) => entry.digest).sort()).toEqual([incumbent, successor.digest].sort());
		expect(listing.slots?.successor?.digest).toBe(successor.digest);
		expect(listing.slots?.canonical?.digest).toBe(incumbent);
		expect(indexer.container.held().map((fold) => generationDigestOf(fold.record))).toContain(successor.digest);
		clock.release();

		// the generation's row KEEPS the bytes that were uploaded, through the one
		// registration path every Node generation takes (ADR-0092)
		expect([...((await storedBundleOf(db, successor.processor)) ?? [])]).toEqual([...edited]);

		// ...and under `on-catch-up` the pointer moves once the successor has caught up,
		// with every poll on the way a served read
		const deadline = Date.now() + 10_000;
		for (;;) {
			const feed = await feedOf(indexer, LOGS.length);
			if (feed.generation === successor.digest) break;
			expect(feed.generation).toBe(incumbent);
			if (Date.now() > deadline) throw new Error('the node never moved onto the uploaded processor');
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(await canonicalOf(indexer)).toBe(successor.digest);
	});

	it('answers `unchanged` for the bytes the node already folds, and registers nothing', async () => {
		const {indexer} = await aNodeServing();
		const before = await everythingHeld(indexer);

		const answer = await upload(indexer, await bytesOf(BUNDLE));

		expect(answer.status, JSON.stringify(answer.body)).toBe(200);
		expect(answer.body).toMatchObject({success: true, arrival: 'upload', outcome: 'unchanged'});
		expect(answer.body.generation?.digest).toBe(generationDigestOf(indexer.container.generation));
		expect(answer.body.message).toMatch(/already folding/);
		expect(await everythingHeld(indexer)).toEqual(before);
	});
});

describe('every refusal answers its own status and reason, and leaves the node EXACTLY as it was', () => {
	it('refuses a missing or wrong credential with the admin `401`', async () => {
		process.env.INGEST_TOKEN = INGEST_TOKEN;
		const {indexer} = await aNodeServing();
		const before = await everythingHeld(indexer);
		const edited = await bytesOf(EDITED_BUNDLE);

		const anonymous = await upload(indexer, edited, {token: undefined});
		expect(anonymous.status).toBe(401);
		expect(anonymous.body.error).toBe('unauthorized');
		expect((await upload(indexer, edited, {token: 'not-the-token'})).status).toBe(401);
		// the credential a log shipper holds does not get to start a fold either
		expect((await upload(indexer, edited, {token: INGEST_TOKEN})).status).toBe(401);

		expect(await everythingHeld(indexer)).toEqual(before);
	});

	it('refuses a body over the bound with `413`', async () => {
		const {indexer} = await aNodeServing();
		const before = await everythingHeld(indexer);

		const refused = await upload(indexer, new Uint8Array(MAX_UPLOAD_BYTES + 1));

		expect(refused.status, JSON.stringify(refused.body)).toBe(413);
		expect(refused.body).toMatchObject({error: 'upload-too-large', arrival: 'upload', outcome: 'failed'});
		expect(await everythingHeld(indexer)).toEqual(before);
	});

	it('refuses a wrong content type with `415`', async () => {
		const {indexer} = await aNodeServing();
		const before = await everythingHeld(indexer);

		const refused = await upload(indexer, await bytesOf(EDITED_BUNDLE), {contentType: 'application/octet-stream'});

		expect(refused.status, JSON.stringify(refused.body)).toBe(415);
		expect(refused.body).toMatchObject({error: 'upload-wrong-content-type', arrival: 'upload', outcome: 'failed'});
		expect(await everythingHeld(indexer)).toEqual(before);
	});

	it('refuses a bundle that is not self-contained with `409`, naming what it still imports', async () => {
		const {indexer} = await aNodeServing();
		const before = await everythingHeld(indexer);

		const refused = await upload(indexer, await bytesOf(NOT_SELF_CONTAINED));

		expect(refused.status, JSON.stringify(refused.body)).toBe(409);
		expect(refused.body).toMatchObject({error: 'upload-failed', arrival: 'upload', outcome: 'failed'});
		expect(refused.body.message).toContain('not-self-contained');
		expect(refused.body.message).toContain('"viem"');
		expect(await everythingHeld(indexer)).toEqual(before);
	});

	it('refuses a bundle that throws on evaluation with `409`, carrying its own error, and registers NOTHING partial', async () => {
		const {indexer, db} = await aNodeServing();
		const before = await everythingHeld(indexer);
		const incumbent = generationDigestOf(indexer.container.generation);
		const throwing = await bytesOf(THROWS_ON_EVALUATION);

		const refused = await upload(indexer, throwing);

		expect(refused.status, JSON.stringify(refused.body)).toBe(409);
		expect(refused.body).toMatchObject({error: 'upload-failed', arrival: 'upload', outcome: 'failed'});
		expect(refused.body.message).toContain('this bundle throws while it is evaluated');
		// nothing partial: not a generation, not a slot, not a fold, not a stored row
		expect(await everythingHeld(indexer)).toEqual(before);
		expect(await storedBundleOf(db, processorArtifactIdentity(throwing))).toBeUndefined();
		// ...and the node goes on answering from what it held
		expect((await feedOf(indexer, LOGS.length)).generation).toBe(incumbent);

		// the next upload on the same running node is served as usual
		const repaired = await upload(indexer, await bytesOf(EDITED_BUNDLE));
		expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
		expect(repaired.body.outcome).toBe('registered');
	});
});

describe('a node takes an upload carrying NEW contracts', () => {
	it('registers it as a successor on its new stream, rather than refusing it', async () => {
		// PARKED, so the registration is read before the new stream is fetched and the
		// successor promoted: that it then catches up and takes over is
		// `aSuccessorOnANewStreamIsFetchedByItsOwnWriter.test.ts`
		const clock = aParkableClock();
		const {indexer} = await aNodeServing({}, clock.sleep);
		const incumbent = indexer.container.generation;
		const approval = await bytesOf(APPROVAL_BUNDLE);
		clock.park();

		const answer = await upload(indexer, approval);

		expect(answer.status, JSON.stringify(answer.body)).toBe(200);
		expect(answer.body).toMatchObject({success: true, arrival: 'upload', outcome: 'registered'});
		// a NEW STREAM: the added event is a new `topic0` in the fetch filter, exactly as a
		// restart after a filter change registers one
		expect(answer.body.generation?.stream).not.toBe(incumbent.stream);
		expect(answer.body.generation?.processor).toBe(processorArtifactIdentity(approval));
		const listing = await listingOf(indexer);
		expect(listing.generations.map((entry) => entry.digest).sort()).toEqual(
			[generationDigestOf(incumbent), answer.body.generation?.digest as string].sort(),
		);
		// the incumbent still answers
		expect((await feedOf(indexer, LOGS.length)).generation).toBe(generationDigestOf(incumbent));
		clock.release();
	});
});

// ---------------------------------------------------------------------------------------------------
// BYTES NAMING A GENERATION THAT IS REGISTERED BUT NOT HELD
// ---------------------------------------------------------------------------------------------------
// A rollback by upload: the node was upgraded onto the edited bundle, the successor was
// promoted, and the generation it superseded is now `predecessor` -- registered, its
// bytes on its row, and folded by nothing in this process. Two uploads and a promotion
// make it (and a restart, so that nothing in the process folds it).
//
// It used to pin that the upload left the generation in `predecessor` while this process
// started FOLDING it: a rollback that did not roll back, and an engine for a generation
// nobody reads. ADR-0094 (the maintainer's decision of 2026-09-26) RE-ARMS it instead:
// it MOVES into `successor`, and the ordinary promotion takes it from there.
// ---------------------------------------------------------------------------------------------------

/**
 * A `node` upgraded by UPLOAD onto the edited bundle, holding `nfts.bundle.js`'s
 * generation as an unheld predecessor: two uploads and a promotion, then a restart, so
 * that nothing in the process folds it.
 */
async function aNodeWithAnUnheldPredecessor(
	restartedWith: Partial<Options> = {},
): Promise<{indexer: RunningIndexer; predecessor: string}> {
	const db = oneDatabase();
	const first = await aNodeOver(db, fakeChain().serve(LOGS, TIP));
	expect((await upload(first, await bytesOf(BUNDLE))).status).toBe(200);
	await feedOf(first, LOGS.length);
	const predecessor = generationDigestOf(first.container.generation);
	await waitFor('the first upload folded to the tip', async () => {
		return (await first.container.registry.readStateCursor(first.container.generation)) === TIP;
	});
	expect((await upload(first, await bytesOf(EDITED_BUNDLE))).status).toBe(200);
	await waitFor(
		'the edited successor was promoted',
		async () => (await canonicalOf(first)) !== undefined && (await canonicalOf(first)) !== predecessor,
	);
	await stop();

	const indexer = await aNodeOver(db, fakeChain().serve(LOGS, TIP), {}, aMoment, restartedWith);
	const listing = await listingOf(indexer);
	expect(listing.slots?.predecessor?.digest).toBe(predecessor);
	// the precondition: nothing in this process folds it
	expect(indexer.container.held().map((fold) => generationDigestOf(fold.record))).not.toContain(predecessor);
	return {indexer, predecessor};
}

describe('uploading the bytes of the `predecessor`', () => {
	it('RE-ARMS it as successor, and the ordinary promotion rolls the node back onto it', async () => {
		const original = await bytesOf(BUNDLE);

		// THE UPLOAD: the predecessor's own bytes, sent, to a `node` holding it unheld
		const byUpload = await aNodeWithAnUnheldPredecessor();
		const rolledBackFrom = await canonicalOf(byUpload.indexer);
		const uploaded = await upload(byUpload.indexer, original);
		const settledUpload = await settled(byUpload.indexer);

		expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
		expect(uploaded.body.generation?.digest).toBe(byUpload.predecessor);
		expect(uploaded.body.arrival).toBe('upload');
		expect(uploaded.body.outcome).toBe('registered');
		// it MOVED into `successor` (never named by two slots), was already level with the
		// canonical generation (the same stream, folded to the tip before), and `on-catch-up`
		// promoted it: the generation it replaced is what `predecessor` names now
		expect(settledUpload.slots?.canonical?.digest).toBe(byUpload.predecessor);
		expect(settledUpload.slots?.predecessor?.digest).toBe(rolledBackFrom);
		expect(settledUpload.slots?.successor).toBeUndefined();
		expect(settledUpload.generations).toHaveLength(2);
		expect((await feedOf(byUpload.indexer, LOGS.length)).generation).toBe(byUpload.predecessor);
		// ...and NO ENGINE runs for the generation `predecessor` names
		expect(settledUpload.held).toEqual([byUpload.predecessor]);
		expect(settledUpload.generations.find((entry) => entry.digest === rolledBackFrom)).toMatchObject({
			canonical: false,
			slot: 'predecessor',
			folding: 'instantiable',
		});
	});

	it('re-arms it where this process still FOLDS it, building no second fold', async () => {
		// the same process that promoted over it: a same-stream promotion keeps the
		// superseded fold it built, so the predecessor is still HELD here
		const {indexer} = await aNodeServing();
		const predecessor = generationDigestOf(indexer.container.generation);
		await waitFor('the first upload folded to the tip', async () => {
			return (await indexer.container.registry.readStateCursor(indexer.container.generation)) === TIP;
		});
		expect((await upload(indexer, await bytesOf(EDITED_BUNDLE))).status).toBe(200);
		await waitFor(
			'the edited successor was promoted',
			async () => (await canonicalOf(indexer)) !== undefined && (await canonicalOf(indexer)) !== predecessor,
		);
		const edited = (await canonicalOf(indexer)) as string;
		expect((await listingOf(indexer)).slots?.predecessor?.digest).toBe(predecessor);

		const uploaded = await upload(indexer, await bytesOf(BUNDLE));
		const after = await settled(indexer);

		// `registered`, and NOT `unchanged`: being folded here is not being where it was asked to go
		expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
		expect(uploaded.body).toMatchObject({outcome: 'registered', generation: {digest: predecessor}});
		expect(after.slots?.canonical?.digest).toBe(predecessor);
		expect(after.slots?.predecessor?.digest).toBe(edited);
		// ONE fold for it, never two over the same state
		expect(after.held.filter((digest) => digest === predecessor)).toHaveLength(1);
	});

	it('waits in `successor` under `manual`, folded, and is promoted only when asked', async () => {
		const {indexer, predecessor} = await aNodeWithAnUnheldPredecessor({promotion: 'manual'});
		const rolledBackFrom = (await canonicalOf(indexer)) as string;

		const uploaded = await upload(indexer, await bytesOf(BUNDLE));
		const after = await settled(indexer);

		expect(uploaded.body.outcome).toBe('registered');
		expect(after.slots?.canonical?.digest).toBe(rolledBackFrom);
		expect(after.slots?.successor?.digest).toBe(predecessor);
		expect(after.slots?.predecessor).toBeUndefined();
		expect(after.held).toContain(predecessor);

		// `manual` means only when ASKED
		const target = (await listingOf(indexer)).generations.find((entry) => entry.digest === predecessor)!;
		const moved = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json'},
			body: JSON.stringify({stream: target.stream, processor: target.processor}),
		});
		expect(moved.status).toBe(200);
		const promoted = await settled(indexer);
		expect(promoted.slots?.canonical?.digest).toBe(predecessor);
		expect(promoted.slots?.predecessor?.digest).toBe(rolledBackFrom);
		expect(promoted.held).toEqual([predecessor]);
	});
});

/**
 * What a deployment holds once it has stopped changing: the same read twice, a
 * little apart, so a promotion the arrival set off has had its chance to land.
 */
async function settled(indexer: RunningIndexer): Promise<Awaited<ReturnType<typeof everythingHeld>>> {
	let previous = await everythingHeld(indexer);
	for (let quiet = 0; quiet < 10; ) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		const now = await everythingHeld(indexer);
		quiet = JSON.stringify(now) === JSON.stringify(previous) ? quiet + 1 : 0;
		previous = now;
	}
	return previous;
}

// ---------------------------------------------------------------------------------------------------
// A CONFIGURED `run` RECEIVES NO CODE (ADR-0094)
// ---------------------------------------------------------------------------------------------------

describe('a configured `run` does not serve the upload route', () => {
	it('answers `501 upload-not-held`, naming `etherfold node`, and registers nothing', async () => {
		const db = oneDatabase();
		const indexer = await aRunOver(db, BUNDLE, fakeChain().serve(LOGS, TIP));
		await feedOf(indexer, LOGS.length);
		const before = await everythingHeld(indexer);

		const refused = await upload(indexer, await bytesOf(EDITED_BUNDLE));

		expect(refused.status, JSON.stringify(refused.body)).toBe(501);
		expect(refused.body.error).toBe('upload-not-held');
		expect(refused.body.message).toContain('etherfold node');
		expect(await everythingHeld(indexer)).toEqual(before);
		expect(await storedBundleOf(db, processorArtifactIdentity(await bytesOf(EDITED_BUNDLE)))).toBeUndefined();
	});

	it('serves no re-read route either: `POST /{indexer}/admin/reconfigure` does not exist, and nothing changes', async () => {
		const db = oneDatabase();
		const indexer = await aRunOver(db, BUNDLE, fakeChain().serve(LOGS, TIP));
		await feedOf(indexer, LOGS.length);
		const before = await everythingHeld(indexer);

		const res = await fetch(`${indexer.url}/${INDEXER}/admin/reconfigure`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
		});

		// a `run` changes its code by RESTARTING with a different `-p` (ADR-0094)
		expect(res.status).toBe(404);
		expect(await everythingHeld(indexer)).toEqual(before);
	});
});
