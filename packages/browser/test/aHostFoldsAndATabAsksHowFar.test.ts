import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, EntityStateView} from '@etherfold/processor-entities';
import {openForReading, openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	hostIndexerInThisWorker,
	INDEXER_PORT_PROTOCOL,
	isPortResponse,
	serveIndexerHost,
	type HostAccess,
	type HostProgress,
	type IndexerPort,
} from '../src/index.js';
import {wire} from './utils/port.js';
import {
	BRANCH_A_TIP,
	EXPECTED_A,
	FINALITY,
	fakeChain,
	processor,
	readState,
	SOURCE,
	type TestABI,
} from '../browser/workload.js';

/**
 * A HOST FOLDING A WORKLOAD, AND A TAB ASKING HOW FAR IT HAS GOT -- over a real
 * `MessagePort`, in node.
 *
 * What runs in a REAL browser with a REAL dedicated worker is
 * `browser/hostedInAWorker.spec.ts`, which is where "the UI thread is not doing
 * the fold" becomes a fact about an execution context rather than an arrangement
 * of objects. These are the same claims on every commit, because that run needs
 * browser binaries a clean checkout does not have.
 *
 * The two ends here are joined by a `MessageChannel` (`test/utils/port.ts`),
 * which is the same structured-clone boundary a worker is: nothing that could
 * not cross to a worker crosses here either. What it does not have is a second
 * thread -- so this names itself the `main-thread` shape, honestly, rather than
 * pretending to be a worker it is not.
 */

