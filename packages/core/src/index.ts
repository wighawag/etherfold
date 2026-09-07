export * from './types.js';
export * from './errors.js';
export * from './indexer.js';
export * from './streamBuilder.js';
/**
 * THE REORG COUNTERS: what a fold says about the reverts it concluded.
 *
 * Exported from here, rather than from whichever package happens to hold a
 * database, because the WRITER and the READER of these counts are deliberately
 * different deployments (ADR-0050): the process that owns the store writes them
 * through `ReorgRecorder`, and a read tier that owns no store at all reads them
 * back off the database. Two packages have to name one key, and this is the only
 * package both of them already depend on -- and the one that decides what a
 * `ReorgCause` means in the first place.
 */
export * from './reorgCounters.js';
/**
 * THE STORED EMISSION STREAM's write PORT: where a fold's emissions are kept.
 *
 * Exported from here for the same reason the reorg keys are, and with one
 * difference that is the point of it (ADR-0052): a stored stream is a fact about
 * the FOLD, so the port hangs off the receiver every shape passes through, but
 * unlike a count it is written BEFORE the state advances and a failure REFUSES
 * the batch -- because a lost count is a number and a lost emission is a hole.
 */
export * from './emissionStream.js';
export * from './logFetcher.js';
export * from './ingestClient.js';
export * from './directIngestion.js';
export type {RetryPolicy} from './internal/utils/retry.js';
export * from './utils/index.js';
export type {ReorgCause, ReorgDetection} from './internal/engine/utils.js';
/**
 * The INVALIDATION VERDICT, published because a caller outside this package has
 * to act on it.
 *
 * `sourceInvalidationOf` answers, for a reconfigure, whether the stored data
 * still describes the source being run now -- separately for the raw log STREAM
 * and for the STATE folded out of it -- and names the block each half stopped
 * being valid FROM. That answer used to reach a log line and nothing else, so
 * every consumer got the one bit `ReconfigureOutcome.stateDiscarded` collapses
 * it into, and one bit cannot say which half died or from where.
 *
 * The TYPES are exported and the FUNCTION deliberately is not. The verdict is
 * REPORTED, on `ReconfigureOutcome`, for the same reason the discard is: a
 * caller re-deriving the rule from its own hashes gets a second, divergent
 * answer, and it fails in exactly the silent direction the report exists to
 * close.
 *
 * Do not confuse this with `streamDigestOf`. The verdict decides WHETHER
 * anything is invalid; the stream digest decides WHICH stream a result belongs
 * to. An entry appended above the cursor MOVES the digest and is still free, per
 * ADR-0034, so digest inequality is not a verdict and never stands in for one.
 */
export type {InvalidationReason, InvalidationVerdict, SourceInvalidation} from './internal/engine/utils.js';
/**
 * Exported because a HOST has to size things against the finality this stream
 * actually runs with, and there is exactly one implementation of that default
 * (see the function). A host that re-stated `finality` to configure, say, a
 * store's retention floor would be pinning a number that the wire identity is
 * hashed from, so it would keep working right up until the default moved and
 * then silently fork the config hash.
 */
export {resolveStreamConfig} from './internal/engine/utils.js';
/**
 * Exported for the same reason `resolveStreamConfig` is, one step further along:
 * a caller that builds a `ContextIdentifier` or a `WireContext` of its own has
 * to reach the SAME digest the engine stored, and the way to get that wrong is
 * to hash the config a user PASSED instead of the config that RUNS. That is the
 * bug this function exists to make unreachable, and leaving it internal would
 * leave every caller outside this package re-deriving it.
 */
export {streamConfigHashOf} from './internal/engine/utils.js';
/**
 * Exported because a RECEIVING HOST now has to answer "which of the receivers I
 * hold is this batch addressed to".
 *
 * One named indexer can hold SEVERAL live wire contexts at once (a filter-change
 * successor beside the incumbent), the route segment selects the indexer and the
 * batch's own `{source, config}` selects the receiver within it. That comparison
 * is the same rule `StreamBuilder.assertContext` applies, and a host writing its
 * own would be a second rule that can disagree with the one that refuses -- so a
 * batch could select a receiver that then refuses it, or select none where one
 * would have accepted it.
 */
