import type {Abi, AbiEvent} from 'abitype';
import type {EIP1193DATA, EIP1193Log, EIP1193QUANTITY} from 'eip-1193';
import type {DecodeEventLogReturnType} from 'viem';
import type {NumberifiedLog} from './internal/decoding/LogEventFetcher.js';
import type {LogFetcherConfig} from './internal/engine/RangeLogFetcher.js';
import type {JSONObject} from './internal/types.js';

export type EventBlock<ABI extends Abi> = {
	number: number;
	hash: string;
	events: LogEvent<ABI>[]; //this could be replacec by start: number;end: number but we would need access to the old coreresponding events
};

export type LogParsedData<ABI extends Abi> = DecodeEventLogReturnType<ABI>;
export type BaseLogEvent<Extra extends JSONObject | undefined = undefined> = NumberifiedLog & {
	removedStreamID?: number;
} & {
	extra: Extra;
	blockTimestamp?: number;
};
export type ParsedLogEvent<ABI extends Abi, Extra extends JSONObject | undefined = undefined> = BaseLogEvent<Extra> &
	LogParsedData<ABI>;
export type LogEventWithParsingFailure<Extra extends JSONObject | undefined = undefined> = BaseLogEvent<Extra> & {
	decodeError: string;
};
export type LogEvent<ABI extends Abi, Extra extends JSONObject | undefined = undefined> =
	| ParsedLogEvent<ABI, Extra>
	| LogEventWithParsingFailure<Extra>;

/**
 * ONE entry of the STORED STREAM: the raw log the node reported plus the reorg
 * flag the indexer derived, and NOTHING an ABI made of those bytes.
 *
 * `args` / `eventName` are what SOME ABI made of a log and `decodeError` is what
 * happened when one could not, so both are a CACHE: `LogEventFetcher.reparse`
 * re-derives them on read against the source running now, unconditionally,
 * because a stream cannot say per event which ABI decoded it (ADR-0034). What is
 * stored is therefore the half that is true forever, and the three `?: never`
 * clauses are what make the type SAY so rather than merely omit it.
 *
 * A raw-only event is deliberately NOT a `LogEvent`: that is the union of a
 * decode that SUCCEEDED (`ParsedLogEvent`) and one that FAILED
 * (`LogEventWithParsingFailure`), and an event carrying neither belongs to
 * neither. It is equally not `BaseLogEvent`, which is the SUPERTYPE both of
 * those extend and which therefore enforces nothing: a decoded `LogEvent[]` is
 * assignable to a `BaseLogEvent[]` -- that is what a supertype is -- and
 * excess-property checks fire only on fresh object literals, so a keeper
 * declared over the supertype could receive, hold and persist decoded events in
 * silence.
 *
 * **It governs WRITES, from here on.** Segments written before it existed still
 * hold `args` and `eventName` forever and no migration rewrites them; a READ
 * tolerates that half and ignores it, because the re-decode drops and re-derives
 * it anyway. So this describes what goes IN, not what is guaranteed to be on
 * disk. That rule, and the price of it, is ADR-0060.
 *
 * **The one hole, stated rather than hidden**: an event whose STATIC type has
 * already been widened to `BaseLogEvent` still assigns here, because nothing is
 * left for the `?: never` clauses to catch. The guard is at the SEAM -- what a
 * keeper declares it takes and hands back -- and not through a widening, so a
 * value laundered through the supertype defeats it.
 *
 * **Not `EmittedLog`, and both survive with this relation.** They speak
 * different seams and only one of them refuses anything. `EmittedLog` (a few
 * lines below) is the SERVER's emission-row shape (ADR-0006): deliberately free
 * of an ABI type parameter, and PERMISSIVE -- a plain `NumberifiedLog` alias
 * that does not PROMISE the decoded half but does not refuse it either, and that
 * can express neither `extra` nor `removedStreamID`. This one is what a
 * `keepStream` keeper persists, carries both of those, and REFUSES a decoded
 * event. Neither substitutes for the other, and `EmittedLog` is not to be
 * re-pointed at this.
 *
 * Pinned by `test/storedLogEvent.test.ts`, whose refusals are `@ts-expect-error`
 * comments `pnpm typecheck` evaluates.
 */
