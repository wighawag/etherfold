import {EntityEventProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	createIndexerState,
	type HostProgress,
	type IndexerPort,
} from '../src/index.js';
import {
	BRANCH_A_TIP,
	BOB,
	ALICE,
	DAN,
	ERIN,
	EXPECTED_A,
	FINALITY,
	fakeChain,
	processor,
	SOURCE,
	START_BLOCK,
	txInBlock,
	type TestABI,
} from './workload.js';

/**
 * ONE BEHAVIOUR SUITE, RUN AGAINST ALL THREE **hosting shapes**.
 *
 * ADR-0082 opens with a claim -- "one body running in every hosting shape", so
 * that a dedicated worker, a SharedWorker and the main thread do not become three
 * implementations -- and until all three shapes existed nobody could check it.
 * This is the check, and its whole design is aimed at the way that claim is
 * EASY TO ASSERT WEAKLY: three test files that happen to agree prove nothing,
 * because they can drift one edit at a time and each will still pass.
 *
 * So the cases are DATA, exactly as `@etherfold/state-store-conformance`'s are
 * and as `readWorkload.ts`'s are: ONE list, several subjects, and the runner is a
 * thin adapter. A behaviour that stops holding on one shape is a named failure on
 * that shape, and a behaviour somebody adds is added for all three at once
 * because there is only one place to add it.
 *
 * ## The two runners, and why there have to be two
 *
 * The shapes cannot all be driven by one runner and it is not a matter of effort:
 * a `Worker` and a `SharedWorker` are browser constructs, so the two worker
 * shapes exist only in the real-browser Playwright run
 * (`browser/threeHostingShapes.spec.ts`, which runs this list three times in one
 * page, once per shape). The MAIN-THREAD shape needs no second execution context,
 * so `test/theThreeHostingShapesRunOneImplementation.test.ts` runs the same list
 * against it under vitest and `fake-indexeddb`, on every commit -- which is what
 * keeps the list honest between browser runs, since the acceptance gate has no
 * browser binaries.
 *
 * ## What the cases may and may not assume
 *
 * They are handed a PORT and nothing else, which is the criterion stated as
 * code: an app's code against the port is unchanged across the three shapes, so
 * anything a case needs that a port cannot answer would be a behaviour that is
 * not actually shared. Setting a shape up differs (a worker entry point, a
 * `SharedWorker` name, `init` on this thread) and that is expected -- constructing
 * a host is the one thing a shape IS.
 *
 * They run in ORDER against one port, and they leave it as they found it:
 * indexing, at the tip. Nothing here reconfigures, because a second generation
 * would change the answers every later case asserts on -- the reconfigure path
 * across the port is `browser/controlsTheIndexer.spec.ts`'s.
 */

/** ONE case: a group, a name, and a function that THROWS if the shape is wrong. */
export type HostingShapeCase = {
	readonly group: string;
	readonly name: string;
	run(port: IndexerPort): Promise<void>;
};

/** A case that did not hold, with what it said. */
export type HostingShapeFailure = {readonly group: string; readonly name: string; readonly error: string};

/** What a whole run came to. `failures` empty is what "one implementation" means. */
export type HostingShapeRun = {readonly passed: number; readonly failures: readonly HostingShapeFailure[]};

// ---------------------------------------------------------------------------
// The assertions, hand-written for the same reason `readWorkload.ts`'s are: this
// module is bundled into a page by the Playwright harness, and a matcher library
// is not.
// ---------------------------------------------------------------------------

function equals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((element, index) => equals(element, b[index]));
	}
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) {
		if (!equals(left[key], right[key])) return false;
	}
	return true;
}

function show(value: unknown): string {
	return JSON.stringify(value ?? null);
}

function same(what: string, actual: unknown, expected: unknown): void {
	if (!equals(actual, expected)) {
		throw new Error(`${what}: expected ${show(expected)}, got ${show(actual)}`);
	}
}

