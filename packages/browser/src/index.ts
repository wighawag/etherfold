export * from './IndexerState.js';

/**
 * LOSING IS A DEMOTION: the one function a writer calls when it stops being one,
 * whether the store refused it or a lease was lost. `isStoreWriterChanged` is
 * deliberately NOT published: the demotion is what this package offers, and a
 * second way to ASK the question invites a second answer to it.
 */
export {demoteToReader, type DemotableWriter, type Demotion, type DemotionReason} from './demotion.js';

/**
 * WHERE THE INDEXER RUNS, and what a tab holds when it is not here (ADR-0082).
 *
 * A **host** owns a **container** and drives it; a tab holds a **port** to it.
 * `hostIndexerInThisWorker` is what an app's five-line worker entry point calls,
 * and `connectToIndexerHost(dedicatedWorkerHost(worker))` is what its tab calls.
 */
export * from './host/index.js';

export {simple_hash} from '@etherfold/core';
/**
 * Re-exported because this package's own public signatures NAME it: `createState`
 * is handed a `GenerationContext`, and a caller that cannot name the type cannot
 * write the factory with an explicit annotation. It is also the value the state
 * must be keyed on -- two generations sharing one storage location are one store
 * -- so it is exactly the type a consumer reaches for.
 */
export type {GenerationContext} from '@etherfold/core';
// where a browser deployment's state lives (the storage seam)
export * from './storage/state-store/BrowserStateStore.js';
export * from './storage/keyval.js';
export * from './storage/stream/OnIndexedDB.js';
// which generations this indexer holds, and which one answers reads
export * from './storage/generation/OnIndexedDB.js';

// convenience : export type from @etherfold/core and incidently from abitype

// TODO
// typescript 5 export type * from '@etherfold/core';
export type {
	AllContractData,
	ContractData,
	IndexingSource,
	// ONE generation: one stream, one processor, one state. An indexer HOLDS these
	// and points at the one that answers reads; `createIndexerState` opens that
	// container, so this type is here for a caller that names the engine (a
	// `createIndexer` factory, a spy) rather than one that builds an indexer.
	IndexerGeneration,
	EventBlock,
	EventProcessor,
	StreamFetcher,
	ProvidedIndexerConfig,
	UsedIndexerConfig,
	UsedStreamConfig,
	ProvidedStreamConfig,
	LastSync,
	LoadingState,
	LogEvent,
	LogParseConfig,
	// What an ARGUMENT FILTER is written in: a caller that cannot name a rule
	// cannot annotate one (ADR-0062).
	FilterRule,
	ArgumentFilter,
	ExistingStream,
	// WHERE a published stream seed is fetched from, and WHY one was not installed.
	// This package's own public surface names both -- `createIndexerState`'s `seed`
	// option takes the locations, and `SyncingState.streamSeed` publishes the
	// reason -- so an app that renders a refusal can annotate what it is handed.
	// The install itself is `installStreamSeed` in `@etherfold/core`, which is
	// where its trust contract is stated and where it stays: an application may
	// drive it directly, and a second entry point here would be a second place for
	// that contract to be read from.
	NotInstalledReason,
	StreamSeedLocation,
	// What the KEEPER seam speaks, both halves of it: a browser keeper is written
	// against these, and a caller that cannot name them cannot annotate one.
	StoredLogEvent,
	StoredLastSync,
	StoredEventBlock,
	TxInclusionQuery,
	TxInclusionStatus,
	TxInclusionBasis,
	TxInclusionVerdict,
} from '@etherfold/core';