export type StoredLogEvent<Extra extends JSONObject | undefined = undefined> = BaseLogEvent<Extra> & {
	args?: never;
	eventName?: never;
	decodeError?: never;
};

/**
 * ONE BLOCK of the unconfirmed reorg window, as the STREAM seam speaks it: the
 * block's identity plus the events the node reported in it, raw.
 *
 * `EventBlock` with its events narrowed to what is stored, and with no ABI type
 * parameter left -- the ABI is what the decoded half was made under, so a shape
 * that carries none needs none.
 */
export type StoredEventBlock = {
	number: number;
	hash: string;
	events: StoredLogEvent[];
};

/**
 * THE CURSOR AS THE STREAM SEAM SPEAKS IT: the same three block numbers and the
 * same context as a `LastSync`, with the reorg window's events narrowed to what
 * the node said.
 *
 * It exists so that the compile-time refusal covers BOTH halves of what a keeper
 * is handed. Core strips the window on the way into `saveNewEvents` exactly as
 * it strips the batch (`storedLastSyncOf`), so a seam that still declared
 * `LastSync<ABI>` there would be promising an implementor a decoded half that is
 * `undefined` at runtime -- a type that lies about the value, which is a worse
 * hole than the one this spec set out to close.
 *
 * Deliberately a SEPARATE type and NOT a narrowing of `LastSync`, which the
 * processor seam, the load path, the state keepers and the wire all speak. What
 * a stream keeper is handed is the one place the window is raw; re-meaning the
 * shared cursor for everybody else would be a far larger claim than this one,
 * and this type is used by `StreamFetcher` and `StreamSaver` and by nothing
 * else.
 *
 * The RETURN side costs a keeper nothing: no keeper stores a window at all
 * (ADR-0035, as amended -- the stream's copy is read by nobody and
 * `generateStreamFromReplay` rebuilds it by walking the events), so every
 * shipped implementation returns an empty one.
 *
 * The choice between this and leaving the window typed `LastSync<ABI>`, and what
 * each costs, is ADR-0060.
 */
export type StoredLastSync = {
	context: ContextIdentifier;
	latestBlock: number;
	lastFromBlock: number;
	lastToBlock: number;
	unconfirmedBlocks: StoredEventBlock[];
};

/**
 * ONE entry of the EMISSION STREAM, as a host that STORES it sees it: the raw
 * log the node reported, plus the verdict the fold reached about it (`removed`).
 *
 * This is `LogEvent` with the ABI taken away, and taking it away is the point. A
 * host storing the stream (`@etherfold/server`'s emission table, ADR-0006) reads
 * the address, the topics, the data and the block coordinates -- every one of
 * which is a fact about the LOG rather than about the ABI it happened to be
 * decoded against. Typing the outcome with this rather than `LogEvent<ABI>` is
 * what keeps that host free of an ABI type parameter it has no way to know, the
 * same reason `UntypedWireBatch` exists on the way in.
 *
 * It deliberately does NOT promise the decoded half. `args` is what SOME ABI
 * made of those bytes and is re-derived by `LogEventFetcher.reparse` against the
 * source running now, so a store that persisted it would be persisting an
 * opinion; what survives a decode-only change is exactly what is here.
 */
export type EmittedLog = NumberifiedLog;