export {sameWireContext} from './internal/engine/utils.js';
/**
 * Exported because NARROWING A CURSOR IS ONE RULE and must have one
 * implementation. The engine narrows per batch; a processor writing a cursor per
 * BLOCK needs the identical truncation, and the way to get it wrong is to lower
 * `lastToBlock` without cutting the unconfirmed window to match, which silently
 * hides every block in between. `@etherfold/processor-entities` re-exports this
 * as `syncedThrough`.
 */
export {cursorSyncedThrough} from './internal/engine/utils.js';
export * from './generation/registry.js';
/**
 * THE GENERATION IDENTITY AS ONE OPAQUE VALUE, exported because it is what a
 * server ADVERTISES on every feed response.
 *
 * The registry keeps `{stream, processor}` as two fields because it KEYS on
 * them; a host reporting "which fold answered you" to a consumer outside
 * etherfold hands over one value instead, so that what a generation is composed
 * of stays changeable. One rendering, here, rather than one per runtime.
 */
export * from './generation/identity.js';
export * from './generation/memory.js';
/**
 * THE PROMOTION POLICY: when the canonical pointer moves on its own.
 *
 * Three values, and `on-catch-up` is the default in EVERY runtime -- there is
 * deliberately no per-runtime and no per-environment selection, because the axis
 * that would choose one is DEVELOPMENT versus PRODUCTION and nothing in a browser
 * build can detect it. Exported because a deployment SAYS which one it wants
 * (`IndexerOptions.promotion`), and because the resolved value is reported back
 * (`Indexer.promotion`) rather than each runtime keeping its own copy of the
 * default.
 */
export * from './generation/promotion.js';
/**
 * THE BOUNDED REBUILD, and the port it reads a stored stream through.
 *
 * A successor on a shared stream catches up by REPLAYING what is already on
 * disk, in chunks a host schedules (ADR-0022) against a checkpoint that is the
 * successor's own sync cursor (ADR-0027) -- which is what makes a processor
 * upgrade cost a local scan instead of a re-index (ADR-0008). Exported because
 * the SOURCE of those chunks is a database this package does not know:
 * `@etherfold/server` implements `ReplaySource` over `_emissions`, and a host
 * hands the result to `ReceivingIndexer`.
 */
export * from './generation/rebuild.js';
/**
 * THE GENERATION CONTAINER, which is how an indexer is built.
 *
 * `Indexer` HOLDS generations and points at the one that answers reads;
 * `IndexerGeneration` (exported from `./indexer.js`) is ONE of them. See
 * `container.ts`.
 */
export * from './container.js';
/**
 * THE GENERATION CONTAINER ON THE RECEIVING SIDE, which is how the server and
 * the CLI hold generations.
 *
 * The chain-free SIBLING of `Indexer`: that one builds `IndexerGeneration`
 * engines, which open `load()` with `eth_chainId`, so the half of a split
 * deployment that hosts the processor could never use it. `ReceivingIndexer`
 * holds `StreamBuilder` receivers instead, and is what turns a changed context
 * from a `processor.clear()` into a SUCCESSOR beside the live generation.
 */
export * from './receivingContainer.js';
export * from './stream/identity.js';
export * from './stream/fixture.js';
/**
 * THE PUBLISHED SEED ENVELOPE, beside the fixture format and NOT sharing its
 * number.
 *
 * A seed is what a third party publishes and a client installs, so the shape,
 * the digest rule it is checked against and the content-hash domain a build pins
 * are all PUBLISHED capability even where the emitting script is ours: the
 * producer lives outside this package (that is what the strip export below is
 * for), and a consumer writing its own installer must be able to reach the same
 * envelope and the same hash without re-deriving either.
 */
export * from './stream/seed.js';
/**
 * THE INSTALL: fetch a published seed, CHECK it, and write it through the keeper
 * seam.
 *
 * Public because it is the whole capability a browser app consumes -- and public
 * only NOW, because until the admission checks landed it verified nothing and an
 * exported "fetched and hoped" would have been worse than no entry point at all.
 *
 * Read its JSDoc before using it, and the trust contract first: the CALLER names
 * the locations and owns that choice (including any runtime override the
 * application accepts), a content hash is OPTIONAL and only an immutable,
 * release-tied artifact can carry a pinned one, and OMISSION is not defended
 * against -- so the named host must be trusted the way the build pipeline is
 * (ADR-0066).
 *
 * Deliberately a NAMED export list rather than a star: `streamSeedPayloadFrom`
 * is the module's own decompression arrangement, which the install's tests and
 * the content-hash domain are pinned against, and publishing it would offer a
 * consumer a tool for a job `installStreamSeed` already does.
 */
