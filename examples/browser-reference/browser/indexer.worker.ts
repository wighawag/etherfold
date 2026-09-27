import {createBrowserStateStore, hostIndexerInThisWorker, keepStreamOnIndexedDB} from '@etherfold/browser';
import {EntityStateView, fromEntityProcessor, openForReading, openForWriting} from '@etherfold/processor-entities';
import {tokenProcessor} from '../src/processor.js';

/**
 * THE WORKER ENTRY: where the indexer RUNS (ADR-0082).
 *
 * Indexing is a fold over every log the contract ever emitted, and it writes to
 * IndexedDB as it goes. On the thread that paints, that is jank, so the fold
 * lives here, in a dedicated worker, and the tab (`main.ts`) holds a PORT to it.
 *
 * This file holds what is CODE, and nothing else: the store factory and the
 * processor. Code cannot be sent in a message, so the processor is IMPORTED here
 * and bundled with the worker. What the tab only knows at run time (the chain the
 * user connected, the contract, the stream config) is handed over when the tab
 * connects, so it is deliberately absent from this call: the host WAITS for a tab
 * to hand it a provider and a source, then starts indexing on its own.
 *
 * `hostIndexerInThisWorker` refuses to run in a document, so a stray
 * `import './indexer.worker.js'` in the tab fails loudly instead of starting a
 * second indexer on the UI thread.
 */
const host = hostIndexerInThisWorker({
	// =====================================================================
	// THE STORE: one line, and the only place a backend is named
	// =====================================================================
	// IndexedDB is the browser default (ADR-0024): versioned rows, and the sync
	// cursor written in the same transaction as the block it describes, so a worker
	// that is ended mid-index reopens consistent.
	//
	// It is a FACTORY and not a value, because an indexer holds any number of
	// GENERATIONS (a stream plus a fold over it), one of which is canonical and
	// answers every read, and each folds into its own state. The host calls this
	// once per generation.
	//
	// KEYED ON THE CONTEXT, which is what keeps each generation's state its own.
	// `context.stream` is the digest of the source (chain, contracts, ABI) and the
	// stream config, so two generations sharing one `databaseName` would be one
	// store by IndexedDB's own definition, and they would collide on the sync
	// cursor as well as on the rows. It is also what lets a redeploy's new source
	// fold BESIDE the live one (`onRedeploy` in `main.ts`) into a store of its own.
	//
	// CLAIMED, because this worker INDEXES: building a store and becoming its
	// writer are two acts, and `openForWriting` is the second one (ADR-0077). The
	// signal bounds the claim, so a store another context holds is reported as a
	// refusal the tab reads on `progress.failure` rather than a wait for ever.
	createState: async (context, {signal}) =>
		openForWriting(
			await createBrowserStateStore(tokenProcessor.entities, {databaseName: `reference-${context.stream}`}),
			{signal},
		),
	createProcessor: (state) => fromEntityProcessor(tokenProcessor)(state),
	// =====================================================================
	// ONE TAB INDEXES, THE OTHERS READ (ADR-0097)
	// =====================================================================
	// With the app open in several tabs, every tab's worker would otherwise fetch
	// the whole chain and all but one would then be refused by the writer claim.
	// The election is ONE Web Lock per app, named here and taken inside this
	// worker: the worker that holds it indexes, and the browser releases it when
	// that worker (or its tab) goes away, crash included.
	//
	// A worker that finds the lock held is built from `openState` instead: the SAME
	// database as `createState`, opened for READING, with no claim and no fetch. It
	// answers its tab's reads from the store the leader writes, reports the leader's
	// progress (`progress.election.role === 'reader'`), and takes over when the lock
	// is released, through `createState` and from the stored cursor.
	tabElection: {name: 'etherfold-browser-reference'},
	openState: async (context) => {
		const store = openForReading(
			await createBrowserStateStore(tokenProcessor.entities, {databaseName: `reference-${context.stream}`}),
		);
		return {store, state: new EntityStateView(store)};
	},
	// =====================================================================
	// THE STREAM KEEPER: the logs, kept, so a new fold need not fetch them again
	// =====================================================================
	// What makes an edited processor a WARM swap (below) rather than a second
	// backfill: a processor change is a new generation over the SAME stream, so
	// with the logs kept it re-folds them from IndexedDB and asks the wallet for
	// nothing. Without a keeper the edit still folds beside the live one, but it
	// fetches the whole history again first.
	keepStream: keepStreamOnIndexedDB('reference-stream'),
});

// =====================================================================
// HOT RELOAD, AXIS ONE: the developer edited the reducer
// =====================================================================
/**
 * The processor is CODE, and code runs where the fold runs, so the edited module
 * arrives HERE: under Vite a module worker is an HMR client of its own, and this
 * accept handler is handed the new module while the page stays where it is
 * (`work/notes/findings/a-module-worker-receives-hmr-under-vite.md`). Nothing
 * crosses the port but the verdict.
 *
 * `host.reconfigureFromHotUpdate` is the main thread's `reconfigureFromHotUpdate`
 * against this worker's indexer: the edit folds as a new GENERATION beside the
 * live one, which goes on answering every read until the edit has caught up;
 * then the canonical pointer moves (`on-catch-up`, the default) and the tab is
 * told to re-read. There is no `version` to bump (ADR-0086): a module has no
 * bytes to hash, so the fold is named by a derivation over its HANDLER SOURCES,
 * taken over the processor built here.
 *
 * What it answered reaches the tab on the progress push (`progress.hotUpdate`),
 * because the tab did not make this call: `registered`, `unchanged` (a save that
 * changed nothing the derivation sees) or `failed` (a save mid-edit, which left
 * everything as it was).
 *
 * THE SUCCESSOR'S STORE IS ITS OWN, and that is the line to get right when you
 * copy this. It folds while the incumbent goes on writing its own rows, and two
 * generations sharing one `databaseName` are ONE store, so each save gets a name
 * of its own.
 *
 * A production build drops this whole block with the `if`. A save the handler
 * text does not carry (an imported helper, an entity declaration) is `unchanged`,
 * because it names the fold already running; see `src/processor.ts`.
 */
if (import.meta.hot) {
	let saves = 0;
	import.meta.hot.accept('../src/processor.js', (module) => {
		if (!module) return;
		const next = module.tokenProcessor as typeof tokenProcessor;
		void host.reconfigureFromHotUpdate({
			createState: async (context, {signal}) =>
				openForWriting(
					await createBrowserStateStore(next.entities, {databaseName: `reference-${context.stream}-save-${++saves}`}),
					{signal},
				),
			createProcessor: (state) => fromEntityProcessor(next)(state),
		});
	});
}
