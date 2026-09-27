import 'fake-indexeddb/auto';
import {createHash} from 'node:crypto';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {build} from 'esbuild';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {processorArtifactIdentity} from '@etherfold/core';
import {EntityEventProcessor, type EntityProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {MemoryStateStore, openForWriting, type WritableStateStore} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createIndexerState,
	hostIndexerInThisSharedWorker,
	loadProcessorBundle,
	ProcessorBundleRefusedError,
	serveIndexerHost,
	type HostProgress,
	type IndexerPort,
	type InstantiatedProcessorBundle,
	type MessageEndpoint,
	type ProcessorBundleSource,
} from '../src/index.js';
import {untilAtTip} from '../browser/hostingShapes.js';
import {
	EXPECTED_A,
	FINALITY,
	fakeChain,
	indexToTip,
	processor,
	readState,
	SOURCE,
	type TestABI,
} from '../browser/workload.js';
import {wire} from './utils/port.js';
import {sharedWorkerScope} from './utils/sharedWorkerScope.js';

/**
 * A TAB RUNS THE PUBLISHED PROCESSOR BUNDLE, and its identity is the bytes' hash
 * (ADR-0086, ADR-0095).
 *
 * The seam is the HOST: a spec naming a `processorBundle` URL, in each of the three
 * hosting shapes, over a REAL bundle built the way the examples build theirs
 * (`esbuild --bundle --format=esm --minify`, `examples/event-processor-nfts`) and
 * served over real HTTP. What is asserted is what a publication rests on: the
 * generation is registered under the SHA-256 of the fetched bytes, equal to what
 * the CLI derives for the same file, and the fold is the fold those bytes carry.
 *
 * The refusals are asserted both as the loader's DATA and at the host, where the
 * claim is that a refused bundle folds nothing and claims no store.
 *
 * ## What a node run cannot show
 *
 * A real Content-Security-Policy. Node has none, so `forbidden-by-policy` is
 * driven through the one injectable step a policy acts on (`importModule`), with
 * the `securitypolicyviolation` event a browser dispatches. The policy matrix
 * itself is measured in three engines in
 * `work/notes/findings/a-tab-instantiates-retained-bytes-only-through-a-same-origin-url.md`.
 */

const ENTRY = new URL('./fixtures/published-processor/processor.ts', import.meta.url).pathname;

/** A bundle built the way the examples build theirs, as the OCTETS a static host serves. */
async function aPublishedBundle(options: {external?: string[]; contents?: string} = {}): Promise<Uint8Array> {
	const result = await build({
		...(options.contents
			? {stdin: {contents: options.contents, loader: 'ts', resolveDir: new URL('.', import.meta.url).pathname}}
			: {entryPoints: [ENTRY]}),
		bundle: true,
		format: 'esm',
		minify: true,
		...(options.external ? {external: options.external} : {}),
		write: false,
		logLevel: 'silent',
	});
	return result.outputFiles[0].contents;
}

