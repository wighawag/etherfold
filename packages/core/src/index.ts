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
 * THE GENERATION CONTAINER, which is how an indexer is built.
 *
 * `Indexer` HOLDS generations and points at the one that answers reads;
 * `IndexerGeneration` (exported from `./indexer.js`) is ONE of them. See
 * `container.ts`.
 */
export * from './container.js';
export * from './stream/identity.js';
export * from './stream/fixture.js';
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
/**
 * DEGRADE, NEVER BREAK: the read side of a stream keeper reports ABSENT instead
 * of raising.
 *
 * The load path calls `fetchFrom` and `clear` with no `try`/`catch` above them,
 * so a keeper that raises there makes the indexer permanently unloadable -- for a
 * LOCAL CACHE whose correct recovery is to re-index. Exported because it is the
 * rule a KEEPER follows: `createSegmentedStream` applies it to everything built
 * over the segment port, and a keeper that makes substrate calls of its own
 * outside that helper applies it to those too. `saveNewEvents` deliberately
 * raises through; see the JSDoc for why swallowing it would make a HOLE.
 */
export * from './stream/degrading.js';

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