export type EventProcessor<ABI extends Abi, ProcessResultType = void> = {
	getVersionHash(): string;
	/**
	 * A hash of the processor's own handler SOURCE, or `undefined` when it cannot
	 * be derived.
	 *
	 * Advisory, and deliberately NOT part of `getVersionHash()`: it moves when a
	 * minifier or a transpiler re-emits the same behaviour differently, and
	 * folding that into the version hash would force a full state rebuild on a
	 * deploy that changed no logic. The core only compares it, reports when it
	 * differs at an UNCHANGED version hash (the "forgot to bump" case), and never
	 * discards state because of it.
	 *
	 * REQUIRED, unlike the value it returns. An optional method is a hole with a
	 * polite name: an implementation that simply never wrote one would lose drift
	 * detection silently, and a WRAPPER (a cache, a decorator) that forgot to
	 * forward it would take the wrapped processor's detection down with it,
	 * invisibly. Being required makes both a compile error instead. Returning
	 * `undefined` is still allowed, because "cannot tell" is a real answer (a
	 * processor whose handlers are all bound or proxied has no readable source),
	 * and the core reads it as "do not report" rather than as "unchanged".
	 */
	getCodeFingerprint(): string | undefined;
	load: (
		source: IndexingSource<ABI>,
		streamConfig: UsedStreamConfig,
	) => Promise<{state: ProcessResultType; lastSync: LastSync<ABI>} | undefined>;
	process: (eventStream: LogEvent<ABI>[], lastSync: LastSync<ABI>) => Promise<ProcessResultType>;
	reset: () => Promise<void>;
	clear: () => Promise<void>;
};

export type IncludedEIP1193Log = EIP1193Log & {
	blockNumber: EIP1193DATA;
	logIndex: EIP1193DATA;
	blockHash: EIP1193DATA;
	transactionIndex: EIP1193QUANTITY;
	transactionHash: EIP1193DATA;
};

/**
 * ONE entry of the source identity a `ContextIdentifier` carries, and the unit
 * invalidation is decided on.
 *
 * There is one entry per (contract, event, live range) plus a leading SKELETON
 * entry at block 0 for everything an ABI cannot describe (the chain id, the
 * genesis hash, each contract's address and `startBlock`). A non-event ABI
 * member has no entry, because a function is not indexed, does not enter the
 * fetch filter and cannot change what a log decodes to.
 *
 * The two digests exist because the fetch and the fold do not depend on the
 * same thing, and one verdict over one digest could not say so.
 *
 * PERSISTED, so every field but `startBlock` and `hash` is optional and absence
 * means "written before this field existed" rather than "changed".
 */
export type SourceHashEntry = {
	/** The lowest block this entry describes, and therefore the block it invalidates FROM. */
	startBlock: number;
	/**
	 * What the STATE depends on: the address, the canonical signature, the
	 * DECODING SHAPE and the live range. The state is a fold over decoded events,
	 * so it dies whenever any of those moved.
	 */
	hash: string;
	/**
	 * What the STREAM depends on: the address, the `topic0` and the live range,
	 * and nothing about names or parameter shapes. Raw logs are fetched under a
	 * topic-and-address filter, so they survive a change this digest cannot see.
	 *
	 * Absent on a context persisted before the split, which reads as "this entry
	 * cannot answer about the filter" and falls back to the state verdict.
	 */
	streamHash?: string;
	/**
	 * The MIGRATION BRIDGE, on the block-0 entry only: the whole-source digest the
	 * pre-per-event code persisted as its single entry.
	 *
	 * It is the one thing that lets a context written by that code be compared at
	 * all, since a whole-source digest commits to bytes no per-event entry
	 * reproduces. Without it every existing deployment would re-index on upgrade,
	 * which is precisely the cost per-event hashing removes.
	 */
	legacyHash?: string;
};

export type ContextIdentifier = {
	source: SourceHashEntry[];
	config: string;
	processor: string;
	/**
	 * The `getCodeFingerprint()` of the processor that computed this state.
	 *
	 * OPTIONAL, and it must stay optional: every cursor persisted before
	 * fingerprints existed lacks the field, so absence has to mean "unknown, do
	 * not report" rather than "drifted". Otherwise every existing deployment
	 * reports drift once on upgrade and the report stops being believed.
	 *
	 * It rides inside `ContextIdentifier` rather than beside it because
	 * `lastSync` is the one thing EVERY persistence path round-trips whole (the
	 * fs / localStorage / IndexedDB keepers, the CLI snapshot envelope, and the
	 * sync cursor a `StateStore` keeps behind the storage seam). It is NOT part of
	 * `sourceInvalidationOf`, which decides whether to discard state.
	 */
	processorFingerprint?: string;
};

