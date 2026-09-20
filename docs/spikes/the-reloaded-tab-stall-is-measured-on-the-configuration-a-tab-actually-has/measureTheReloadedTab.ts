/**
 * THE MEASUREMENT: what a RELOADED TAB asks the chain for, on the configuration
 * a tab actually has.
 *
 * Run it (from the repository root, after `pnpm install && pnpm build`):
 *
 * ```sh
 * pnpm --filter @etherfold/browser exec tsx \
 *   ../../docs/spikes/the-reloaded-tab-stall-is-measured-on-the-configuration-a-tab-actually-has/measureTheReloadedTab.ts
 * ```
 *
 * It is a SCRIPT and not a test, deliberately. The task that produced it changes
 * no behaviour and leaves nothing red, so this must not be collected by
 * `packages/browser`'s vitest config, and it must not live under `packages/*`
 * at all -- it is evidence kept at a stable path so the follow-on FIX task does
 * not pay for the measurement twice.
 *
 * ## Why the imports are spelled as paths
 *
 * This file is outside every workspace package, so a bare `@etherfold/core`
 * cannot resolve from here (pnpm puts the links in each package's own
 * `node_modules`). Each import therefore names the file the browser package's
 * own imports resolve to, so there is exactly ONE copy of each package in the
 * process: `@etherfold/core` resolves through its `exports` map to `dist`, so
 * that is what is named here; `@etherfold/browser` is taken from `src`, which is
 * what its own tests import and what the workload fixture already pulls in.
 */
import '../../../packages/browser/node_modules/fake-indexeddb/auto';
import {
	openIndexer,
	openMemoryGenerationRegistry,
	type AnyGenerationSpec,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistry,
	type Indexer,
} from '../../../packages/core/dist/index.js';
import {MemoryStateStore, openForWriting, type WritableStateStore} from '../../../packages/state-store/dist/index.js';
import type {
	EntityProcessor,
	EntityEventProcessor,
	EntityStateView,
} from '../../../packages/processor-entities/dist/index.js';
import {
	BROWSER_GENERATION_CAPS,
	keepStreamOnIndexedDB,
	openGenerationRegistryOnIndexedDB,
} from '../../../packages/browser/src/index.js';
// Not re-exported from the package index on purpose (`src/host/index.ts` says so),
// and reached directly here because it is the ONE rule a host answers `at-tip`
// by: what a stalled tab REPORTS is half of what makes the failure silent, and
// re-spelling the rule in this file would be measuring my own copy of it.
import {phaseAfterCycle} from '../../../packages/browser/src/host/pacing.js';
import {
	BRANCH_A_EXTENDED,
	BRANCH_A_EXTENDED_TIP,
	entityProcessorOver,
	fakeChain,
	FINALITY,
	processor,
	processorVariant,
	readState,
	SOURCE,
	START_BLOCK,
	streamOf,
	type RawLog,
	type TestABI,
} from '../../../packages/browser/browser/workload.js';
import {createHash} from 'node:crypto';

// ---------------------------------------------------------------------------
// THE FIXTURE, lifted verbatim in SHAPE from `test/aTabHoldsItsGenerationsInSlots.test.ts`
// so that what is measured here is the same subject that suite asserts on.
// ---------------------------------------------------------------------------

