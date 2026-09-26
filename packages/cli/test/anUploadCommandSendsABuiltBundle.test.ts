import {generationDigestOf} from '@etherfold/core';
import {MAX_UPLOAD_BYTES} from '@etherfold/server';
import {processorArtifactIdentity} from '@etherfold/utils';
import {createClient} from '@libsql/client';
import {readFile, rm, mkdtemp, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {run, type RunningIndexer} from '../src/index.js';
import type {Options} from '../src/types.js';
import {uploadMain} from '../src/uploadCommand.js';
import {ALICE, BOB, fakeChain, SOURCE, START_BLOCK, transfer, ZERO} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// `etherfold upload` SENDS AN ALREADY-BUILT BUNDLE, AND ANYTHING SHORT OF A REGISTRATION FAILS THE PIPELINE
// ---------------------------------------------------------------------------------------------------
// The SENDER half of The Graph's deploy shape (ADR-0085's amendment of 2026-09-22):
// one command, the same on a laptop and in CI, that takes a bundle an author has
// ALREADY built and uploads its bytes to a running node's
// `POST /{indexer}/admin/upload`. It never builds.
//
// The claim a CI pipeline rests on is the EXIT CODE, so every case here asserts it:
// `0` for `registered` and for an honest `unchanged`, and non-zero for every refusal
// -- the local self-containment check, each of the node's refusals, and a node that
// cannot be reached at all -- with the reason printed where a pipeline log shows it.
//
// Asserted END TO END against a real `run`, stood up exactly as the route's own
// suite stands one up (`aBundleIsUploadedToARunningNode.test.ts`), over the same
// committed REAL bundles (`fixtures/processor-bundle/`).
// ---------------------------------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL('./fixtures/processor-bundle/', import.meta.url));
const BUNDLE = join(FIXTURES, 'nfts.bundle.js');
const EDITED_BUNDLE = join(FIXTURES, 'nfts-edited.bundle.js');
const APPROVAL_BUNDLE = join(FIXTURES, 'nfts-with-approval.bundle.js');
const NOT_SELF_CONTAINED = join(FIXTURES, 'not-self-contained.bundle.js');
const THROWS_ON_EVALUATION = join(FIXTURES, 'throws-on-evaluation.bundle.js');

const INDEXER = 'nfts';
const ADMIN_TOKEN = 'the-operators-own-secret';

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
];
const TIP = START_BLOCK + 50;

const scratch: string[] = [];
let running: RunningIndexer | undefined;

afterEach(async () => {
	await running?.stop().catch(() => undefined);
	running = undefined;
	for (const dir of scratch.splice(0)) {
		await rm(dir, {recursive: true, force: true}).catch(() => undefined);
	}
	delete process.env.ADMIN_TOKEN;
});

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/** A node folding `nfts.bundle.js` that has folded `LOGS` and is answering reads, guarded by `ADMIN_TOKEN`. */
async function aNodeServing(env: Record<string, string> = {}): Promise<RunningIndexer> {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	running = await run(
		{processor: BUNDLE, nodeUrl: 'http://localhost:0', store: 'sqlite', db: ':memory:', port: '0', indexer: INDEXER},
		{
			provider: fakeChain().serve(LOGS, TIP).provider,
			createDB: oneDatabase,
			sleep: async () => {
				await new Promise((resolve) => setTimeout(resolve, 1));
			},
			handleSignals: false,
			log: () => {},
			env: {MAX_BLOCKS_PER_FETCH: '20', ...env},
		},
	);
	const deadline = Date.now() + 10_000;
	for (;;) {
		const res = await fetch(`${running.url}/${INDEXER}/feed`);
		const body = (await res.json()) as {entries?: unknown[]};
		if (res.status === 200 && body.entries?.length === LOGS.length) return running;
		if (Date.now() > deadline) throw new Error('the node never served its feed');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

type Ran = {code: number | undefined; out: string; err: string; requests: number};

/**
 * RUN THE COMMAND the way `cli.ts` runs it, with the process's exit and its two
 * output streams captured, and every request it makes counted.
 */
async function uploadWith(options: Options, env: Record<string, string> = {}): Promise<Ran> {
	const out: string[] = [];
	const err: string[] = [];
	let code: number | undefined;
	let requests = 0;
	await uploadMain(options, {
		env,
		fetch: (input, init) => {
			requests += 1;
			return fetch(input, init);
		},
		log: (...args) => out.push(args.map(String).join(' ')),
		error: (...args) => err.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')),
		exit: (value) => {
			code = value;
		},
	});
	return {code, out: out.join('\n'), err: err.join('\n'), requests};
}

/** The command line a CI step writes: a bundle, the node, the name; the credential in the environment. */
function toNode(indexer: RunningIndexer, bundle: string): Options {
	return {bundle, to: indexer.url, indexer: INDEXER};
}

const withCredential = {ADMIN_TOKEN};

async function listingOf(indexer: RunningIndexer): Promise<{generations: {digest: string}[]}> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
	});
	return (await res.json()) as {generations: {digest: string}[]};
}

