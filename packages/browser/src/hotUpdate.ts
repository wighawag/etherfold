import {
	sameGeneration,
	type Abi,
	type GenerationId,
	type GenerationRecord,
	type ReconfigureReport,
} from '@etherfold/core';
import {logs} from 'named-logs';
import type {BrowserGenerationSpec} from './IndexerState.js';

const logger = logs('etherfold');

// ---------------------------------------------------------------------------------------------------
// THE THIRD ARRIVAL: a processor HANDED OVER by a dev server, to the tab it is already running in
// ---------------------------------------------------------------------------------------------------
// A developer running an indexer in a browser tab edits a handler. Their bundler
// hot-replaces the module and the indexer goes on folding with the OLD one,
// because nothing connects the two -- so the remedy is a page reload, which
// throws away a warm fold and re-indexes from scratch. That restart is what this
// family of work exists to remove.
//
// The fix needs almost nothing, and understanding WHY is what keeps it that way.
// On a server, reconfiguring means re-READING a processor (off a disk, or out of
// pushed bytes) and defeating a module cache to do it. In a tab the bundler has
// ALREADY done the module replacement and handed the page a new module OBJECT,
// so there are no bytes to send, no URL to instantiate, no cache to defeat, no
// route and no credential -- and no authorisation question at all, because there
// is no remote caller. The tab reconfigures ITSELF with what its own dev server
// just gave it (ADR-0085).
//
// ## THIS PACKAGE DOES NOT SUBSCRIBE TO ANYTHING
//
// There is no reference to `import.meta.hot` here, or anywhere in this package,
// and that is a decision rather than an omission. NOTICING a change is the
// application's job, which is the same rule the server side already follows:
// whatever watches a file stays outside the process, and the endpoint only
// re-reads (`a-change-reaches-a-running-deployment`). HMR is an instance of that
// rule and not an exception to it -- the bundler IS the watcher, and it already
// exists.
//
// Subscribing would put a bundler-specific, dev-only global inside a published
// library, tie this package to one bundler's HMR protocol, and make the library
// the watcher. So this EXPOSES a function an app calls from its own
// `import.meta.hot.accept(...)` handler, with the module that handler receives.
//
// Two things fall out of that, and both are worth stating:
//
//  - a deployment built WITHOUT an HMR-capable bundler is unaffected BY
//    CONSTRUCTION rather than by a guard, since there is nothing here to guard;
//  - and it is a FREE FUNCTION rather than a method on the hook, so an app whose
//    `if (import.meta.hot)` block a production build eliminates does not ship
//    this at all. A method would be reachable from the indexer object and
//    retained in every bundle.
//
// ## REGISTER BESIDE, NEVER TEAR DOWN AND REBUILD
//
// The warm fold is the entire point, so this goes through `addGeneration`: the
// successor is built BESIDE the incumbent, which keeps its own state and goes on
// answering every read while the new fold catches up, and the promotion policy
// decides when the pointer moves. An indexer that briefly answers nothing is
// worse in a tab than on a server, because there is a UI attached to it.
//
// A BURST stays bounded with nothing done here: the `successor` slot holds AT
// MOST ONE, so a newer save REPLACES the pending one rather than landing beside
// it, and the count never climbs towards `BROWSER_GENERATION_CAPS` (ADR-0084).
// A developer saving five times holds the incumbent plus one.
//
// ## A BROKEN SAVE IS THE NORMAL CASE
//
// A processor that throws on evaluation is not an exception in a dev loop -- a
// developer saves mid-edit -- so it is answered as DATA (`failed`) and it must
// leave the running indexer untouched. It does, and the ordering is what makes
// that true rather than a rollback: `Indexer.add` builds the state, builds the
// processor and derives its identity BEFORE it writes a registry record or
// displaces anything, exactly as the server arrival fails before registering
// rather than unwinding afterwards. So the generations, the canonical pointer
// and the fold are where they were, and nothing partial is registered.
// ---------------------------------------------------------------------------------------------------

/**
 * WHAT THIS NEEDS OF AN INDEXER, which is two members of the hook's surface.
 *
 * Narrow on purpose. `createIndexerState(...)` satisfies it, and so does anything
 * else that holds generations and can register one beside them -- but nothing
 * here reaches for a private field, so this function is an ADAPTER in front of a
 * call an application could equally make itself. What it adds is the OUTCOME
 * contract, not access.
 */
export type HotUpdatableIndexer<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined> = {
	/** What this indexer holds RIGHT NOW, which is how `unchanged` is told from `registered`. */
	readonly generations: readonly {readonly record: GenerationRecord}[];
	/** Register a generation BESIDE the live one. The incumbent answers throughout. */
	addGeneration(
		generation: HotUpdateGeneration<ABI, ProcessResultType, ProcessorConfig>,
		processorConfig?: ProcessorConfig,
	): Promise<{readonly record: GenerationRecord}>;
};

/**
 * THE TWO FACTORIES A HOT UPDATE ARRIVES WITH, and deliberately nothing else.
 *
 * `createState` is WHERE THIS GENERATION'S STATE LIVES and it must be its OWN:
 * a successor re-folds the stream from the start into a store of its own while
 * the incumbent goes on writing its own, and two generations sharing one
 * `databaseName` are ONE store by IndexedDB's definition -- they would collide on
 * the rows and on the sync cursor, and the writer claim would demote one of them.
 * The factory is the application's because the storage decision is
 * (ADR-0077).
 *
 * There is NO `processorIdentity`, and its absence is the point. This arrival has
 * no bytes to hash, so the identity is derived from the module's HANDLER SOURCES
 * once `createProcessor` has returned (`moduleProcessorIdentity`). An app that
 * could state one would be back on the author-declared identity ADR-0086 deletes,
 * re-entering through the one door left open -- and it would be silent whenever it
 * was wrong.
 */