/** A processor identity the way an ARRIVAL derives one: a hash of some bytes (ADR-0086). */
function identityOf(marker: string): string {
	const bytes = new TextEncoder().encode(`export const createProcessor=()=>({marker:${JSON.stringify(marker)}});\n`);
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** What the app itself arrived as: the bundle the tab was loaded with. */
const APP_IDENTITY = identityOf('the-app');
/** The fold a save produces: same events, counted differently, so a read says which one answered. */
const editedTo = (countBy: number) => processorVariant({countBy});
/** What a save's ARRIVAL derived: new bytes, so a new generation, with no author action. */
const identityFor = (countBy: number) => identityOf(`edited-by-${countBy}`);

let counter = 0;
const freshName = () => `stall-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

async function memoryStore(definition: EntityProcessor<TestABI> = processor): Promise<WritableStateStore> {
	return openForWriting(new MemoryStateStore(definition.entities));
}

function generationOver(
	store: WritableStateStore,
	definition: EntityProcessor<TestABI>,
	processorIdentity: string,
): AnyGenerationSpec<TestABI, EntityStateView> {
	let fold: EntityEventProcessor<TestABI> | undefined;
	return {
		createState: () => store,
		createProcessor: (state) => (fold = entityProcessorOver(state as WritableStateStore, definition)),
		stateOf: () => (fold as EntityEventProcessor<TestABI>).state,
		processorIdentity,
	};
}

// ---------------------------------------------------------------------------
// THE INSTRUMENT: every method the container asked the node for, in order.
// ---------------------------------------------------------------------------
// `fakeChain` records `eth_getLogs` RANGES only, and the question here needs the
// other three methods too: a FOLLOWER's first advance still calls `load()`, and
// `load` opens with the `eth_chainId` identity handshake (ADR-0081), so "made a
// chain read" and "fetched logs" are two different facts and a count of calls
// cannot tell them apart.

type ChainReads = {
	/** Every method asked for, in order, with duplicates kept. */
	calls: string[];
	/** How many times each method was asked for. */
	byMethod: Record<string, number>;
	/** The `eth_getLogs` ranges, which is what "did it fetch" actually means. */
	ranges: {from: number; to: number}[];
};

function recordingChain() {
	const chain = fakeChain();
	const calls: string[] = [];
	return {
		ranges: chain.ranges,
		/** THE CHAIN MOVES ON while the tab is closed, which is what makes a stall visible. */
		serve(logs: readonly RawLog[], tip: number): void {
			chain.serve(logs, tip);
		},
		provider: {
			async request(args: {method: string; params?: unknown}): Promise<unknown> {
				calls.push(args.method);
				return chain.provider.request(args);
			},
		} as never,
		/** What has been asked SINCE the marker, so one session's reads are separable. */
		readsSince(callMark: number, rangeMark: number): ChainReads {
			const since = calls.slice(callMark);
			const byMethod: Record<string, number> = {};
			for (const method of since) byMethod[method] = (byMethod[method] ?? 0) + 1;
			return {calls: since, byMethod, ranges: chain.ranges.slice(rangeMark)};
		},
		mark(): {callMark: number; rangeMark: number} {
			return {callMark: calls.length, rangeMark: chain.ranges.length};
		},
	};
}

type Chain = ReturnType<typeof recordingChain>;

/** A durable registry under this tab's name, with what it was asked to drop recorded. */
async function durableRegistry(name: string): Promise<{registry: GenerationRegistry; dropped: GenerationId[]}> {
	const dropped: GenerationId[] = [];
	const registry = await openGenerationRegistryOnIndexedDB(name, {
		dropState: async (id) => {
			dropped.push(id);
		},
	});
	return {registry, dropped};
}

/**
 * Drive the container the way a TAB's driver does: `load()` once, then `indexMore()`
 * to the tip.
 *
 * The `load()` is not decoration. `setupIndexing` (`IndexerState.ts:1326`) calls
 * `indexer.load()` before it ever advances, and a container whose first act is
 * `indexMore()` over a stored stream throws `indexing... should not replay`
 * (`promiseToIndex` loads INSIDE the index action, and `replay` refuses while one
 * is executing). So the harness loads first, because the production driver does.
 */
async function driveToTip(container: Indexer<TestABI, EntityStateView>, rounds = 20): Promise<void> {
	await container.load();
	for (let round = 0; round < rounds; round++) {
		const lastSync = await container.indexMore();
		if (lastSync.lastToBlock >= lastSync.latestBlock) return;
	}
}

/**
 * WHAT THE STORED STREAM LOOKS LIKE AFTERWARDS, which is the question any FIX
 * has to answer and a stall never reaches.
 *
 * The receiving side's measured failure for the naive hand-over was DUPLICATE
 * HISTORY -- "`_emissions` holds 4 rows where 2 are correct" (ADR-0087) -- and
 * the failure its timing argument names is a HOLE. Neither is visible in a
 * `follows` flag or in a count of chain reads, so the stream is read back and
 * both are looked for by name: a log delivered twice, and what the stream's own
 * cursor claims to cover against the blocks actually in it.
 */
async function streamHealth(keepStream: {
	fetchFrom: (source: typeof SOURCE, fromBlock: number) => Promise<unknown>;
}): Promise<Record<string, unknown>> {
	const read = (await keepStream.fetchFrom(SOURCE, START_BLOCK)) as {status: string};
	if (read.status !== 'stream') {
		return {status: read.status};
	}
	const {eventStream, lastSync} = streamOf(read as never);
	const seen = new Map<string, number>();
	for (const event of eventStream) {
		const key = `${event.blockHash}:${event.logIndex}:${event.removed ? 'removed' : 'applied'}`;
		seen.set(key, (seen.get(key) ?? 0) + 1);
	}
	return {
		events: eventStream.length,
		blocksPresent: [...new Set(eventStream.map((event) => Number(event.blockNumber)))],
		deliveredTwice: [...seen.entries()].filter(([, count]) => count > 1).map(([key, count]) => `${key} x${count}`),
		coversTo: lastSync.lastToBlock,
	};
}

/** The slots as markers, so a line of output reads as a sentence. */
const MARKERS = new Map<string, string>();
function marker(identity: string | undefined): string | undefined {
	return identity === undefined ? undefined : (MARKERS.get(identity) ?? identity.slice(0, 14));
}
for (const name of ['the-app', 'edited-by-2', 'edited-by-3']) MARKERS.set(identityOf(name), name);

async function slotsBy(registry: GenerationRegistry): Promise<Record<string, string | undefined>> {
	const held = await registry.slots();
	const of = (record: GenerationRecord | undefined) => marker(record?.processor);
	return {canonical: of(held.canonical), successor: of(held.successor), predecessor: of(held.predecessor)};
}

// ---------------------------------------------------------------------------
// THE REPORT
// ---------------------------------------------------------------------------

const results: {name: string; verdict: string; detail: Record<string, unknown>}[] = [];

function report(name: string, verdict: string, detail: Record<string, unknown>): void {
	results.push({name, verdict, detail});
	console.log(`\n### ${name}\n${verdict}`);
	for (const [key, value] of Object.entries(detail)) {
		console.log(`  ${key}: ${JSON.stringify(value)}`);
	}
}

