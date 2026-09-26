import {createClient} from '@libsql/client';
import {
	generationDigestOf,
	openReceivingIndexer,
	serializeWireBatch,
	type GenerationId,
	type LogEvent,
	type ReceivingIndexer,
	type WireBatch,
} from '@etherfold/core';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {beforeEach, describe, expect, it} from 'vitest';
import {
	applySchema,
	createServer,
	emissionAppenderFor,
	generationRegistryPortOnSQL,
	indexerEntryOn,
	MAX_UPLOAD_BYTES,
	streamCursorSourceOn,
	storedEmissionReplaySource,
	UPLOAD_CONTENT_TYPE,
	type IndexerRegistryEntry,
	type ReconfigureReport,
} from '../src/index.js';
import {ALICE, CONTRACT, SOURCE, STREAM_CONFIG, TOKEN, transfer, type TestABI} from './utils/feedHarness.js';
import {bundleBytes, bundleOf, identityOf, identityOfBytes} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------------------------------
// THE UPLOAD ROUTE: A BUNDLE'S BYTES REACH A RUNNING DEPLOYMENT
// ---------------------------------------------------------------------------------------------------
// `POST /{indexer}/admin/upload` is the RECEIVING half of ADR-0085's upload: bytes
// in, and the three-outcome report out with `arrival: 'upload'`. What is asserted
// HERE is the ROUTE: the transport's own refusals (the credential, the capability,
// the content type, the size bound), that each of them is made before the host is
// reached and so registers nothing, that the host is handed EXACTLY the bytes that
// were sent, and the status each outcome answers with.
//
// What the host DOES with the bytes (load, check, match, register) is `etherfold
// run`'s, asserted end to end against a real running node in
// `packages/cli/test/aBundleIsUploadedToARunningNode.test.ts`. The host here is a
// stand-in over a REAL container that does the one thing the route cares about: it
// names the generation by the hash of the bytes it was handed and registers it
// through the container, so "registered nothing" is a read of the registry.
// ---------------------------------------------------------------------------------------------------

const NAME = 'alpha';
const ADMIN_TOKEN = 'an-operator-secret';

type TestEnv = {DEV?: string; INGEST_TOKEN?: string; ADMIN_TOKEN?: string};

const entityProcessor: EntityProcessor<TestABI> = {
	entities: [{name: 'token', id: ['id'], fields: {owner: 'text'}}],
	async onTransfer(state, event) {
		const args = event.args as {from: string; to: string; id: bigint};
		state.set('token', {id: args.id.toString()}, {owner: args.to});
	},
};

function freshDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/** A fold named by the hash of `bytes`, carrying them to the registration (ADR-0086, ADR-0092). */
function foldOver(bytes: Uint8Array) {
	return {
		createState: () => freshDatabase(),
		createProcessor: (state: RemoteSQL) => new VersionedStateEventProcessor<TestABI>(state, entityProcessor),
		processorIdentity: identityOfBytes(bytes),
		bundle: bytes,
	};
}

type Deployment = {
	app: ReturnType<typeof createServer<TestEnv>>;
	db: RemoteSQL;
	indexer: ReceivingIndexer<TestABI, unknown, RemoteSQL>;
	incumbent: GenerationId;
	/** Every body the route handed the host, in order. */
	received: Uint8Array[];
	/** Replace what the host answers, for a case that needs a particular outcome. */
	answer(outcome: (bundle: Uint8Array) => Promise<ReconfigureReport>): void;
};

async function aRunningDeployment(): Promise<Deployment> {
	const db = freshDatabase();
	await applySchema(db);
	const running = identityOf('the-running-fold');
	const indexer = (await openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, NAME),
		source: SOURCE,
		stream: STREAM_CONFIG,
		appendEmissions: emissionAppenderFor(db, NAME),
		streamCursor: streamCursorSourceOn(db, NAME),
		replay: storedEmissionReplaySource(db, NAME),
		generation: foldOver(bundleOf(running)),
	})) as ReceivingIndexer<TestABI, unknown, RemoteSQL>;

	const received: Uint8Array[] = [];
	// THE STAND-IN HOST: the identity is the hash of what it was HANDED, and the
	// registration is the container's.
	let host = async (bundle: Uint8Array): Promise<ReconfigureReport> => {
		const wanted = {stream: indexer.generation.stream, processor: identityOfBytes(bundle)};
		if (indexer.held().some((fold) => fold.record.processor === wanted.processor)) {
			return {arrival: 'upload', outcome: 'unchanged', generation: wanted, message: 'already folded here'};
		}
		const fold = await indexer.add(foldOver(bundle));
		return {arrival: 'upload', outcome: 'registered', generation: fold.record};
	};
	const app = createServer<TestEnv>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN, ADMIN_TOKEN}),
		getIndexer: (_c, name) =>
			name === NAME
				? {
						...indexerEntryOn(db, indexer),
						upload: (bundle) => {
							received.push(bundle);
							return host(bundle);
						},
					}
				: undefined,
	});

	const fromBlock = await indexer.ingestion.expectedFromBlock();
	const batch: WireBatch<TestABI> = {
		context: indexer.ingestion.context,
		fromBlock,
		toBlock: 105,
		latestBlock: 105,
		logs: [transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT) as LogEvent<TestABI>],
	};
	const pushed = await app.request(`/${NAME}/ingest`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
		body: serializeWireBatch(batch),
	});
	expect(pushed.status, await pushed.clone().text()).toBe(200);

	return {
		app,
		db,
		indexer,
		incumbent: indexer.generation,
		received,
		answer: (outcome) => {
			host = outcome;
		},
	};
}