async function digestsOf(indexer: RunningIndexer): Promise<string[]> {
	return (await listingOf(indexer)).generations.map((entry) => entry.digest).sort();
}

async function aScratchDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-upload-command-'));
	scratch.push(dir);
	return dir;
}

/** A URL nothing listens on: a port the OS handed out, then closed again. */
async function aClosedPort(): Promise<string> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const {port} = server.address() as {port: number};
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return `http://127.0.0.1:${port}`;
}

// ---------------------------------------------------------------------------------------------------

describe('a registration and an honest `unchanged` pass the pipeline', () => {
	it('registers the bundle, prints the outcome, the generation and the arrival, and exits 0', async () => {
		const indexer = await aNodeServing();
		const incumbent = generationDigestOf(indexer.container.generation);
		const edited = new Uint8Array(await readFile(EDITED_BUNDLE));

		const ran = await uploadWith(toNode(indexer, EDITED_BUNDLE), withCredential);

		expect(ran.code, ran.err).toBe(0);
		expect(ran.requests).toBe(1);
		// what the node says it did, read back through the operator's own listing
		const digests = await digestsOf(indexer);
		expect(digests).toHaveLength(2);
		const registered = digests.find((digest) => digest !== incumbent) as string;
		expect(digests).toContain(incumbent);
		// ...and what the command PRINTED says the same: the outcome, the generation and the arrival
		expect(ran.out).toMatch(/\bregistered\b/);
		expect(ran.out).toContain(registered);
		expect(ran.out).toContain(processorArtifactIdentity(edited));
		expect(ran.out).toMatch(/arrival:\s*upload/);
		expect(ran.err).toBe('');
	});

	it('exits 0 on `unchanged` and SAYS it was unchanged, registering nothing', async () => {
		const indexer = await aNodeServing();
		const before = await digestsOf(indexer);

		const ran = await uploadWith(toNode(indexer, BUNDLE), withCredential);

		expect(ran.code, ran.err).toBe(0);
		expect(ran.out).toMatch(/\bunchanged\b/);
		expect(ran.out).toContain(generationDigestOf(indexer.container.generation));
		expect(ran.out).toMatch(/already folding/);
		expect(await digestsOf(indexer)).toEqual(before);
	});

	it('takes the bundle as -p too, the processor input every other command names it by', async () => {
		const indexer = await aNodeServing();

		const ran = await uploadWith({processor: EDITED_BUNDLE, to: indexer.url, indexer: INDEXER}, withCredential);

		expect(ran.code, ran.err).toBe(0);
		expect(ran.out).toMatch(/\bregistered\b/);
	});

	it('takes the target and the name from the environment, as every other command takes its inputs', async () => {
		const indexer = await aNodeServing();

		const ran = await uploadWith({bundle: EDITED_BUNDLE}, {UPLOAD_TO: indexer.url, INDEXER_NAME: INDEXER, ADMIN_TOKEN});

		expect(ran.code, ran.err).toBe(0);
		expect(ran.out).toMatch(/\bregistered\b/);
	});
});