export {installStreamSeed} from './stream/seedInstall.js';
export type {
	NotInstalledReason,
	StreamSeedInstallOptions,
	StreamSeedInstallOutcome,
	StreamSeedLocation,
} from './stream/seedInstall.js';
/**
 * THE READ-ONLY STREAM VIEW, which is what makes the one-writer rule structural.
 *
 * Read and write share ONE `ExistingStream`, so a generation handed the stream
 * to fold is handed the thing that also appends. `readOnlyStream` is how a
 * generation that merely READS a stream somebody else indexes is expressed at
 * all -- see `container.ts`'s `add`, which hands one to every follower.
 */
export * from './stream/readOnly.js';
export * from './stream/capture.js';
export * from './stream/segments.js';
// `degradingStream` was exported here and is DELETED (ADR-0068). It turned an
// unreadable substrate into ABSENT at the seam, which is the right answer for the
// load path (it re-indexes) and the wrong one for `installStreamSeed` (it writes),
// and a keeper cannot know which caller it has. A keeper now RAISES; each caller
// applies its own policy -- the generation catches and re-indexes
// (`IndexerGeneration.readStoredStream`), the installer refuses
// (`subtree-unreadable`).
/**
 * THE STRIP, published because something OUTSIDE this package has to apply the
 * SAME one.
 *
 * The keeper seam takes only what the node said (ADR-0060), and the decoded half
 * is a cache re-derived on read, so every writer of a stream reduces a decoded
 * event to a stored one -- and that rule must have ONE implementation. The
 * engine's own writes reach it internally; what could not was a seed PRODUCER or
 * an installer written outside core, and the evidence is committed:
 * `docs/spikes/pin-the-seam-a-published-stream-arrives-through/install.mjs` had
 * to COPY the three-key destructure to write through `saveNewEvents`, which is
 * the duplication ADR-0060 exists to prevent (ADR-0063 names publishing these as
 * a build item).
 *
 * Deliberately NOT justified by the seed LOADER, which lives inside this package
 * and reaches the module directly -- and deliberately only these two. The cursor
 * strip (`storedLastSyncOf`) stays internal: an installer builds the cursor it
 * writes, window and all, rather than stripping the engine's live one, so
 * publishing it would offer an outside caller a tool for a job it does not have.
 *
 * Pinned from a consumer's suite (`@etherfold/browser`'s
 * `storedStripIsPublished.test.ts`), because reachability THROUGH THE ENTRY is
 * not something a test beside the function can see.
 */
export {storedEventOf, storedStreamOf} from './internal/stream/strip.js';

export type {
	Abi,
	AbiConstructor,
	AbiError,
	AbiEvent,
	AbiFallback,
	AbiFunction,
	AbiInternalType,
	AbiItemType,
	AbiParameter,
	AbiParameterKind,
	AbiReceive,
	AbiStateMutability,
	AbiType,
	Address,
	SolidityAddress,
	SolidityArray,
	SolidityArrayWithTuple,
	SolidityArrayWithoutTuple,
	SolidityBool,
	SolidityBytes,
	SolidityFixedArrayRange,
	SolidityFixedArraySizeLookup,
	SolidityFunction,
	SolidityInt,
	SolidityString,
	SolidityTuple,
	TypedData,
	TypedDataDomain,
	TypedDataParameter,
	TypedDataType,
} from 'abitype';

export {Register, DefaultRegister, ResolvedRegister} from 'abitype';

export type {
	AbiParameterToPrimitiveType,
	AbiParametersToPrimitiveTypes,
	AbiTypeToPrimitiveType,
	BaseError,
	ExtractAbiError,
	ExtractAbiErrorNames,
	ExtractAbiErrors,
	ExtractAbiEvent,
	ExtractAbiEventNames,
	ExtractAbiEvents,
	ExtractAbiFunction,
	ExtractAbiFunctionNames,
	ExtractAbiFunctions,
	IsAbi,
	IsTypedData,
	Narrow,
	ParseAbi,
	ParseAbiItem,
	ParseAbiParameter,
	ParseAbiParameters,
	TypedDataToPrimitiveTypes,
} from 'abitype';