async function upload(
	deployment: Deployment,
	bytes: Uint8Array,
	options: {token?: string | undefined; name?: string; contentType?: string | undefined; headers?: HeadersInit} = {},
): Promise<{status: number; body: Record<string, unknown>}> {
	const token = 'token' in options ? options.token : ADMIN_TOKEN;
	const contentType = 'contentType' in options ? options.contentType : UPLOAD_CONTENT_TYPE;
	const headers = new Headers(options.headers);
	if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
	if (contentType !== undefined) headers.set('Content-Type', contentType);
	const res = await deployment.app.request(`/${options.name ?? NAME}/admin/upload`, {
		method: 'POST',
		headers,
		// copied into an ArrayBuffer-backed view, which is what `BodyInit` takes
		body: new Uint8Array(bytes),
	});
	return {status: res.status, body: (await res.json()) as Record<string, unknown>};
}

/** Every generation registered under this name, plus the slots and what this process folds. */
async function everythingHeld(deployment: Deployment) {
	return {
		registered: (await deployment.indexer.generations()).map((record) => generationDigestOf(record)).sort(),
		slots: await deployment.indexer.slots(),
		held: deployment.indexer.held().map((fold) => generationDigestOf(fold.record)),
		canonical: await deployment.indexer.canonical(),
	};
}

let deployment: Deployment;

beforeEach(async () => {
	deployment = await aRunningDeployment();
});

describe('the upload answers the shared three outcomes, naming the upload as their arrival', () => {
	it('REGISTERS the generation the bytes name, beside the incumbent, and names it', async () => {
		const bytes = bundleBytes('the-uploaded-fold');

		const answer = await upload(deployment, bytes);

		expect(answer.status, JSON.stringify(answer.body)).toBe(200);
		const expected: GenerationId = {stream: deployment.incumbent.stream, processor: identityOfBytes(bytes)};
		expect(answer.body).toMatchObject({
			success: true,
			indexer: NAME,
			arrival: 'upload',
			outcome: 'registered',
			generation: {...expected, digest: generationDigestOf(expected)},
		});
		// the host was handed EXACTLY the octets that were sent, nothing decoded or re-encoded
		expect(deployment.received).toHaveLength(1);
		expect([...(deployment.received[0] as Uint8Array)]).toEqual([...bytes]);
		expect((await everythingHeld(deployment)).registered).toEqual(
			[generationDigestOf(deployment.incumbent), generationDigestOf(expected)].sort(),
		);
	});

	it('answers `unchanged` for bytes this deployment already folds, and registers nothing', async () => {
		const before = await everythingHeld(deployment);

		const answer = await upload(deployment, bundleOf(deployment.incumbent.processor));

		expect(answer.status, JSON.stringify(answer.body)).toBe(200);
		expect(answer.body).toMatchObject({
			success: true,
			arrival: 'upload',
			outcome: 'unchanged',
			generation: {digest: generationDigestOf(deployment.incumbent)},
		});
		expect(typeof answer.body.message).toBe('string');
		expect(await everythingHeld(deployment)).toEqual(before);
	});

	it('REFUSES with `409 upload-failed` when the host could not complete it, naming the arrival', async () => {
		deployment.answer(async () => ({
			arrival: 'upload',
			outcome: 'failed',
			message: 'the artifact still imports "viem"',
		}));

		const answer = await upload(deployment, bundleBytes('a-bundle-the-host-refuses'));

		expect(answer.status).toBe(409);
		expect(answer.body).toMatchObject({
			success: false,
			error: 'upload-failed',
			indexer: NAME,
			arrival: 'upload',
			outcome: 'failed',
		});
		expect(answer.body.message).toContain('viem');
		expect(answer.body.generation).toBeUndefined();
	});

	it('reports a host that THREW as the same failure, still the upload\u2019s', async () => {
		deployment.answer(async () => {
			throw new Error('the loader exploded');
		});

		const answer = await upload(deployment, bundleBytes('anything'));

		expect(answer.status).toBe(409);
		expect(answer.body).toMatchObject({success: false, error: 'upload-failed', arrival: 'upload'});
		expect(answer.body.message).toContain('the loader exploded');
	});
});