/**
 * THE CHAIN MOVES ON WHILE THE TAB IS CLOSED, and every reload below is measured
 * after it did.
 *
 * Without this, a reloaded tab that asks for nothing is indistinguishable from
 * one that is simply already at the tip, and "zero `eth_getLogs`" would be a
 * statement about the fixture rather than about the container. `BRANCH_A_EXTENDED`
 * adds a transfer in block 106 and moves the tip to 107, so a tab that fetches
 * lands on 107 with the extra event folded, and a tab that stalls stays on 105
 * for ever.
 */
function theChainMovesOn(chain: Chain): void {
	chain.serve(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP);
}

/** What the node would tell anyone who asked, at the moment each reload is measured. */
const NODE_TIP_AFTER_THE_RELOAD = BRANCH_A_EXTENDED_TIP;

/**
 * SESSION 1, shared by every scenario below: a tab opens on the app's own fold
 * over a durable registry and a durable stream keeper, and indexes to the tip.
 */
async function firstSession(name: string, chain: Chain) {
	const {registry} = await durableRegistry(name);
	const keepStream = keepStreamOnIndexedDB<TestABI>(name);
	const container = await openIndexer<TestABI, EntityStateView>({
		registry,
		provider: chain.provider,
		source: SOURCE,
		config: {keepStream, stream: {finality: FINALITY}},
		generations: [generationOver(await memoryStore(), processor, APP_IDENTITY)],
	});
	await driveToTip(container);
	return {registry, keepStream, container};
}