export type HotUpdateGeneration<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined> = {
	createState: BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>['createState'];
	createProcessor: BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>['createProcessor'];
};

/**
 * RECONFIGURE THIS TAB WITH THE PROCESSOR ITS OWN DEV SERVER JUST HANDED IT, so
 * a handler edit keeps the warm fold instead of costing a page reload.
 *
 * Call it from the application's own hot-update handler, with the module that
 * handler receives:
 *
 * ```ts
 * if (import.meta.hot) {
 *   import.meta.hot.accept('./processor.js', async (module) => {
 *     if (!module) return;
 *     const next = module.tokenProcessor;
 *     const report = await reconfigureFromHotUpdate(indexer, {
 *       // ITS OWN store: a successor folds beside the incumbent, and two
 *       // generations sharing one database are one store.
 *       createState: async (context) =>
 *         openForWriting(
 *           await createBrowserStateStore(next.entities, {
 *             databaseName: `app-${context.stream}-${++saves}`,
 *           }),
 *         ),
 *       createProcessor: (state) => fromEntityProcessor(next)(state),
 *     });
 *     el('reload').textContent = messageFor(report);
 *   });
 * }
 * ```
 *
 * ## WHAT IT ANSWERS
 *
 * `ReconfigureReport` (`@etherfold/core`), which is the SAME shape the admin
 * re-read route answers, because the arrivals are thin adapters in front of one
 * call and a caller should branch on one contract rather than three (ADR-0085):
 *
 * - **`registered`** -- the handler edit moved the identity, so a successor is
 *   folding beside the incumbent. The incumbent answered every read throughout
 *   and goes on answering until the promotion policy moves the pointer
 *   (`on-catch-up` by default; `immediate` is what a developer iterating usually
 *   wants, and is passed to `createIndexerState`).
 * - **`unchanged`** -- a hot update that genuinely changed nothing, which is RARE
 *   and TRUE. It is a SUCCESS, and the `message` says so plainly rather than
 *   leaving a developer wondering why their save did nothing.
 * - **`failed`** -- the processor could not be built, which in a dev loop is the
 *   ORDINARY case (a save mid-edit). Nothing was registered, and this indexer is
 *   exactly as it was: same generations, same pointer, still folding, still
 *   answering.
 *
 * ## THE `unchanged` A DEVELOPER CAN STILL BE SURPRISED BY
 *
 * The derivation is over handler SOURCE TEXT, so it does not MOVE for a change
 * the text does not carry: an edited helper the handler imports, a changed entity
 * declaration, or behaviour decided by a value the handler captured. Those really
 * did change the fold, and this really will answer `unchanged`, so the message
 * names them and names the way out. There is no `{force}` here and there cannot
 * be: forcing means registering a generation BESIDE one of the same name, and a
 * name is what a generation IS. `indexer.updateProcessor(next, {force: true})` is
 * the in-place verb for that case, and it costs the rebuild this call exists to
 * avoid.
 */
export async function reconfigureFromHotUpdate<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined>(
	indexer: HotUpdatableIndexer<ABI, ProcessResultType, ProcessorConfig>,
	generation: HotUpdateGeneration<ABI, ProcessResultType, ProcessorConfig>,
	processorConfig?: ProcessorConfig,
): Promise<ReconfigureReport> {
	// READ BEFORE, because that is the whole of how `registered` is told from
	// `unchanged`: the container RESOLVES a generation it already holds rather than
	// building a second engine over its state, so the record that comes back is the
	// incumbent's (or the pending successor's) and the list is unchanged.
	const before = indexer.generations.map((held) => held.record);

	let record: GenerationRecord;
	try {
		record = (await indexer.addGeneration(generation, processorConfig)).record;
	} catch (err) {
		// EVERYTHING that can refuse has already happened by the time a record is
		// written, so this leaves the tab folding and answering exactly as it was: a
		// processor that throws on evaluation, a store that could not be opened or
		// claimed, a generation cap that refused.
		const message = err instanceof Error ? err.message : String(err);
		logger.error(`hot update: this tab could not take the processor it was handed, and NOTHING changed`, err);
		return {arrival: 'hot-update', outcome: 'failed', message};
	}

	const arrived: GenerationId = {stream: record.stream, processor: record.processor};
	if (before.some((held) => sameGeneration(held, arrived))) {
		logger.info(
			`hot update: the module handed over names {stream: ${arrived.stream}, processor: ${arrived.processor}}, ` +
				`which this tab is already folding, so NOTHING was registered`,
		);
		return {
			arrival: 'hot-update',
			outcome: 'unchanged',
			generation: arrived,
			message:
				`this hot update handed over a processor naming the generation this tab is already folding (processor ` +
				`${arrived.processor}), so nothing was registered and the warm fold was kept. A module has no bytes to ` +
				`hash, so it is named by a derivation over its HANDLER SOURCES (ADR-0086), and those sources are the ones ` +
				`already running here -- the save changed nothing this derivation can see. If the fold DID change in a ` +
				`way the handler text does not carry (an imported helper you edited, an entity declaration, behaviour a ` +
				`captured value decides), reconfigure the running generation in place with ` +
				`\`updateProcessor(next, {force: true})\`, which costs a rebuild.`,
		};
	}

	logger.info(
		`hot update: registered {stream: ${arrived.stream}, processor: ${arrived.processor}} BESIDE the generation ` +
			`answering reads, which keeps its own state and goes on answering. Nothing was discarded.`,
	);
	return {arrival: 'hot-update', outcome: 'registered', generation: arrived};
}