describe('a bundle that is not self-contained is refused LOCALLY, before any request', () => {
	it('exits non-zero with the refusal every folding command gives, and sends nothing', async () => {
		const indexer = await aNodeServing();
		const before = await digestsOf(indexer);

		const ran = await uploadWith(toNode(indexer, NOT_SELF_CONTAINED), withCredential);

		expect(ran.code).not.toBe(0);
		expect(ran.requests).toBe(0);
		// the EXISTING refusal's words (`refuseUnbundledProcessor`), not a second check's
		expect(ran.err).toContain('names an ENTRY POINT rather than a bundle');
		expect(ran.err).toContain('"viem"');
		expect(ran.err).toContain('esbuild');
		expect(await digestsOf(indexer)).toEqual(before);
	});

	it('exits non-zero on a path that names no file, which is the build that has not run', async () => {
		const ran = await uploadWith(
			{bundle: join(await aScratchDir(), 'dist', 'processor.js'), to: 'http://127.0.0.1:1', indexer: INDEXER},
			withCredential,
		);

		expect(ran.code).not.toBe(0);
		expect(ran.requests).toBe(0);
		expect(ran.err).toContain('is not a file this process can read');
	});
});

describe('every refusal by the node, and a node nobody answers, fail the pipeline with the reason', () => {
	it('a wrong credential: the admin guard`s 401', async () => {
		const indexer = await aNodeServing();

		const ran = await uploadWith(toNode(indexer, EDITED_BUNDLE), {ADMIN_TOKEN: 'not-the-token'});

		expect(ran.code).not.toBe(0);
		expect(ran.err).toMatch(/\b401\b/);
		expect(ran.err).toContain('unauthorized');
		expect(ran.err).toContain('ADMIN_TOKEN');
		expect(ran.out).toBe('');
	});

	it('a body over the bound: `413 upload-too-large`', async () => {
		const indexer = await aNodeServing();
		// self-contained, since it imports nothing, and one byte over the node's bound
		const path = join(await aScratchDir(), 'huge.bundle.js');
		await writeFile(path, new Uint8Array(MAX_UPLOAD_BYTES + 1).fill(0x20));

		const ran = await uploadWith(toNode(indexer, path), withCredential);

		expect(ran.code).not.toBe(0);
		expect(ran.requests).toBe(1);
		expect(ran.err).toMatch(/\b413\b/);
		expect(ran.err).toContain('upload-too-large');
		expect(ran.err).toContain(`at most ${MAX_UPLOAD_BYTES} bytes`);
	});

	it('a bundle that throws on evaluation: `409 upload-failed`, carrying the node`s reason', async () => {
		const indexer = await aNodeServing();
		const before = await digestsOf(indexer);

		const ran = await uploadWith(toNode(indexer, THROWS_ON_EVALUATION), withCredential);

		expect(ran.code).not.toBe(0);
		expect(ran.err).toMatch(/\b409\b/);
		expect(ran.err).toContain('upload-failed');
		expect(ran.err).toContain('this bundle throws while it is evaluated');
		expect(ran.err).toMatch(/arrival:\s*upload/);
		expect(await digestsOf(indexer)).toEqual(before);
	});

	it('contracts that do not match the source the node was started with: `409`, naming both', async () => {
		const indexer = await aNodeServing({INDEXING_SOURCE: JSON.stringify(SOURCE)});

		const ran = await uploadWith(toNode(indexer, APPROVAL_BUNDLE), withCredential);

		expect(ran.code).not.toBe(0);
		expect(ran.err).toMatch(/\b409\b/);
		expect(ran.err).toContain('Transfer, Approval');
		expect(ran.err).toContain('INDEXING_SOURCE');
	});

	it('a node that cannot be reached: nothing answered, so nothing was deployed', async () => {
		const to = await aClosedPort();

		const ran = await uploadWith({bundle: EDITED_BUNDLE, to, indexer: INDEXER}, withCredential);

		expect(ran.code).not.toBe(0);
		expect(ran.requests).toBe(1);
		expect(ran.err).toContain(to);
		expect(ran.err).toMatch(/could not reach/);
	});

	it('an answer that is not the upload route`s report at all, which is not a deployment either', async () => {
		const indexer = await aNodeServing();

		// a name this node was not started with: the guard lets the operator through,
		// and the route answers that the name is unknown
		const ran = await uploadWith({bundle: EDITED_BUNDLE, to: indexer.url, indexer: 'not-this-one'}, withCredential);

		expect(ran.code).not.toBe(0);
		expect(ran.err).toMatch(/\b404\b/);
	});
});