describe('the transport refuses before the host is reached, and so registers nothing', () => {
	it('refuses a caller with no token, and one presenting the INGEST token, with the admin `401`', async () => {
		const before = await everythingHeld(deployment);

		const anonymous = await upload(deployment, bundleBytes('x'), {token: undefined});
		expect(anonymous.status).toBe(401);
		expect(anonymous.body).toMatchObject({error: 'unauthorized'});
		expect((await upload(deployment, bundleBytes('x'), {token: TOKEN})).status).toBe(401);

		expect(deployment.received).toHaveLength(0);
		expect(await everythingHeld(deployment)).toEqual(before);
	});

	it('refuses a body not declared as `text/javascript`, or declared as nothing, with `415`', async () => {
		const before = await everythingHeld(deployment);

		for (const contentType of ['application/octet-stream', 'application/json', undefined]) {
			const refused = await upload(deployment, bundleBytes('x'), {contentType});
			expect(refused.status, `${contentType}: ${JSON.stringify(refused.body)}`).toBe(415);
			expect(refused.body).toMatchObject({
				success: false,
				error: 'upload-wrong-content-type',
				arrival: 'upload',
				outcome: 'failed',
			});
			expect(refused.body.message).toContain(UPLOAD_CONTENT_TYPE);
		}

		expect(deployment.received).toHaveLength(0);
		expect(await everythingHeld(deployment)).toEqual(before);
	});

	it('takes the media type alone, so a `charset` or a different case is still an upload', async () => {
		const withCharset = await upload(deployment, bundleBytes('with-charset'), {
			contentType: 'Text/JavaScript; charset=utf-8',
		});
		expect(withCharset.status, JSON.stringify(withCharset.body)).toBe(200);
		expect(withCharset.body.outcome).toBe('registered');
	});

	it('refuses a body over the bound with `413`, and never hands the host a byte of it', async () => {
		const before = await everythingHeld(deployment);

		// one byte over, streamed with no declared length: the bound is enforced on what
		// is READ, not on what a client chose to announce
		const over = new Uint8Array(MAX_UPLOAD_BYTES + 1);
		const streamed = new ReadableStream<Uint8Array>({
			start(controller) {
				const chunk = 1024 * 1024;
				for (let offset = 0; offset < over.length; offset += chunk) {
					controller.enqueue(over.subarray(offset, offset + chunk));
				}
				controller.close();
			},
		});
		const refused = await deployment.app.request(`/${NAME}/admin/upload`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': UPLOAD_CONTENT_TYPE},
			body: streamed,
			duplex: 'half',
		} as RequestInit);
		expect(refused.status).toBe(413);
		expect(await refused.json()).toMatchObject({
			success: false,
			error: 'upload-too-large',
			arrival: 'upload',
			outcome: 'failed',
			limit: MAX_UPLOAD_BYTES,
		});

		// ...and a DECLARED length over the bound is refused before anything is read
		const declared = await upload(deployment, bundleBytes('small'), {
			headers: {'Content-Length': String(MAX_UPLOAD_BYTES + 1)},
		});
		expect(declared.status).toBe(413);

		expect(deployment.received).toHaveLength(0);
		expect(await everythingHeld(deployment)).toEqual(before);
	});

	it('accepts a body AT the bound: the limit is inclusive', async () => {
		const exactly = new Uint8Array(MAX_UPLOAD_BYTES);
		deployment.answer(async (bundle) => ({arrival: 'upload', outcome: 'failed', message: `${bundle.byteLength}`}));

		const answer = await upload(deployment, exactly);

		// it reached the host, which is the only claim: what the host made of it is its own
		expect(answer.status).toBe(409);
		expect(answer.body.message).toBe(String(MAX_UPLOAD_BYTES));
	});

	it('does not let an unauthenticated caller learn which names this host holds', async () => {
		expect((await upload(deployment, bundleBytes('x'), {name: 'beta', token: undefined})).status).toBe(401);
		const authenticated = await upload(deployment, bundleBytes('x'), {name: 'beta'});
		expect(authenticated.status).toBe(404);
		expect(authenticated.body).toMatchObject({error: 'unknown-indexer'});
	});
});

describe('a deployment that cannot receive a processor refuses HONESTLY', () => {
	it('answers `501 upload-not-held`, independently of the pointer move and the re-read it may hold', async () => {
		const entry: IndexerRegistryEntry = {
			...indexerEntryOn(deployment.db, deployment.indexer),
			reconfigure: async () => ({
				arrival: 're-read',
				outcome: 'unchanged',
				generation: deployment.incumbent,
				message: '',
			}),
		};
		const app = createServer<TestEnv>({
			getDB: () => deployment.db,
			getEnv: () => ({ADMIN_TOKEN}),
			getIndexer: (_c, name) => (name === NAME ? entry : undefined),
		});
		const authorized = {Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': UPLOAD_CONTENT_TYPE};

		expect((await app.request(`/${NAME}/admin/canonical-generation`, {headers: authorized})).status).toBe(200);
		const refused = await app.request(`/${NAME}/admin/upload`, {
			method: 'POST',
			headers: authorized,
			body: new Uint8Array(bundleBytes('x')),
		});
		expect(refused.status).toBe(501);
		const body = (await refused.json()) as {error: string; indexer: string; message: string};
		expect(body.error).toBe('upload-not-held');
		expect(body.indexer).toBe(NAME);
		expect(body.message).toMatch(/etherfold run/);
	});
});