/**
 * What the core reports when a processor's declared version says "unchanged"
 * and its code says otherwise. Advisory: the state is still adopted, unless
 * `strictProcessorDrift` is set.
 */
export type ProcessorDriftReport = {
	/** The version hash both sides agree on, which is what makes this drift rather than an upgrade. */
	processorHash: string;
	/** The fingerprint of the code that computed the persisted state. */
	storedFingerprint: string;
	/** The fingerprint of the code loaded now. */
	currentFingerprint: string;
	/** The same thing in words, as logged. */
	message: string;
};

export type LastSync<ABI extends Abi> = {
	context: ContextIdentifier;
	latestBlock: number;
	lastFromBlock: number;
	lastToBlock: number;
	unconfirmedBlocks: EventBlock<ABI>[];
};

/**
 * WHICH indexer a batch of logs is for, as the sender can assert it.
 *
 * Two of `ContextIdentifier`'s three identities and deliberately not the third:
 * a log-fetcher has no idea which processor version runs on the receiving side,
 * so `processor` is the receiver's own business (ADR-0004). The two that ARE
 * here are the ones both halves compute from the same declarations, which is
 * what makes comparing them a real check rather than an echo.
 */
export type WireContext = {
	source: SourceHashEntry[];
	config: string;
};

/**
 * What crosses the wire from a log-fetcher to an indexer-server: a contiguous
 * block range and every log in it.
 *
 * ## `logs` are DECODED events, not the JSON-RPC shape
 *
 * ADR-0004 calls them "raw logs", and that means raw as opposed to the
 * reorg-annotated emission stream a processor consumes: no `removed` markers,
 * no retractions, nothing the receiver has to derive. It does NOT mean the
 * undecoded `eth_getLogs` result. The sender decodes (`captureStream` is exactly
 * that job) and ships `LogEvent`s, for two reasons: the receiver's primitive
 * (`generateStreamToAppend`) takes decoded events, and the sender already holds
 * the ABI it needs, since a source IS its contracts. The cost is a larger
 * payload, because `args` restates what `data` and `topics` already encode;
 * `data` and `topics` are still carried, so the receiver can re-derive or store
 * the original bytes (ADR-0006 needs them).
 *
 * This is the whole envelope of ADR-0004 and it is deliberately small. What is
 * NOT here is as load-bearing as what is:
 *
 * - no `complete` flag, because completeness is an invariant (see
 *   `InvalidBatchError`);
 * - no `removed` markers and no `unconfirmedBlocks`, because the receiver
 *   derives every reorg itself, so that logic exists in exactly one place;
 * - no cursor from the sender, because the receiver owns the cursor.
 */
export type WireBatch<ABI extends Abi> = {
	context: WireContext;
	fromBlock: number;
	toBlock: number;
	/** The chain tip the sender observed, which is what bounds the unconfirmed window. */
	latestBlock: number;
	logs: LogEvent<ABI>[];
};

/**
 * The same envelope, for a host that transports it without decoding it.
 *
 * An HTTP route reads a body, hands it to the receiver and writes a status code;
 * it never looks inside a log. Typing it against this instead of `WireBatch<ABI>`
 * is what keeps a server package from having to be generic over the ABI of the
 * processor it happens to host, which it has no way to know and no use for.
 */
export type UntypedWireBatch = Omit<WireBatch<Abi>, 'logs'> & {logs: unknown[]};