describe('the inputs are refused by name, never defaulted, before any request', () => {
	const cases: [string, Options, Record<string, string>, RegExp][] = [
		['the bundle path', {to: 'http://127.0.0.1:1', indexer: INDEXER}, {ADMIN_TOKEN}, /bundle/i],
		['--to', {bundle: BUNDLE, indexer: INDEXER}, {ADMIN_TOKEN}, /--to \(UPLOAD_TO\)/],
		['--indexer', {bundle: BUNDLE, to: 'http://127.0.0.1:1'}, {ADMIN_TOKEN}, /--indexer \(INDEXER_NAME\)/],
		['the credential', {bundle: BUNDLE, to: 'http://127.0.0.1:1', indexer: INDEXER}, {}, /ADMIN_TOKEN/],
	];
	for (const [what, options, env, named] of cases) {
		it(`refuses a missing ${what}, naming it`, async () => {
			const ran = await uploadWith(options, env);

			expect(ran.code).not.toBe(0);
			expect(ran.requests).toBe(0);
			expect(ran.err).toMatch(named);
			expect(ran.err).toContain('required by `etherfold upload`');
		});
	}

	it('never reads the CHAIN`s endpoint as the target: ETH_NODE_URI is not a fallback for --to', async () => {
		const ran = await uploadWith({bundle: BUNDLE, indexer: INDEXER}, {ADMIN_TOKEN, ETH_NODE_URI: 'http://127.0.0.1:1'});

		expect(ran.code).not.toBe(0);
		expect(ran.requests).toBe(0);
		expect(ran.err).toMatch(/--to \(UPLOAD_TO\)/);
	});

	it('refuses --node-url as an input it does not take, pointing at --to', async () => {
		const ran = await uploadWith(
			{bundle: BUNDLE, to: 'http://127.0.0.1:1', indexer: INDEXER, nodeUrl: 'http://127.0.0.1:1'},
			withCredential,
		);

		expect(ran.code).not.toBe(0);
		expect(ran.requests).toBe(0);
		expect(ran.err).toContain('-n, --node-url (ETH_NODE_URI) is not accepted by `etherfold upload`');
		expect(ran.err).toContain('--to');
	});

	it('refuses a target that is not an http(s) URL', async () => {
		const ran = await uploadWith({bundle: BUNDLE, to: 'localhost:2000', indexer: INDEXER}, withCredential);

		expect(ran.code).not.toBe(0);
		expect(ran.requests).toBe(0);
		expect(ran.err).toContain('--to (UPLOAD_TO) "localhost:2000" is not');
	});

	it('refuses a bundle named twice, as the argument AND as -p', async () => {
		const ran = await uploadWith(
			{bundle: BUNDLE, processor: EDITED_BUNDLE, to: 'http://127.0.0.1:1', indexer: INDEXER},
			withCredential,
		);

		expect(ran.code).not.toBe(0);
		expect(ran.requests).toBe(0);
		expect(ran.err).toMatch(/twice/);
	});
});