// ---------------------------------------------------------------------------
// SCENARIO 0 -- WHICH REGISTRY A REAL TAB HAS: the DEFAULT one, in memory.
// ---------------------------------------------------------------------------
// Both real entry points default to `openMemoryGenerationRegistry`, which does
// not survive a reload. This stands the DEFAULT up twice over one durable stream
// keeper, which is what a tab reloading with changed handler code really is, and
// records what the second session asks the chain for.
async function scenarioDefaultRegistryReload(): Promise<void> {
	const name = freshName();
	const keepStream = keepStreamOnIndexedDB<TestABI>(name);
	const chain = recordingChain();

	const first = await openIndexer<TestABI, EntityStateView>({
		// a FRESH memory registry, which is exactly what `spec.registry ?? await
		// openMemoryGenerationRegistry(BROWSER_GENERATION_CAPS)` builds per page load
		registry: await openMemoryGenerationRegistry(BROWSER_GENERATION_CAPS),
		provider: chain.provider,
		source: SOURCE,
		config: {keepStream, stream: {finality: FINALITY}},
		generations: [generationOver(await memoryStore(), processor, APP_IDENTITY)],
	});
	await driveToTip(first);
	theChainMovesOn(chain);

	// THE RELOAD: a new page load, so a NEW memory registry, arriving with the
	// edited bundle and holding exactly ONE fold -- which is all a tab can hold,
	// since the previous handler's code is not in the bundle that just loaded.
	const mark = chain.mark();
	const reloadedRegistry = await openMemoryGenerationRegistry(BROWSER_GENERATION_CAPS);
	const reloaded = await openIndexer<TestABI, EntityStateView>({
		registry: reloadedRegistry,
		provider: chain.provider,
		source: SOURCE,
		config: {keepStream, stream: {finality: FINALITY}},
		generations: [generationOver(await memoryStore(editedTo(3)), editedTo(3), identityFor(3))],
	});
	await driveToTip(reloaded);
	const reads = chain.readsSince(mark.callMark, mark.rangeMark);
	const state = await readState(reloaded.state);

	report(
		'0. THE DEFAULT CONFIGURATION: reload with changed handler code, MEMORY registry, one generation',
		reads.ranges.length > 0 ? 'FETCHES -- no stall' : 'STALLED -- zero eth_getLogs',
		{
			follows: reloaded.canonical.follows,
			registeredOnReload: (await reloadedRegistry.list()).map((record) => marker(record.processor)),
			chainReadsByMethod: reads.byMethod,
			getLogsRanges: reads.ranges,
			nodeTip: NODE_TIP_AFTER_THE_RELOAD,
			tabCursor: reloaded.canonical.lastSync?.lastToBlock,
			state,
		},
	);

}

// ---------------------------------------------------------------------------
// SCENARIO 1 -- TRIGGER A: reload with CHANGED HANDLER CODE, DURABLE registry.
// ---------------------------------------------------------------------------
// The observation's original mechanism. The previous session's generation
// survives in `canonical`, and the tab holds no fold for it.
async function scenarioChangedHandlerReload(): Promise<void> {
	const name = freshName();
	const chain = recordingChain();
	const {registry, keepStream, container} = await firstSession(name, chain);
	const slotsBefore = await slotsBy(registry);
	theChainMovesOn(chain);

	const mark = chain.mark();
	const reloaded = await durableRegistry(name);
	let refusal: {name: string; message: string} | undefined;
	let opened: Indexer<TestABI, EntityStateView> | undefined;
	try {
		opened = await openIndexer<TestABI, EntityStateView>({
			registry: reloaded.registry,
			provider: chain.provider,
			source: SOURCE,
			config: {keepStream, stream: {finality: FINALITY}},
			generations: [generationOver(await memoryStore(editedTo(3)), editedTo(3), identityFor(3))],
		});
	} catch (error) {
		refusal = {name: (error as Error).name, message: (error as Error).message};
	}

	if (refusal) {
		report('1. TRIGGER A: changed-handler reload, DURABLE registry, ONE generation', `REFUSED: ${refusal.name}`, {
			slotsAfterFirstSession: slotsBefore,
			slotsAtRefusal: await slotsBy(reloaded.registry),
			chainReadsByMethod: chain.readsSince(mark.callMark, mark.rangeMark).byMethod,
			message: refusal.message,
		});
		return;
	}

	const container2 = opened as Indexer<TestABI, EntityStateView>;
	await driveToTip(container2);
	const reads = chain.readsSince(mark.callMark, mark.rangeMark);
	report(
		'1. TRIGGER A: changed-handler reload, DURABLE registry, ONE generation',
		reads.ranges.length > 0 ? 'FETCHES -- no stall' : 'STALLED -- zero eth_getLogs',
		{
			follows: container2.canonical.follows,
			slots: await slotsBy(reloaded.registry),
			chainReadsByMethod: reads.byMethod,
			getLogsRanges: reads.ranges,
			nodeTip: NODE_TIP_AFTER_THE_RELOAD,
			tabCursor: container2.canonical.lastSync?.lastToBlock,
			state: await readState(container2.state),
		},
	);

}