/**
 * An ABI event entry that also declares the BLOCK RANGE its event is live over.
 *
 * An event is not a fact about a contract, it is a fact about a contract over a
 * range of blocks. Declaring that range is what lets an upgrade APPEND an entry
 * instead of moving one whole-source hash: an entry that starts above the sync
 * cursor describes blocks nothing has indexed yet, so the state and the cached
 * event stream both survive it.
 *
 * It is also what lets a fetched block range ask only for the events that can
 * occur in it: below a `firstBlock`, or above a `lastBlock`, that event's
 * `topic0` is not in the request at all, and under argument filters that is a
 * whole `eth_getLogs` round trip the range no longer makes. It is never
 * consulted to DECODE a log, which is by `topic0` alone (ADR-0033).
 *
 * ## Both bounds are INCLUSIVE, and both directions of error are asymmetric
 *
 * For an upgrade at block `b`, the correct declaration is `A.lastBlock = b`
 * TOGETHER WITH `B.firstBlock = b` -- the SAME number on both -- because a
 * transaction earlier in block `b` still fires the old event while the upgrade
 * transaction later in that block starts the new one. That one-block overlap is
 * CORRECT and is deliberately not normalised away. An exclusive end would make
 * the correct declaration read `b + 1`, and the obvious thing to type would
 * silently drop every pre-upgrade log in block `b`.
 *
 * Which way to err, because the indexer cannot check either number for you:
 *
 * - **`firstBlock` too EARLY is safe**; too LATE loses logs undetectably. The
 *   blocks between the real first occurrence and the declared one are indexed
 *   without that event in the filter, so afterwards nothing distinguishes "the
 *   chain had none" from "we never asked". For a proxy deployment the
 *   implementation's own deploy block is naturally safe: an implementation
 *   cannot emit before it exists.
 * - **`lastBlock` too LATE is safe**; too EARLY loses logs the same way, and for
 *   the same reason. Omit it unless you know the event stopped.
 *
 * A `lastBlock` is an ASSERTION the indexer can act on and can never verify.
 * The only thing it does verify is coverage: a GAP between two ranges of one
 * event is refused at construction, because a hole is a span nobody requests.
 */
export type RangedAbiEvent = AbiEvent & {
	/**
	 * Inclusive. The earliest block this event can appear in.
	 *
	 * Omitted, the event is live from its contract's `startBlock` for
	 * INVALIDATION, and from block 0 for the FETCH FILTER, which narrows on
	 * nothing but a declaration: `startBlock` is a per-contract "do not look
	 * before here", so an event nobody gave a range must never leave a request
	 * because of it.
	 */
	readonly firstBlock?: number;
	/** Inclusive. The latest block this event can appear in; omit for open-ended. */
	readonly lastBlock?: number;
};

/**
 * An ABI whose event entries MAY declare the block range they are live over.
 *
 * Write `as const satisfies RangedAbi` instead of `satisfies Abi` when an entry
 * carries `firstBlock`/`lastBlock`; the result is still an `Abi` everywhere
 * else, so nothing downstream changes. An ABI that declares no range at all
 * needs nothing: `satisfies Abi` keeps working and the indexer behaves exactly
 * as it did before ranges existed.
 */
export type RangedAbi = readonly (Abi[number] | RangedAbiEvent)[];

export type ContractData<ABI extends Abi> = {
	readonly abi: ABI;
	readonly address: `0x${string}`;
	/**
	 * Do not look for this contract's logs before here.
	 *
	 * NOT a per-event range, and deliberately a different field from
	 * `RangedAbiEvent.firstBlock`: this one is MINIMISED across contracts by
	 * `defaultFromBlockOf` to decide the first block ever fetched, so a per-event
	 * range sharing its name or its shape would drag that floor down.
	 */
	readonly startBlock?: number;
};

export type AllContractData<ABI extends Abi> = {
	readonly abi: ABI;
	readonly startBlock?: number;
};

export type IndexingSource<ABI extends Abi> = {
	readonly contracts: readonly ContractData<ABI>[] | AllContractData<ABI>;
	readonly chainId: string;
	readonly genesisHash?: `0x${string}`;
};