/**
 * THE REFUSAL, by NAME.
 *
 * An error's class does not cross a `postMessage`, and the main-thread shape's
 * wire is a real `MessageChannel`, so it does not cross there either -- which is
 * the point: what a refusal is narrowed on is the `name`, on every shape.
 */
async function refuses(what: string, call: Promise<unknown>, name: string): Promise<void> {
	const outcome = await call.then(
		(value) => ({answered: value}),
		(error: unknown) => ({error}),
	);
	if (!('error' in outcome)) {
		throw new Error(`${what}: expected a refusal (${name}), and it ANSWERED with ${show(outcome.answered)}`);
	}
	const error = outcome.error as {name?: string; message?: string};
	if (error?.name !== name) {
		throw new Error(`${what}: expected a ${name}, got ${error?.name}: ${error?.message}`);
	}
}

/** The counter, read THROUGH THE PORT: whatever the canonical generation says it is. */
async function transfers(port: IndexerPort): Promise<number | null> {
	const row = (await port.reads.getCurrent('counter', {name: 'transfers'})) as {value?: number} | undefined;
	return row?.value ?? null;
}

/**
 * Ask until the fold is level with THIS FIXTURE'S tip, and fail SAYING SO if the
 * host stopped.
 *
 * The tip is NAMED rather than inferred from equality: a container that has
 * loaded and not yet fetched publishes `0` for both numbers, so
 * `lastToBlock === latestBlock` holds before a single log has been asked for.
 */
export async function untilAtTip(port: IndexerPort, attempts = 600): Promise<HostProgress> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const progress = await port.progress();
		if (progress.failure) {
			throw new Error(`the host stopped: ${progress.failure.name}: ${progress.failure.message}`);
		}
		if (progress.latestBlock === BRANCH_A_TIP && progress.lastToBlock === progress.latestBlock) return progress;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`the fold did not reach the tip: ${JSON.stringify(await port.progress())}`);
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

/** A hash this chain never carried, so a verdict about it is an honest `absent`. */
const NEVER = '0x00000000000000000000000000000000000000000000000000000000000000bb';