// ---------------------------------------------------------------------------
// SCENARIO 2 -- TRIGGER B: reload after a PROMOTION, DURABLE registry.
// ---------------------------------------------------------------------------
// The live hypothesis. Session 1 saves a successor B beside A and the default
// `on-catch-up` policy promotes it; `dropOnPromotion` defaults to false and a
// generation `predecessor` names is untouchable, so A SURVIVES. Session 2 loads
// B's bundle alone. B is already `canonical`, so `resolveCanonical` succeeds --
// but A is older and still registered on the same stream.
//
// Run TWICE, because a reloaded tab's own STATE is durable and this harness's
// stores are not: `carriesItsState` hands session 2 the very store session 1
// folded into, which is what `runWorkload` means by a reload ("the tab's
// IndexedDB connection did not go anywhere"), while the other pass gives it a
// fresh one. The stall must not depend on which, and the pair says so.
async function scenarioReloadAfterPromotion(options: {carriesItsState: boolean}): Promise<void> {
	const label = `2${options.carriesItsState ? 'b' : 'a'}. TRIGGER B: reload after a PROMOTION, DURABLE registry, ONE generation (${
		options.carriesItsState ? "the tab's own state SURVIVES the reload" : 'a fresh state, so it re-folds from the start'
	})`;
	const name = freshName();
	const chain = recordingChain();
	const {registry, keepStream, container} = await firstSession(name, chain);

	// THE SAVE: a developer edits the handler, the tab registers the new fold
	// beside the live one, and the policy promotes it when it catches up.
	const savedState = await memoryStore(editedTo(3));
	await container.add(generationOver(savedState, editedTo(3), identityFor(3)));
	await driveToTip(container);
	const slotsAfterPromotion = await slotsBy(registry);
	// THE CHAIN MOVES ON while the tab is closed, so there is something to fetch:
	// a stall that only showed up as "asked for nothing new" would otherwise be
	// indistinguishable from "already at the tip".
	theChainMovesOn(chain);

	// THE RELOAD: a full page load of the edited bundle. A tab can supply exactly
	// ONE fold, and it is this one -- the previous handler's code is not in it.
	const mark = chain.mark();
	const reloaded = await durableRegistry(name);
	let refusal: {name: string; message: string} | undefined;
	let opened: Indexer<TestABI, EntityStateView> | undefined;
	try {
		opened = await openIndexer<TestABI, EntityStateView>({
			registry: reloaded.registry,
			provider: chain.provider,
			source: SOURCE,
			config: {keepStream, stream: {finality: FINALITY}},
			generations: [
				generationOver(
					options.carriesItsState ? savedState : await memoryStore(editedTo(3)),
					editedTo(3),
					identityFor(3),
				),
			],
		});
	} catch (error) {
		refusal = {name: (error as Error).name, message: (error as Error).message};
	}

	if (refusal) {
		report(label, `REFUSED: ${refusal.name}`, {slotsAfterPromotion, message: refusal.message});
		return;
	}

	const container2 = opened as Indexer<TestABI, EntityStateView>;
	await driveToTip(container2);
	const reads = chain.readsSince(mark.callMark, mark.rangeMark);
	report(
		label,
		reads.ranges.length > 0 ? 'FETCHES -- no stall' : 'STALLED -- zero eth_getLogs, and it opened healthy',
		{
			slotsAfterPromotion,
			slotsAfterReload: await slotsBy(reloaded.registry),
			follows: container2.canonical.follows,
			fetcherOnTheStream: marker((await reloaded.registry.fetcherOf(container2.canonical.record.stream))?.processor),
			heldByTheTab: [marker(container2.canonical.record.processor)],
			chainReadsByMethod: reads.byMethod,
			getLogsRanges: reads.ranges,
			nodeTip: NODE_TIP_AFTER_THE_RELOAD,
			// THE HALF THAT MAKES IT SILENT: it answers reads and it reports at-tip,
			// through the host's own pacing rule, while the chain is two blocks ahead.
			reportedPhase: phaseAfterCycle(container2 as never),
			state: await readState(container2.state),
			// what the tab left in the STREAM: the duplicate-or-hole question, which is
			// what any candidate fix has to be judged on and what a stall never reaches
			storedStream: await streamHealth(keepStream),
			lastSync: {
				lastToBlock: container2.canonical.lastSync?.lastToBlock,
				latestBlock: container2.canonical.lastSync?.latestBlock,
			},
		},
	);

}