/** The CLI's identity, recomputed independently with `node:crypto` so the two are not one function checking itself. */
function sha256Of(bytes: Uint8Array): string {
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A static host: each path answers its bytes, anything else 404. */
let server: Server;
let origin: string;
const served = new Map<string, Uint8Array>();
function publish(path: string, bytes: Uint8Array): string {
	served.set(path, bytes);
	return `${origin}${path}`;
}

beforeAll(async () => {
	server = createServer((request, response) => {
		const bytes = served.get(request.url ?? '');
		if (!bytes) {
			response.writeHead(404, 'Not Found').end();
			return;
		}
		response.writeHead(200, {'content-type': 'text/javascript'}).end(Buffer.from(bytes));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

let counter = 0;
const freshPath = (name: string) => `/${counter++}-${Math.random().toString(36).slice(2, 8)}/${name}`;

/**
 * The factory an app writes for a bundle: the entity runtime over the state,
 * around the AUTHORING object the published bytes made.
 */
function foldOf(state: WritableStateStore, _context: unknown, bundle?: InstantiatedProcessorBundle) {
	if (!bundle) throw new Error(`this factory is for a bundle arrival and was handed none`);
	return new EntityEventProcessor<TestABI>(state, bundle.processor as EntityProcessor<TestABI>);
}

/** A memory store, counting how many times a host asked for one: a refused bundle must ask for none. */
function countedStores() {
	const counted = {built: 0};
	return {
		counted,
		createState: () => {
			counted.built++;
			return openForWriting(new MemoryStateStore(processor.entities));
		},
	};
}

/** Ask until the host says it stopped, and return what it said. */
async function untilRefused(port: IndexerPort, attempts = 400): Promise<HostProgress> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const progress = await port.progress();
		if (progress.phase === 'refused') return progress;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`the host was never refused`);
}

describe('a tab runs a published processor bundle', () => {
	it('folds with the bundle on the MAIN THREAD, registered under the SHA-256 the CLI derives for the same file', async () => {
		const bytes = await aPublishedBundle();
		const url = publish(freshPath('processor.bundle.js'), bytes);
		const chain = fakeChain();
		const indexer = createIndexerState<TestABI, EntityStateView>({
			// the bundle has ARRIVED before the state is built, so the store is declared
			// from the entities the published bytes declare, not from a second copy
			createState: (_context, _patience, bundle) =>
				openForWriting(new MemoryStateStore((bundle?.processor as EntityProcessor<TestABI>).entities)),
			createProcessor: foldOf,
			processorBundle: {url},
		});
		try {
			await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
			await indexToTip(indexer);

			const registered = indexer.canonical?.record.processor;
			// what `etherfold build` names the same file (`@etherfold/utils` re-exports this
			// very function), and the same digest computed independently
			expect(registered).toBe(processorArtifactIdentity(bytes));
			expect(registered).toBe(sha256Of(bytes));
			// the fold is the one the BYTES carry
			expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);
		} finally {
			indexer.dispose();
		}
	});

	it('names the same code differently as a MODULE, so the module arrival keeps its own identity', async () => {
		const bytes = await aPublishedBundle();
		const url = publish(freshPath('processor.bundle.js'), bytes);
		const asBundle = createIndexerState<TestABI, EntityStateView>({
			createState: () => openForWriting(new MemoryStateStore(processor.entities)),
			createProcessor: foldOf,
			processorBundle: {url},
		});
		const handed: unknown[] = [];
		const asModule = createIndexerState<TestABI, EntityStateView>({
			createState: () => openForWriting(new MemoryStateStore(processor.entities)),
			createProcessor: (state, _context, bundle) => {
				handed.push(bundle);
				return new EntityEventProcessor<TestABI>(state, processor);
			},
		});
		try {
			for (const indexer of [asBundle, asModule]) {
				await indexer.init({provider: fakeChain().provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
				await indexToTip(indexer);
				expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);
			}
			// the module arrival is untouched: handed no bundle, named by its handler sources
			expect(handed).toEqual([undefined]);
			expect(asModule.canonical?.record.processor).toBe(
				new EntityEventProcessor(undefined as never, processor).getCodeFingerprint(),
			);
			expect(asModule.canonical?.record.processor).not.toBe(asBundle.canonical?.record.processor);
		} finally {
			asBundle.dispose();
			asModule.dispose();
		}
	});

	it('does the same in a DEDICATED WORKER host, where the bundle is instantiated inside the host', async () => {
		const bytes = await aPublishedBundle();
		const url = publish(freshPath('processor.bundle.js'), bytes);
		const ends = wire();
		// `hostIndexerInThisWorker` is exactly this call over the worker's own scope;
		// node has no second execution context, so the wire stands in for it.
		const host = serveIndexerHost<TestABI, EntityStateView>(
			{
				createState: () => openForWriting(new MemoryStateStore(processor.entities)),
				createProcessor: foldOf,
				processorBundle: {url},
				provider: fakeChain().provider,
				source: SOURCE,
				config: {stream: {finality: FINALITY}},
				tipIntervalInSeconds: 0.05,
			},
			ends.host,
		);
		const port = connectToIndexerHost(ends.tab);
		try {
			await untilAtTip(port);
			const generations = await port.generations();
			expect(generations).toHaveLength(1);
			expect(generations[0].record.processor).toBe(processorArtifactIdentity(bytes));
			expect(await port.reads.getCurrent('counter', {name: 'transfers'})).toEqual({
				name: 'transfers',
				value: EXPECTED_A.transfers,
			});
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('does the same in a SHAREDWORKER host', async () => {
		const bytes = await aPublishedBundle();
		const url = publish(freshPath('processor.bundle.js'), bytes);
		const scope = sharedWorkerScope();
		const channel = new MessageChannel();
		try {
			const host = hostIndexerInThisSharedWorker<TestABI, EntityStateView>({
				createState: () => openForWriting(new MemoryStateStore(processor.entities)),
				createProcessor: foldOf,
				processorBundle: {url},
				provider: fakeChain().provider,
				source: SOURCE,
				config: {stream: {finality: FINALITY}},
				tipIntervalInSeconds: 0.05,
			});
			const tabEnd = channel.port2 as unknown as MessageEndpoint;
			scope.connect(channel.port1 as unknown as MessageEndpoint);
			const port = connectToIndexerHost({host: 'shared-worker', endpoint: tabEnd, close: () => channel.port2.close()});
			try {
				await untilAtTip(port);
				const generations = await port.generations();
				expect(generations).toHaveLength(1);
				expect(generations[0].record.processor).toBe(processorArtifactIdentity(bytes));
				expect(await port.reads.getCurrent('counter', {name: 'transfers'})).toEqual({
					name: 'transfers',
					value: EXPECTED_A.transfers,
				});
			} finally {
				host.dispose();
				port.close();
			}
		} finally {
			channel.port1.close();
			scope.restore();
		}
	});

	it('refuses a spec that names a bundle AND an identity, since the bytes name themselves', async () => {
		const url = publish(freshPath('processor.bundle.js'), await aPublishedBundle());
		const stores = countedStores();
		const indexer = createIndexerState<TestABI, EntityStateView>({
			createState: stores.createState,
			createProcessor: foldOf,
			processorBundle: {url},
			processorIdentity: 'sha256:injected',
		});
		try {
			await expect(
				indexer.init({provider: fakeChain().provider, source: SOURCE, config: {stream: {finality: FINALITY}}}),
			).rejects.toThrow(/`processorBundle` AND a `processorIdentity`/);
			expect(stores.counted.built).toBe(0);
		} finally {
			indexer.dispose();
		}
	});
});

describe('a published bundle that cannot run is REFUSED, distinctly, and folds nothing', () => {
	/** The one step a Content-Security-Policy acts on, refusing as a strict policy does, with the event a browser fires. */
	function underAStrictPolicy(): {importModule: (url: string) => Promise<unknown>; restore: () => void} {
		const scope = globalThis as {addEventListener?: unknown; removeEventListener?: unknown};
		const before = {add: scope.addEventListener, remove: scope.removeEventListener};
		const target = new EventTarget();
		scope.addEventListener = target.addEventListener.bind(target);
		scope.removeEventListener = target.removeEventListener.bind(target);
		return {
			importModule: async (url: string) => {
				const scheme = url.slice(0, url.indexOf(':'));
				// dispatched as a task of its own, as a browser does, after the rejection
				setTimeout(() =>
					target.dispatchEvent(
						Object.assign(new Event('securitypolicyviolation'), {
							effectiveDirective: 'script-src-elem',
							blockedURI: scheme,
							originalPolicy: "script-src 'self'",
						}),
					),
				);
				// the message is the one chromium rejects with, for good AND corrupt bytes alike
				throw new TypeError(`Failed to fetch dynamically imported module: ${url.slice(0, 40)}`);
			},
			restore() {
				if (before.add === undefined) delete scope.addEventListener;
				else scope.addEventListener = before.add;
				if (before.remove === undefined) delete scope.removeEventListener;
				else scope.removeEventListener = before.remove;
			},
		};
	}

	it('reports each refusal as its own reason, with the identity of the bytes it refused', async () => {
		const good = await aPublishedBundle();

		const notSelfContained = await aPublishedBundle({
			contents: `import {keccak256} from 'viem'; export const createProcessor = () => ({entities: [], hash: keccak256});`,
			external: ['viem'],
		});
		const leaky = await loadProcessorBundle(publish(freshPath('leaky.bundle.js'), notSelfContained));
		expect(leaky).toMatchObject({
			status: 'refused',
			reason: 'not-self-contained',
			unresolvedImports: ['viem'],
			identity: processorArtifactIdentity(notSelfContained),
		});

		// the good bundle cut mid-token: what a partially written upload looks like
		const truncated = good.subarray(0, Math.floor(good.length / 2));
		const unloadable = await loadProcessorBundle(publish(freshPath('truncated.bundle.js'), truncated));
		expect(unloadable).toMatchObject({
			status: 'refused',
			reason: 'unreadable-module',
			identity: processorArtifactIdentity(truncated),
		});

		const policy = underAStrictPolicy();
		try {
			const forbidden = await loadProcessorBundle(publish(freshPath('good.bundle.js'), good), {
				importModule: policy.importModule,
			});
			expect(forbidden).toMatchObject({
				status: 'refused',
				reason: 'forbidden-by-policy',
				identity: processorArtifactIdentity(good),
			});
			// it NAMES the policy, and says the bytes were not at fault
			if (forbidden.status !== 'refused' || forbidden.reason !== 'forbidden-by-policy') throw new Error('unreachable');
			expect(forbidden.why).toMatch(/Content-Security-Policy/);
			expect(forbidden.why).toContain(`"script-src 'self'"`);
			expect(forbidden.why).toMatch(/not at fault/);
			expect(forbidden.violations.map((violation) => violation.blocked)).toEqual(['data', 'blob']);
		} finally {
			policy.restore();
		}

		const missing = await loadProcessorBundle(`${origin}/nothing-was-published-here.js`);
		expect(missing).toMatchObject({status: 'refused', reason: 'unreachable'});
		expect(missing).not.toHaveProperty('identity');

		const withNoProcessor = await aPublishedBundle({contents: `export const somethingElse = 1;`});
		const notAProcessor = await loadProcessorBundle(publish(freshPath('empty.bundle.js'), withNoProcessor));
		expect(notAProcessor).toMatchObject({status: 'refused', reason: 'not-a-processor'});

		// and the good bundle, with nothing in its way, is instantiated under the same name
		const loaded = await loadProcessorBundle(publish(freshPath('good.bundle.js'), good));
		expect(loaded).toMatchObject({status: 'instantiated', identity: processorArtifactIdentity(good)});
	});

	it('stops a MAIN-THREAD host before it claims a store, with the refusal as data', async () => {
		const good = await aPublishedBundle();
		const truncated = good.subarray(0, Math.floor(good.length / 2));
		const policy = underAStrictPolicy();
		try {
			const cases: {source: ProcessorBundleSource; reason: string}[] = [
				{
					source: {
						url: publish(
							freshPath('leaky.bundle.js'),
							await aPublishedBundle({
								contents: `import 'viem'; export const createProcessor = () => ({entities: []});`,
								external: ['viem'],
							}),
						),
					},
					reason: 'not-self-contained',
				},
				{source: {url: publish(freshPath('truncated.bundle.js'), truncated)}, reason: 'unreadable-module'},
				{
					source: {url: publish(freshPath('good.bundle.js'), good), importModule: policy.importModule},
					reason: 'forbidden-by-policy',
				},
			];
			for (const {source, reason} of cases) {
				const stores = countedStores();
				const chain = fakeChain();
				const indexer = createIndexerState<TestABI, EntityStateView>({
					createState: stores.createState,
					createProcessor: foldOf,
					processorBundle: source,
				});
				try {
					const refused = await indexer
						.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}})
						.then(
							() => undefined,
							(error: unknown) => error,
						);
					expect(refused).toBeInstanceOf(ProcessorBundleRefusedError);
					expect((refused as ProcessorBundleRefusedError).reason).toBe(reason);
					// nothing was claimed, nothing registered, and the chain was never asked for a log
					expect(stores.counted.built).toBe(0);
					expect(indexer.generations).toEqual([]);
					expect(chain.ranges).toEqual([]);
				} finally {
					indexer.dispose();
				}
			}
		} finally {
			policy.restore();
		}
	});

	it('reports the refusal across the port from a WORKER host, which folds nothing', async () => {
		const good = await aPublishedBundle();
		const truncated = good.subarray(0, Math.floor(good.length / 2));
		const stores = countedStores();
		const chain = fakeChain();
		const ends = wire();
		const host = serveIndexerHost<TestABI, EntityStateView>(
			{
				createState: stores.createState,
				createProcessor: foldOf,
				processorBundle: {url: publish(freshPath('truncated.bundle.js'), truncated)},
				provider: chain.provider,
				source: SOURCE,
				config: {stream: {finality: FINALITY}},
				tipIntervalInSeconds: 0.05,
			},
			ends.host,
		);
		const port = connectToIndexerHost(ends.tab);
		try {
			const progress = await untilRefused(port);
			expect(progress.failure?.name).toBe('ProcessorBundleRefusedError');
			expect(progress.failure?.details).toMatchObject({
				reason: 'unreadable-module',
				identity: processorArtifactIdentity(truncated),
			});
			expect(stores.counted.built).toBe(0);
			expect(chain.ranges).toEqual([]);
			expect(progress.lastToBlock).toBeUndefined();
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});
});
