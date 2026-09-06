export * from './IndexerState.js';

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
	ExistingStream,
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