export const hostingShapeCases: readonly HostingShapeCase[] = [
	{
		group: 'the fold',
		name: 'reaches the fixture tip and reports it as the port reports it everywhere',
		async run(port) {
			const progress = await untilAtTip(port);
			same('the phase at the tip', progress.phase, 'at-tip');
			same('the driver is running', progress.indexing, true);
			same('the cursor', progress.lastToBlock, BRANCH_A_TIP);
			same('the tip', progress.latestBlock, BRANCH_A_TIP);
		},
	},
	{
		group: 'the fold',
		name: 'derives the same three figures from the same cursor, in the host',
		async run(port) {
			// Computed where the cursor is, by one function, on every shape -- which is
			// what stops a progress bar meaning one thing in a worker and another here.
			const progress = await port.progress();
			same('blocks behind the chain tip', progress.blocksBehindTip, 0);
			same('blocks processed so far', progress.numBlocksProcessedSoFar, BRANCH_A_TIP - START_BLOCK);
			same('the percentage', progress.syncPercentage, 100);
		},
	},
	{
		group: 'the fold',
		name: 'says WHICH shape is answering, and WHERE the answer was computed',
		async run(port) {
			const progress = await port.progress();
			// The shape is a label the entry point passed and the port repeats it, so the
			// two must agree; `scope` is MEASURED where the answer was computed and is the
			// one field these three legitimately differ in.
			same('the shape the port and the host agree on', progress.host, port.host);
			if (typeof progress.scope !== 'string' || progress.scope.length === 0) {
				throw new Error(`the host reported no execution scope: ${show(progress.scope)}`);
			}
		},
	},
	{
		group: 'the port surface',
		name: 'hands the tab the same twelve verbs, and nothing that could write',
		async run(port) {
			same('the port surface', Object.keys(port).sort(), [
				'checkTxInclusion',
				'close',
				'generations',
				'host',
				'onHostDeath',
				'onProgress',
				'progress',
				'promotion',
				'reads',
				'reconfigure',
				'startIndexing',
				'stopIndexing',
			]);
			const surface = port as unknown as Record<string, unknown>;
			for (const mutating of ['applyBlock', 'revertTo', 'writeCursor', 'clearCursor', 'prune', 'token']) {
				if (surface[mutating] !== undefined) {
					throw new Error(`the port carries a mutating verb (${mutating}), which no hosting shape may hand a tab`);
				}
			}
		},
	},
	{
		group: 'the four reads',
		name: 'answers the rows this workload folds, wherever it folded them',
		async run(port) {
			same('the transfer count', await transfers(port), EXPECTED_A.transfers);
			same('token 1 at the tip', await port.reads.getCurrent('token', {id: '1'}), {id: '1', owner: BOB});
			same('token 3 at the tip', await port.reads.getCurrent('token', {id: '3'}), {id: '3', owner: DAN});
			same('token 2 at the tip', await port.reads.getCurrent('token', {id: '2'}), {id: '2', owner: ERIN});
		},
	},
	{
		group: 'the four reads',
		name: 'projects to the DECLARED columns, so no version column ever crosses',
		async run(port) {
			const row = (await port.reads.getCurrent('token', {id: '1'}))!;
			same('the columns of token 1', Object.keys(row).sort(), ['id', 'owner']);
		},
	},
	{
		group: 'the four reads',
		name: 'answers `undefined` for a row the fold never wrote, which is not a refusal',
		async run(port) {
			same('token 9', await port.reads.getCurrent('token', {id: '9'}), undefined);
		},
	},
	{
		group: 'the four reads',
		name: 'reads as of an earlier block, from the same history',
		async run(port) {
			// Block 100 gave token 1 to Alice; block 102 gave it to Bob.
			same('token 1 as of 100', await port.reads.getAsOf('token', {id: '1'}, 100), {id: '1', owner: ALICE});
			same('token 3 as of 100', await port.reads.getAsOf('token', {id: '3'}, 100), undefined);
		},
	},
	{
		group: 'the four reads',
		name: 'lists by prefix, at the tip and as of a block, bounded by its limit',
		async run(port) {
			same('the listing of token 3', await port.reads.listCurrent('token', {id: '3'}, 10), {
				rows: [{id: '3', owner: DAN}],
				truncated: false,
			});
			same('a prefix with no rows', await port.reads.listCurrent('token', {id: '9'}, 10), {
				rows: [],
				truncated: false,
			});
			same('the listing of token 3 as of 100', await port.reads.listAsOf('token', {id: '3'}, 100, 10), {
				rows: [],
				truncated: false,
			});
		},
	},
	{
		group: 'the four reads',
		name: 'REFUSES an entity the store was not built with, by the seam\u2019s own name',
		async run(port) {
			// The refusal a tab gets is the refusal a same-thread caller gets: raised by
			// `mustGet` at the seam, carried by NAME because a prototype cannot cross.
			await refuses('a read of an undeclared entity', port.reads.getCurrent('nope', {id: '1'}), 'UnknownEntityError');
		},
	},
	{
		group: 'the four reads',
		name: 'reports what the host\u2019s store was built with',
		async run(port) {
			const declared = (await port.reads.declarations()).map((entity) => entity.name).sort();
			same('the declared entities', declared, ['counter', 'token']);
		},
	},
	{
		group: 'generations',
		name: 'holds one generation, and it is the one answering reads',
		async run(port) {
			const generations = await port.generations();
			same('how many generations', generations.length, 1);
			same('it is canonical', generations[0]?.canonical, true);
			// It fetched its own logs rather than following a stream somebody else writes.
			same('it follows nothing', generations[0]?.follows, false);
			same('its cursor', generations[0]?.lastToBlock, BRANCH_A_TIP);
		},
	},
	{
		group: 'generations',
		name: 'reports the promotion policy the container resolved, defaulted nowhere else',
		async run(port) {
			same('the policy in force', (await port.promotion()).policy, 'on-catch-up');
		},
	},
	{
		group: 'tx inclusion',
		name: 'answers the optimistic-update question whole: a status AND its basis',
		async run(port) {
			const watched = txInBlock(104);
			const verdicts = await port.checkTxInclusion([{txHash: watched}, {txHash: NEVER}]);
			same('one verdict per hash, from one call', Object.keys(verdicts).length, 2);
			same('a folded transaction', verdicts[watched]?.status, 'included');
			same('and the basis it was concluded on', verdicts[watched]?.basis, 'window-hit');
			same('a transaction this chain never carried', verdicts[NEVER]?.status, 'absent');
		},
	},
	{
		group: 'control',
		name: 'stops the driver, keeps answering reads, and starts it again',
		async run(port) {
			const stopped = await port.stopIndexing();
			same('the driver stopped', stopped.indexing, false);
			// A STOPPED host is still a host: stopping the DRIVER is not closing the
			// CONTAINER, so an app that switched indexing off keeps its data on screen.
			same('the store still answers', await transfers(port), EXPECTED_A.transfers);
			// Idempotent, because these name a STATE a caller wants and not an edge.
			same('stopping a stopped host answers', (await port.stopIndexing()).indexing, false);
			const started = await port.startIndexing();
			same('the driver started', started.indexing, true);
			same('starting a started host answers', (await port.startIndexing()).indexing, true);
			// Left as it was found, so the cases are order-independent in what they assert.
			await untilAtTip(port);
		},
	},
	{
		group: 'status is pushed',
		name: 'tells a subscriber where the fold is, without being asked again',
		async run(port) {
			// Attaching ANSWERS with the current progress, which is what makes a tab that
			// attached to a finished fold correct immediately -- nothing here is going to
			// move, so a signal that only carried CHANGES would say nothing for ever.
			const first = await new Promise<HostProgress>((resolve) => {
				const stop = port.onProgress((progress) => {
					resolve(progress);
					queueMicrotask(() => stop());
				});
			});
			same('what the subscriber was told', first.phase, 'at-tip');
			same('and the cursor it carried', first.lastToBlock, BRANCH_A_TIP);
		},
	},
];