/**
 * WHAT A KEEPER HANDS BACK: a VERDICT, because there is more than one way for a
 * read to come back without a stream and they are not the same thing (ADR-0069).
 *
 * This was `{lastSync, eventStream} | undefined`, and the `undefined` carried
 * five meanings across two implementations with OPPOSITE contracts behind it:
 * nothing stored; damage the keeper had just DESTROYED; a stream that is fine but
 * does not reach back to the block asked for, also destroyed; and, on the SQL
 * reader, the same shapes reported with nothing deleted at all. A caller could
 * not tell "there is nothing here" from "there was something here and it is gone
 * now", which is exactly what an installer has to know before it writes.
 *
 * So a keeper now REPORTS and does not REPAIR. Each variant says what was found
 * and nothing is cleared on any of them; the caller that wants the repair asks
 * for it (`IndexerGeneration.readStoredStream` clears and re-indexes, which is
 * what it always did), and the caller that must not have one does not get it
 * silently (a FOLLOWER reads through `readOnlyStream`, whose `clear` is a no-op,
 * so reading a writer's stream can no longer delete it).
 *
 * Both halves are STORED shapes and neither may carry a decoded event. `args` /
 * `eventName` are what SOME ABI made of those bytes and `decodeError` is what
 * happened when one could not, so all three are a cache the engine re-derives on
 * read against the source running now (`LogEventFetcher.reparse`, ADR-0034); a
 * keeper that held them would be handing back an opinion it cannot date.
 *
 * READS TOLERATE what WRITES no longer produce. Bytes written before this seam
 * narrowed still carry a decoded half and are still served: a keeper reading its
 * own storage back asserts the stored type at that boundary (it cannot prove the
 * shape of a row or a record to the compiler either way), the re-decode drops
 * and re-derives the half regardless, and no migration rewrites anything.
 *
 * The `lastSync` window is `StoredLastSync`'s and is expected to be EMPTY: no
 * keeper stores one (ADR-0035, as amended).
 *
 * ADR-0060 records what this type governs and why the cursor has a variant here.
 */
export type StreamRead =
	/** A usable stream from the block asked for, with the cursor that describes it. */
	| {readonly status: 'stream'; readonly lastSync: StoredLastSync; readonly eventStream: StoredLogEvent[]}
	/** Nothing is stored here. The ONLY answer an installer may read as permission to write. */
	| {readonly status: 'absent'}
	/**
	 * Something is stored and it does not hold together: a gap in the ordinals, a
	 * segment that does not parse, segments with no cursor record, a cursor whose
	 * segment count is wrong. `reason` is the keeper's own words, for the caller to
	 * log when it decides what to do.
	 *
	 * NOT cleared. Repairing it is the caller's call, and the repair is a `clear`.
	 */
	| {readonly status: 'inconsistent'; readonly reason: string}
	/**
	 * A perfectly good stream that simply starts ABOVE the block asked for.
	 *
	 * Deliberately not folded into `inconsistent`: nothing is wrong with it, and a
	 * caller asking from a higher block would be served. It is separate because the
	 * whole point of this type is to stop conflating answers that differ.
	 */
	| {readonly status: 'does-not-reach-back'; readonly startBlock: number};

export type StreamFetcher<ABI extends Abi> = (source: IndexingSource<ABI>, fromBlock: number) => Promise<StreamRead>;
/**
 * A keeper that DECLINED the batch: it was not written, and writing it would
 * have left a hole behind a cursor claiming to cover it.
 *
 * A decline is not a failure and must not be retried -- the batch is wrong for
 * this stream, not the write -- but it is emphatically not a success either, and
 * that is the distinction this return value exists to carry. A keeper that
 * declined by returning `undefined` was indistinguishable from one that wrote,
 * so the indexer recorded the stream as covering blocks it never received, and
 * every later decline was invisible too because the cursor it compares against
 * had already moved.
 */
export type StreamSaveDeclined = 'declined';