let counter = 0;
const freshName = () => `hosted-indexer-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

function hostOver(access: HostAccess, databaseName: string, chain = fakeChain()) {
	return serveIndexerHost<TestABI, EntityStateView>(
		{
			// THE HOST IS THE WRITER: the claim is taken here, inside the host, and
			// nothing the tab can name reaches this handle (ADR-0077).
			createState: async () => openForWriting(await createBrowserStateStore(processor.entities, {databaseName})),
			createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
			provider: chain.provider,
			source: SOURCE,
			config: {stream: {finality: FINALITY}},
			// The node run has no reason to rest for four seconds at the tip.
			tipIntervalInSeconds: 0.05,
		},
		access,
	);
}

/**
 * Ask until the fold is level with THIS FIXTURE'S tip.
 *
 * The tip is named rather than inferred from equality, and that is not
 * pedantry: a container that has loaded and not yet fetched publishes `0` for
 * both numbers, so `lastToBlock === latestBlock` is true before a single log has
 * been asked for. A wait that read that as "caught up" would return immediately
 * and leave every assertion after it racing the fold -- which is exactly what it
 * did, on one engine out of three.
 *
 * A FAILURE ends the wait immediately and says what it was: a host that stopped
 * looks exactly like a host that is slow, and a test that could not tell them
 * apart would report every wiring mistake as a timeout.
 */
async function untilAtTip(port: IndexerPort, attempts = 400): Promise<HostProgress> {
	let progress = await port.progress();
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (progress.failure) {
			throw new Error(`the host stopped: ${progress.failure.name}: ${progress.failure.message}`);
		}
		if (progress.latestBlock === BRANCH_A_TIP && progress.lastToBlock === progress.latestBlock) {
			return progress;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
		progress = await port.progress();
	}
	throw new Error(`the fold did not reach the tip: ${JSON.stringify(progress)}`);
}

/** The state the host wrote, read back the way a tab reads it: through a READER. */
async function stateFrom(databaseName: string) {
	const reader = openForReading(await createBrowserStateStore(processor.entities, {databaseName}));
	return readState(new EntityStateView(reader));
}

describe('an indexer hosted behind a port', () => {
	it('folds the workload in the host, and the tab gets the cursor across the boundary', async () => {
		const databaseName = freshName();
		const ends = wire();
		const host = hostOver(ends.host, databaseName);
		const port = connectToIndexerHost(ends.tab);

		try {
			const progress = await untilAtTip(port);

			// the answer came from the host, and it is the host's own figure
			expect(progress.host).toBe('main-thread');
			expect(progress.indexing).toBe(true);
			expect(progress.latestBlock).toBe(BRANCH_A_TIP);
			expect(progress.lastToBlock).toBe(progress.latestBlock);
			expect(progress.lastToBlock).toBe(host.progress().lastToBlock);

			// and the state it wrote is the state this workload produces anywhere else
			expect(await stateFrom(databaseName)).toEqual(EXPECTED_A);
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('hands the tab nothing that could write to the store', async () => {
		const ends = wire();
		const host = hostOver(ends.host, freshName());
		const port = connectToIndexerHost(ends.tab);

		try {
			// The writer/reader split as a fact of the TYPE: there is no mutating verb
			// to call, because there is no store on this side at all -- `reads` is the
			// store's four READS and nothing beside them. `pnpm typecheck` runs the
			// other half of this claim (the refusals below do not compile).
			expect(Object.keys(port).sort()).toEqual(['close', 'host', 'onProgress', 'progress', 'reads']);
			const surface = port as unknown as Record<string, unknown>;
			for (const mutating of ['applyBlock', 'revertTo', 'writeCursor', 'clearCursor', 'prune', 'token']) {
				expect(surface[mutating]).toBeUndefined();
			}
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('answers only its own messages, and ignores what somebody else posted', async () => {
		const ends = wire();
		const host = hostOver(ends.host, freshName());
		const port = connectToIndexerHost(ends.tab);

		try {
			const answers: unknown[] = [];
			ends.tabEndpoint.addEventListener('message', (event) => answers.push(event.data));

			// a message from another library sharing this endpoint
			ends.tabEndpoint.postMessage({kind: 'request', id: 1, case: 'progress'});
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(answers).toEqual([]);

			// and the port still works, so the foreign message cost nothing
			expect((await port.progress()).host).toBe('main-thread');
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('answers a case it does not know with a refusal, rather than with silence', async () => {
		const ends = wire();
		const host = hostOver(ends.host, freshName());

		try {
			const answered = new Promise<unknown>((resolve) => {
				ends.tabEndpoint.addEventListener('message', (event) => resolve(event.data));
				ends.tabEndpoint.start?.();
			});
			// the shape a later task's case will have, from a build that has it against
			// a host that does not
			ends.tabEndpoint.postMessage({
				protocol: INDEXER_PORT_PROTOCOL,
				kind: 'request',
				id: 7,
				case: 'read',
				payload: {entity: 'token'},
			});

			const response = await answered;
			expect(isPortResponse(response)).toBe(true);
			expect(response).toMatchObject({id: 7, case: 'read', ok: false});
			expect((response as {error: {message: string}}).error.message).toContain(`'read'`);
		} finally {
			host.dispose();
			ends.close();
		}
	});

	it('carries every value of the one surface it has through a REAL structured clone', async () => {
		const databaseName = freshName();
		const ends = wire();
		const host = hostOver(ends.host, databaseName);
		const port = connectToIndexerHost(ends.tab);

		try {
			const progress = await untilAtTip(port);
			// It already crossed a MessagePort to get here, which is the claim; this
			// says so a second time in one line, against the algorithm itself.
			expect(structuredClone(progress)).toEqual(progress);
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * THE WORKER ENTRY POINT IS NOT A MODULE A TAB IMPORTS.
	 *
	 * A stray `import './indexer.worker.js'` from the app bundle would otherwise
	 * start a SECOND container on the UI thread, folding into the same store as the
	 * real one -- and the first symptom would be a writer being refused, three
	 * layers from the import that caused it. The refusal is also what makes the
	 * `host: 'dedicated-worker'` a tab is told a consequence rather than a label:
	 * the only way to reach that code is to be running somewhere that is not a
	 * document.
	 */
	it('refuses to host the indexer anywhere that is a document', () => {
		const scope = globalThis as {window?: unknown};
		// What a tab's global looks like from inside this module. Restored below: no
		// other test in this file may see it.
		scope.window = {};
		try {
			expect(() => hostIndexerInThisWorker({} as never)).toThrow(/must be called from INSIDE a worker/);
		} finally {
			delete scope.window;
		}
	});

	it('refuses to host the indexer where there is nothing to answer a tab through', () => {
		// node's main thread: not a document, and no worker messaging either.
		expect(() => hostIndexerInThisWorker({} as never)).toThrow(/no worker messaging/);
	});

	it('rejects a call that is in flight when the tab lets the host go', async () => {
		const ends = wire();
		const host = hostOver(ends.host, freshName());
		const port = connectToIndexerHost(ends.tab);

		try {
			const inFlight = port.progress();
			port.close();

			// A hung promise is the worst available outcome: a stalled app and a slow
			// app look identical from outside (ADR-0082).
			await expect(inFlight).rejects.toThrow(/closed while this call was in flight/);
			await expect(port.progress()).rejects.toThrow(/this indexer port is closed/);
		} finally {
			host.dispose();
			ends.close();
		}
	});
});