/**
 * Run every case against one shape's port and REPORT, rather than throwing at
 * the first failure.
 *
 * The shape the conformance suite's own runner has, and for the same reason: a
 * caller that is not a test runner (a browser page) needs the whole verdict
 * carried back in one value, and "which cases failed" is the interesting part.
 */
export async function runHostingShapeCases(port: IndexerPort): Promise<HostingShapeRun> {
	const failures: HostingShapeFailure[] = [];
	let passed = 0;
	for (const one of hostingShapeCases) {
		try {
			await one.run(port);
			passed++;
		} catch (error) {
			failures.push({group: one.group, name: one.name, error: `${(error as Error)?.message ?? error}`});
		}
	}
	return {passed, failures};
}

/**
 * THE MAIN-THREAD SHAPE, SET UP: `createIndexerState` IS the host, and the port
 * is a wire to it (ADR-0082).
 *
 * The one shape whose setup is not "construct a worker": there is a host on this
 * thread already, so this builds the indexer an app would build anyway, starts
 * its loop, and joins a wire. `watch: false` because a host on this thread cannot
 * die independently of the tab holding the port.
 *
 * The interval is the fixture's and not an application's: nothing here has a
 * reason to rest four seconds at a tip that never moves.
 */
export async function openOnTheMainThread(databaseName: string): Promise<{port: IndexerPort; close(): void}> {
	const chain = fakeChain();
	const indexer = createIndexerState<TestABI, EntityStateView>({
		createState: async () => openForWriting(await createBrowserStateStore(processor.entities, {databaseName})),
		createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
	});
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
	await indexer.startAutoIndexing(0.05);
	const port = connectToIndexerHost(indexer.mainThreadHost(), {watch: false});
	return {
		port,
		close() {
			port.close();
			indexer.dispose();
		},
	};
}