/**
 * WHAT A KEEPER IS HANDED: a batch to append, and the cursor that then describes
 * the stream.
 *
 * Both halves arrive STRIPPED, and the types are what SAY so rather than a rule
 * each implementation has to remember. Core strips ONCE, on the way in
 * (`storedEventOf` / `storedLastSyncOf`), because this seam is
 * third-party-implementable with several implementations already and a rule
 * spread across them would drift.
 *
 * The window inside `lastSync` is stripped too and is not read back as events by
 * anything: the load path takes a stored cursor for its three block numbers and
 * its context alone, the live reorg window is the indexer's in-memory one, and a
 * transaction-inclusion question is answered from the STATE keeper's copy. A
 * keeper is free to drop the window entirely, and the shipped ones do.
 *
 * ADR-0060 records what this type governs and why the cursor has a variant here.
 */
export type StreamSaver<ABI extends Abi> = (
	source: IndexingSource<ABI>,
	stream: {
		lastSync: StoredLastSync;
		eventStream: StoredLogEvent[];
	},
) => Promise<void | StreamSaveDeclined>;
export type StreamClearer<ABI extends Abi> = (source: IndexingSource<ABI>) => Promise<void>;

export type UsedStreamConfig = ProvidedStreamConfig & {
	finality: number;
};

export type ProvidedStreamConfig = {
	finality?: number;
	parse?: LogParseConfig;
};

export type FetchConfig = Omit<LogFetcherConfig, 'filters'>;

export type ProvidedIndexerConfig<ABI extends Abi> = {
	fetch?: FetchConfig;
	stream?: ProvidedStreamConfig;
	providerSupportsETHBatch?: boolean;
	feedBatchSize?: number;
	keepStream?: ExistingStream<ABI>;
	/**
	 * What the engine does about a cached-stream write that FAILS.
	 *
	 * A failed write means the batch is NOT processed and the cursor does not
	 * move, so the next cycle re-derives the same delta and tries again: nothing
	 * is lost and the stream cannot fall behind the state. But a store can be
	 * PERMANENTLY unwritable (a quota, a private window, an evicted database), and
	 * retrying forever would leave an application showing stale data indefinitely
	 * because an OPTIONAL cache failed. So the retry is bounded and paced, and
	 * both numbers are here rather than in `stream` because `stream` is HASHED
	 * into the wire and cache identity -- a deployment that tuned its retry must
	 * not thereby invalidate its stream.
	 */
	streamWriteRetry?: {
		/**
		 * Consecutive failed writes before the cache is FROZEN and indexing carries
		 * on without it. Defaults to 3.
		 */
		maxConsecutiveFailures?: number;
		/**
		 * Seconds to wait after a failed write, so a driver looping to the tip
		 * cannot spin hot on a store that is refusing. Defaults to 1.
		 */
		delaySeconds?: number;
	};
	skipGenesisCheck?: boolean;
	/**
	 * Turn a processor-drift report into a refusal to start (`load()` rejects).
	 *
	 * Off by default, because the fingerprint has real false positives: a
	 * re-minification changes handler source without changing behaviour. Fail
	 * loud by default, fail stop by choice. It sits here, next to
	 * `skipGenesisCheck`, because it is the same kind of thing: a load-time
	 * safety gate belonging to the deployment, not to the processor an author
	 * ships.
	 */
	strictProcessorDrift?: boolean;
	logLevel?: number;
};

export type UsedIndexerConfig<ABI extends Abi> = ProvidedIndexerConfig<ABI> & {
	stream: UsedStreamConfig;
	feedBatchSize: number;
};

export type ExistingStream<ABI extends Abi> = {
	fetchFrom: StreamFetcher<ABI>;
	saveNewEvents: StreamSaver<ABI>;
	clear: StreamClearer<ABI>;
	/**
	 * The other half of the stream's IDENTITY, handed over by the indexer.
	 *
	 * A stream is identified by its FETCH FILTER plus its stream CONFIG
	 * (`streamDigestOf`), and only the first of those travels with every call:
	 * the `source` is an argument, the config is not. A keeper that ADDRESSES a
	 * stream by that identity therefore has to be told, and the indexer is the
	 * one place that holds the RESOLVED config -- so it hands it over in
	 * `reinit`, before any other call and again on every reconfigure, rather than
	 * an application repeating it at the keeper's construction site where it
	 * could silently disagree with the config the indexer is actually running.
	 *
	 * OPTIONAL because a keeper that addresses NOTHING has no use for it: one that
	 * holds exactly one stream serves it whatever it is asked for.
	 */
	setStreamConfig?: (streamConfig: UsedStreamConfig) => void;
};

