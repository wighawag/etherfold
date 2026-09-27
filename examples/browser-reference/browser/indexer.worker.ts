import {createBrowserStateStore, hostIndexerInThisWorker} from '@etherfold/browser';
import {fromEntityProcessor, openForWriting} from '@etherfold/processor-entities';
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
hostIndexerInThisWorker({
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
});