// ---------------------------------------------------------------------------
// SCENARIO 3 -- THE EXISTING TEST'S CONFIGURATION: the reload holds BOTH folds.
// ---------------------------------------------------------------------------
// `aTabHoldsItsGenerationsInSlots.test.ts` opens its reloaded container with the
// previous handler's fold AND the edited one. This reproduces that configuration
// over the same instrument, so the two lines can be compared directly.
async function scenarioTheExistingTestsConfiguration(): Promise<void> {
	const name = freshName();
	const chain = recordingChain();
	const {registry, keepStream, container} = await firstSession(name, chain);
	await container.add(generationOver(await memoryStore(editedTo(2)), editedTo(2), identityFor(2)));
	theChainMovesOn(chain);

	const mark = chain.mark();
	const reloaded = await durableRegistry(name);
	const container2 = await openIndexer<TestABI, EntityStateView>({
		registry: reloaded.registry,
		provider: chain.provider,
		source: SOURCE,
		config: {keepStream, stream: {finality: FINALITY}},
		generations: [
			generationOver(await memoryStore(), processor, APP_IDENTITY),
			generationOver(await memoryStore(editedTo(3)), editedTo(3), identityFor(3)),
		],
	});
	await driveToTip(container2);
	const reads = chain.readsSince(mark.callMark, mark.rangeMark);
	report(
		"3. THE EXISTING TEST'S CONFIGURATION: reload holding BOTH folds, DURABLE registry",
		reads.ranges.length > 0 ? 'FETCHES -- which is what that suite asserts' : 'STALLED -- zero eth_getLogs',
		{
			slots: await slotsBy(registry),
			follows: container2.canonical.follows,
			chainReadsByMethod: reads.byMethod,
			getLogsRanges: reads.ranges,
			nodeTip: NODE_TIP_AFTER_THE_RELOAD,
			tabCursor: container2.canonical.lastSync?.lastToBlock,
		},
	);

}