/**
 * ONE conjunction of INDEXED-ARGUMENT constraints, positionally, starting at
 * `topics[1]`.
 *
 * Slot `i` of this array constrains the log's `topics[i + 1]`, which is the
 * `i`-th INDEXED argument of the event. A single topic must equal it, an array
 * is an OR list within that slot, and `null` is the WILDCARD `eth_getLogs`
 * defines: match anything here. The wildcard is not decoration, it is the only
 * way to constrain the second or later indexed argument at all, so "Transfers TO
 * me" is `[null, meAsATopic]` and is inexpressible without it.
 *
 * Positional and never named, deliberately: argument NAMES are not canonical
 * across real ABIs (WETH9, the most deployed ERC-20 there is, declares
 * `Transfer(address indexed src, address indexed dst, uint wad)`), and a name is
 * exactly the part of an ABI a recompilation can move without moving `topic0`.
 * See ADR-0062.
 *
 * A value is a 32-byte topic word, so an address must be left-padded to 32 bytes
 * before it goes in here; this type does not do that for you.
 */
export type ArgumentFilter = (`0x${string}` | `0x${string}`[] | null)[];

/**
 * ONE argument filter, and WHAT it restricts: a (contract, `topic0`) pair rather
 * than a `topic0`.
 *
 * The rule that makes the shape work is that AN ADDRESS NOBODY FILTERED IS NOT
 * FILTERED. A filtered `topic0` used to be removed from the shared request
 * outright, so filtering one contract's `Transfer` silently unfiltered nobody
 * and unrequested everybody else's; now the addresses a rule does not reach are
 * collected into a LEFTOVER request that asks for that `topic0` unfiltered. See
 * ADR-0062.
 */
export type FilterRule = {
	/**
	 * WHICH event, as a NAME or as a canonical SIGNATURE.
	 *
	 * ONE field for both, discriminated on `(`: a Solidity event name is an
	 * identifier and can never contain one, and a canonical signature always does.
	 * A NAME covers every `topic0` it declares (both sides of an upgrade); a
	 * SIGNATURE covers exactly one. The signature comparison is STRICT byte
	 * equality with viem's `toEventSignature`, which writes no spaces and no
	 * aliases: `Transfer(address,address,uint256)` and nothing else. A near miss is
	 * REFUSED at construction, naming the canonical signatures that do exist.
	 */
	event: string;
	/**
	 * WHICH contracts this rule applies to. OMITTED means every contract in the
	 * source that declares the event.
	 *
	 * This is what makes "filter the NFT's Transfers and leave the ERC-20's alone"
	 * expressible. It is REFUSED on an address-less source (the single merged
	 * `{abi}` form), where there is no address to scope by.
	 */
	contracts?: `0x${string}`[];
	/**
	 * OR across the entries, AND within one entry's slots. Slots start at
	 * `topics[1]`.
	 *
	 * Each entry becomes its own `eth_getLogs` call, and the results are unioned
	 * and de-duplicated, so "anything involving me" is `[[me, null], [null, me]]`.
	 * An empty `match`, an empty entry and an all-null entry are all REFUSED:
	 * each of them means "no constraint", which is not a filter.
	 */
	match: ArgumentFilter[];
};

export type LogParseConfig = {
	parseAllEventsIrrespectiveOfAddresses?: boolean;
	/**
	 * The argument filters, as a LIST of rules.
	 *
	 * A list rather than a map keyed by event name, because a name is not what a
	 * filter is about: two rules can target one event, one rule can target one
	 * contract's version of it, and one `topic0` can carry two decoding shapes at
	 * two addresses (ADR-0061). A map keyed by name could express none of that.
	 */
	filters?: FilterRule[];
};