// ---------------------------------------------------------------------------
// SCENARIO 4 -- THE CONTROL: the same reload holding ONE fold, no promotion.
// ---------------------------------------------------------------------------
// The same-processor reload, which is pinned as FIXED. It is here so the numbers
// above have a baseline that is known-good on the SAME instrument.
async function scenarioUnchangedReload(): Promise<void> {
	const name = freshName();
	const chain = recordingChain();
	await firstSession(name, chain);
	const keepStream = keepStreamOnIndexedDB<TestABI>(name);
	theChainMovesOn(chain);

	const mark = chain.mark();
	const reloaded = await durableRegistry(name);
	const container2 = await openIndexer<TestABI, EntityStateView>({
		registry: reloaded.registry,
		provider: chain.provider,
		source: SOURCE,
		config: {keepStream, stream: {finality: FINALITY}},
		generations: [generationOver(await memoryStore(), processor, APP_IDENTITY)],
	});
	await driveToTip(container2);
	const reads = chain.readsSince(mark.callMark, mark.rangeMark);
	report(
		'4. CONTROL: reload with UNCHANGED handler code, DURABLE registry, ONE generation',
		reads.ranges.length > 0 ? 'FETCHES -- the baseline' : 'STALLED -- zero eth_getLogs',
		{
			follows: container2.canonical.follows,
			chainReadsByMethod: reads.byMethod,
			getLogsRanges: reads.ranges,
			nodeTip: NODE_TIP_AFTER_THE_RELOAD,
			tabCursor: container2.canonical.lastSync?.lastToBlock,
			state: await readState(container2.state),
			storedStream: await streamHealth(keepStream),
		},
	);
}

// ---------------------------------------------------------------------------
// SCENARIO 5 -- THE ORDER PROBE: the same two folds, listed the other way round.
// ---------------------------------------------------------------------------
// Not a configuration any entry point produces -- it is the PROPERTY PROBE for
// the narrow fix. `Indexer.add`'s own comment says `follows` is asked of the
// durable REGISTRY and not of `this.held`, "which is whatever order the caller
// passed its specs in and does not survive a restart". A narrow fix that falls
// back on "is the fetcher HELD HERE" reads `this.held` MID-OPEN, so it inherits
// exactly that order dependence. Under today's rule both orders give ONE
// fetcher; a rule that answers differently per order has two writers on one
// stream in the second, which is the defect ADR-0071 measured.
async function scenarioTheOrderProbe(): Promise<void> {
	const name = freshName();
	const chain = recordingChain();
	const {keepStream, container} = await firstSession(name, chain);
	await container.add(generationOver(await memoryStore(editedTo(2)), editedTo(2), identityFor(2)));
	theChainMovesOn(chain);

	const mark = chain.mark();
	const reloaded = await durableRegistry(name);
	const container2 = await openIndexer<TestABI, EntityStateView>({
		registry: reloaded.registry,
		provider: chain.provider,
		source: SOURCE,
		config: {keepStream, stream: {finality: FINALITY}},
		// THE EDITED FOLD FIRST, which is the only difference from scenario 3
		generations: [
			generationOver(await memoryStore(editedTo(3)), editedTo(3), identityFor(3)),
			generationOver(await memoryStore(), processor, APP_IDENTITY),
		],
	});
	await driveToTip(container2);
	const reads = chain.readsSince(mark.callMark, mark.rangeMark);
	const fetchers = container2.generations.filter((generation) => !generation.follows);
	report(
		'5. THE ORDER PROBE: the same two folds, listed edited-first',
		fetchers.length === 1 ? 'ONE fetcher, as in scenario 3' : `${fetchers.length} FETCHERS on one stream`,
		{
			followsByGeneration: Object.fromEntries(
				container2.generations.map((generation) => [marker(generation.record.processor), generation.follows]),
			),
			chainReadsByMethod: reads.byMethod,
			getLogsRanges: reads.ranges,
			storedStream: await streamHealth(keepStream),
		},
	);
}

async function main(): Promise<void> {
	console.log('# The reloaded-tab stall, measured\n');
	await scenarioDefaultRegistryReload();
	await scenarioChangedHandlerReload();
	await scenarioReloadAfterPromotion({carriesItsState: false});
	await scenarioReloadAfterPromotion({carriesItsState: true});
	await scenarioTheExistingTestsConfiguration();
	await scenarioUnchangedReload();
	await scenarioTheOrderProbe();
	console.log('\n## Summary\n');
	for (const {name, verdict} of results) {
		console.log(`- ${name}\n  -> ${verdict}`);
	}
}

main().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
