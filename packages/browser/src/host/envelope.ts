/**
 * THE ENVELOPE: one request/response shape with correlation, and the surfaces
 * multiplexed on it as CASES.
 *
 * ADR-0082 decides the shape and this is it: a new call is a CASE rather than a
 * new channel, so the store proxy, the control calls and (in another spec) the
 * query executor all ride the same two messages. `PortCases` is where a later
 * task adds its key; nothing else about the boundary moves when it does.
 *
 * ## Why there is no protocol VERSION
 *
 * `protocol` is a NAMESPACE and not a version. Both ends of this port come out of
 * ONE build -- the tab's bundle and the worker entry are compiled together from
 * the same source tree by the app's bundler -- so a version number would be a
 * compatibility promise nothing is in a position to keep, and the failure it
 * would pretend to handle (an old tab talking to a new worker) cannot occur. What
 * the tag IS for is a shared endpoint: a worker scope receives whatever anybody
 * posts to it, and a message that is not ours must be IGNORED rather than
 * answered with an error about an unknown case.
 */
import type {
	Abi,
	GenerationRecord,
	IndexingSource,
	TxInclusionQuery,
	TxInclusionVerdict,
	UsedPromotionConfig,
} from '@etherfold/core';
import type {EntityId, EntityIdPrefix, Listing, NormalizedEntity} from '@etherfold/state-store';
import type {PortError} from './errors.js';

export type {PortError} from './errors.js';

/** The namespace every message on this port carries. See the module note above. */
export const INDEXER_PORT_PROTOCOL = 'etherfold/indexer-port';

/**
 * WHICH EXECUTION CONTEXT owns the container, as the three shapes ADR-0082 names.
 *
 * All three are spelled out here from the first one being built, because the set
 * is closed and is already named in `CONTEXT.md`: a shape is a way of obtaining a
 * port (`HostAccess`), so adding one adds no member to any other type.
 */
export type HostingShape = 'dedicated-worker' | 'shared-worker' | 'main-thread';

/**
 * WHICH OF THE FIVE COARSE THINGS THE FOLD IS DOING, as a tab renders them.
 *
 * The set is closed and it is deliberately COARSE. `SyncingState` and
 * `StatusState` carry the main thread's finer vocabulary -- `fetchingLogs`,
 * `processingFetchedLogs`, `InstallingStreamSeed`, `FetchingEventStream`,
 * `ProcessingEventStream` -- and those are the load's own sub-steps, visible on
 * this thread because a hook holds the container and gets its callbacks for
 * free. Across a port each of them would be a message, so what crosses is what
 * an app CHANGES ITS SCREEN FOR: a spinner, a progress bar, a blank wait, an
 * explanation.
 *
 * The one distinction that costs nothing to keep and everything to lose is
 * `catching-up` against `at-tip`, because that is the difference between
 * "syncing, 400 blocks behind" and "live".
 */
export type SyncPhase =
	/**
	 * Nothing has been asked of the chain yet, or the container is still opening.
	 * `SyncingState.waitingForProvider` under its own name, and it LEAVES this
	 * value the moment the container is open (the same moment that field is
	 * cleared on the main thread).
	 */
	| 'waiting'
	/** The load is running: reading the cursor, re-folding a stored stream. */
	| 'loading'
	/**
	 * Folding towards a tip it has not reached. This is where `blocksBehindTip`
	 * and `syncPercentage` are the numbers worth rendering.
	 *
	 * It is also the phase a host is in between the load finishing and the first
	 * ADVANCE answering, because at that moment the fold is behind by an unknown
	 * amount rather than level: a cursor that has loaded and not yet fetched reads
	 * `0` of `0` (see `lastToBlock`), and reporting THAT as `at-tip` is the trap
	 * this phase exists to keep an app out of.
	 */
	| 'catching-up'
	/**
	 * Level with the tip, as an ADVANCE reported it. It is the driver's own rest
	 * condition (`lastToBlock >= latestBlock` on an advance) and not a second
	 * definition beside it.
	 */
	| 'at-tip'
	/**
	 * The driver STOPPED on something waiting cannot fix, and `failure` says what.
	 *
	 * A phase rather than an absence, because a host that merely stopped reporting
	 * is indistinguishable from a slow one, which is where "is it broken?" comes
	 * from (ADR-0082).
	 */
	| 'refused';

/**
 * WHERE THE FOLD HAS GOT TO, and the evidence of WHERE IT IS RUNNING.
 *
 * The minimum surface that proves the path end to end: a tab that gets an answer
 * at all has proof the host is alive (which is why there is no `alive` field --
 * an answer IS that fact), and the two block numbers are how far the fold has
 * got and how far it has to go.
 *
 * ## It is ONE value, delivered two ways
 *
 * The `progress` case ANSWERS it to a tab that asked, and the `progress` PUSH
 * carries the same type to a tab that subscribed. There is deliberately not a
 * second, richer shape for the pushed one: two progress types on one port would
 * be two things to keep in step, and the answer to "what did I miss" would
 * differ from the answer to "where are we now".
 *
 * ## The derived figures are the HOST's, computed once
 *
 * `createIndexerState` computes a blocks-processed count and a percentage for
 * the main-thread case, and those are what an app actually binds to a progress
 * bar, so they cross rather than being recomputed on the tab from a third block
 * number. It is the same placement the rows take (`declaredRow` runs in the
 * host): one implementation rather than two that agree by inspection.
 *
 * What is NOT reused is the WORD `blocksBehind`. `GenerationProgress.blocksBehind`
 * already means how far a non-canonical generation is behind the CANONICAL one,
 * which is a different question with a different answer, so the distance to the
 * chain tip is `blocksBehindTip` and says which tip in its name.
 */
export type HostProgress = {
	/** WHICH hosting shape is answering, as the entry point that obtained the port named it. */
	readonly host: HostingShape;
	/**
	 * WHAT `globalThis` IS where this answer was computed:
	 * `'DedicatedWorkerGlobalScope'` in a worker, `'Window'` on the main thread.
	 *
	 * Measured rather than declared, so "the UI thread is not doing the fold" is a
	 * fact a test can assert on instead of a timing threshold. See
	 * `executionScopeName`.
	 */
	readonly scope: string;
	/** Whether the host's DRIVER is running: `false` before it starts and after it stops. */
	readonly indexing: boolean;
	/** WHICH of the five coarse things the fold is doing. See `SyncPhase`. */
	readonly phase: SyncPhase;
	/**
	 * How far the fold has got. Absent until the container has published a cursor.
	 *
	 * THE TRAP, which is the container's and is reported rather than re-decided
	 * here: a generation that has loaded and not yet FETCHED publishes `0` for both
	 * of these -- it has folded nothing and has not learnt a tip. So equality alone
	 * does not mean CAUGHT UP, it means "as far as this cursor knows", and a tab
	 * rendering a progress figure has to know which of the two it is looking at. It
	 * is left as the container's own figures deliberately: inventing a third value
	 * here to disambiguate would be a second meaning of a cursor. What DOES
	 * disambiguate the two is `phase`, which is `loading` or `catching-up` until an
	 * ADVANCE has said otherwise, and the derived figures below, which are absent
	 * until a tip has been learnt at all.
	 */
	readonly lastToBlock?: number;
	/** The chain tip as of that advance. Absent until the container has published a cursor. */
	readonly latestBlock?: number;
	/**
	 * HOW MANY BLOCKS BEHIND THE CHAIN TIP the fold is: the number in "syncing, 400
	 * blocks behind", and `0` at the tip.
	 *
	 * Named for the tip it measures against, because `blocksBehind` is taken:
	 * `GenerationProgress.blocksBehind` is how far a non-canonical generation is
	 * behind the CANONICAL one.
	 *
	 * This and the two figures below are ABSENT TOGETHER until a tip has been
	 * learnt (`latestBlock > 0`), because every one of them is a statement about a
	 * distance to a tip and a host that has not fetched knows of none. Absent
	 * rather than `0`: "level" and "unknown" are different claims, and an app that
	 * renders a progress bar from a `0` it was handed before the first fetch shows
	 * a full one.
	 */
	readonly blocksBehindTip?: number;
	/**
	 * How many blocks this fold has got through, counted from the block it STARTS
	 * at (the source's earliest `startBlock`) rather than from where this session
	 * resumed.
	 *
	 * `createIndexerState`'s `numBlocksProcessedSoFar`, under its own name and by
	 * its own rule, because it is the numerator of the progress bar an app already
	 * draws and the two paths should not disagree about what the word counts.
	 */
	readonly numBlocksProcessedSoFar?: number;
	/**
	 * The same span as a PERCENTAGE, to four decimal places, exactly as
	 * `createIndexerState` rounds it.
	 *
	 * `100` where there is nothing to process (a tip at or below the block the fold
	 * starts at), which is the truthful reading of a fold with no span rather than
	 * the division by zero the main-thread version performs there.
	 */
	readonly syncPercentage?: number;
	/**
	 * WHY the driver stopped, where it stopped on a failure rather than on a
	 * request.
	 *
	 * Reported rather than thrown, for the reason a demotion is: the tab asked how
	 * far the fold got, and "it stopped, here is why" is the answer to that
	 * question. A host that silently reported `indexing: false` for ever would be
	 * indistinguishable from one that had not started.
	 */
	readonly failure?: PortError;
};

/**
 * ONE GENERATION THIS HOST HOLDS, and how far its fold has got.
 *
 * The FOUR FIELDS `GenerationProgress` already carries (`@etherfold/browser`'s
 * own vocabulary for this, published on `SyncingState.nonCanonicalGenerations`)
 * under their existing names and rules, plus the one thing a LIST of every
 * generation needs that a list of the OTHERS did not: which of them is answering
 * reads. A main-thread app moving to a port therefore binds the same words to
 * the same meanings.
 *
 * It REPORTS and it does not decide, exactly as that type does: whether a second
 * generation existing means the answers on screen should be rendered, dimmed or
 * hidden is something only the app knows, because only the app knows whether its
 * reconfigure made the old answers WRONG or merely INCOMPLETE.
 */
export type HostGeneration = {
	/** WHICH generation: the stream it folds, the processor that folds it, and when it was registered. */
	readonly record: GenerationRecord;
	/**
	 * Whether this is the one ANSWERING READS -- the **canonical pointer**, as this
	 * host's container resolves it.
	 *
	 * A flag per entry rather than a separate id beside the list, so a tab cannot
	 * hold a pointer that names nothing in the list it came with.
	 */
	readonly canonical: boolean;
	/**
	 * Whether it FOLLOWS a stream another generation writes rather than fetching
	 * its own.
	 *
	 * REPORTED and never chosen (ADR-0044): it is a consequence of sharing a
	 * stream. It is also what a reconfigure COSTS, said in one field -- a generation
	 * that follows re-folds logs that are already on disk, and one that does not has
	 * to ask the node for them again.
	 */
	readonly follows: boolean;
	/**
	 * How far its fold has got, or absent before it has loaded.
	 *
	 * Absent rather than `0`, because "it has folded nothing yet" and "it is level
	 * at block 0" are different claims and an app that dims on progress has to tell
	 * them apart.
	 */
	readonly lastToBlock?: number;
	/**
	 * How far BEHIND the generation that answers reads, in blocks: `0` means level
	 * (or ahead, which `manual` allows).
	 *
	 * Absent when either cursor is unknown. Behind the CANONICAL generation and not
	 * behind the chain tip -- which is the distance `HostProgress.blocksBehindTip`
	 * carries, under a name that says which tip it measures against precisely so
	 * these two cannot be confused.
	 */
	readonly blocksBehind?: number;
};

/**
 * WHAT A RECONFIGURE DID, as the tab is told.
 *
 * A reconfigure under the generation model ADDS a generation beside the live one
 * rather than resetting the live one, so what there is to report is the
 * generation that now exists and whether asking for it created anything.
 *
 * Deliberately NOT `@etherfold/core`'s `ReconfigureOutcome`, which is a
 * different question's answer: that one rides out of `updateIndexer`, the
 * IN-PLACE verb, and says whether the fold it reconfigured was DISCARDED and
 * what the source comparison decided. Nothing is discarded here -- that is the
 * whole of what "a reconfigure is not an outage" means -- so there is no reset
 * verdict to carry, and the two names are kept apart so neither is read as the
 * other.
 */
export type HostReconfigure = {
	/** The generation that folds the source as asked for, and where it has got to. */
	readonly generation: HostGeneration;
	/**
	 * Whether this reconfigure CREATED that generation, or RESOLVED to one the host
	 * already held.
	 *
	 * `false` is the "nothing moved" answer and it is an ordinary one: a source
	 * whose hashable shape did not change (a regenerated ABI that only added a
	 * function, an object rebuilt from the same bytes) names the generation that is
	 * already running, and the container resolves to it rather than putting a second
	 * engine over one state. A tab that would otherwise render "rebuilding" for a
	 * reconfigure that changed nothing can tell the two apart.
	 */
	readonly added: boolean;
};

/**
 * ONE ROW, as the port carries it: the DECLARED columns and nothing else.
 *
 * It is projected in the HOST, by the same `declaredRow` the same-thread surface
 * projects with, which is what makes the rows a tab gets the rows a same-thread
 * caller gets rather than two shapes that agree by inspection. Version columns
 * (`_lower`, `_upper`) are storage and never cross; an unlisted declared field
 * crosses as `null`, exactly as the store wrote it.
 *
 * Untyped here on purpose: the envelope carries the entity NAME as a string,
 * and the TYPES come from the declarations an app already wrote, applied on the
 * tab side by `createPortReadSurface`. Typing the wire off a generic would type
 * nothing -- the host answers for whatever entity it was asked about.
 */
export type PortRow = Record<string, unknown>;

/**
 * EVERY SURFACE THE PORT CARRIES, as a map from case name to what it takes and
 * what it answers.
 *
 * A later task adds a key and gets its request typed, its response typed and its
 * clone-safety checked, with no change to the transport, the correlation or
 * either end's plumbing -- which is the property ADR-0082 asked for, and which
 * the four reads below are the first demonstration of.
 *
 * ## The store's FOUR reads, as four cases
 *
 * One case per read rather than one `read` case with a verb inside it: the
 * requests differ in what they carry (an id or a prefix, with or without a
 * block), so a single case would be a union a host has to narrow by hand, and
 * the envelope's own dispatch already is that narrowing. The names are the
 * seam's own (`getCurrent` / `getAsOf` / `listCurrent` / `listAsOf`), so there
 * is one vocabulary from the store, through the port, to the surface a tab
 * holds.
 *
 * There are FOUR and there will not be a fifth: the seam has no predicate and no
 * ordering, because a handler runs once per event on a substrate with no query
 * planner (ADR-0021). Richer queries arrive on this same port as the EXECUTOR
 * `the-same-query-runs-against-a-worker-and-a-server` defines, which owns its
 * own serialisation -- not as more methods on this proxy.
 *
 * ## The LIFECYCLE calls, as cases of their own
 *
 * `startIndexing`, `stopIndexing`, `reconfigure`, `generations` and `promotion`
 * are the control half of ADR-0082's "status and control" surface, and they are
 * REQUESTS WITH ANSWERS rather than fire-and-forget messages: a tab that asks for
 * a reconfigure learns whether it was accepted, what it created, or -- through the
 * refusal path -- why not. There is deliberately no case that advances the fold by
 * ONE step: a round trip per cycle is the polling this port replaced, and the
 * driver that does the advancing lives in the host.
 */
export type PortCases = {
	/** How far the fold has got. Takes nothing. */
	readonly progress: {readonly request: undefined; readonly response: HostProgress};
	/**
	 * START THE DRIVER, and answer where the fold is now.
	 *
	 * Starting a host that is already indexing is an ANSWER and not a refusal:
	 * "index" is a state a caller asks for rather than an edge it triggers, so a
	 * settings screen that asks twice, or two components that each ask once, leave
	 * the host in the state they both asked for. What comes back says which state
	 * that is (`HostProgress.indexing`). One arriving while a STOP is still being
	 * honoured waits for that stop to land and then starts afresh, so the pair
	 * cannot race into a host that was asked to index and is not.
	 */
	readonly startIndexing: {readonly request: undefined; readonly response: HostProgress};
	/**
	 * STOP THE DRIVER, and answer where the fold stopped.
	 *
	 * It ANSWERS WHEN THE CYCLE IN FLIGHT HAS FINISHED, which is what makes it
	 * honest: no chain request is made after this response is posted, and the cursor
	 * is where a completed cycle would have left it rather than somewhere half a
	 * cycle in. A cut-off cycle is not on offer at all -- the cursor is written in
	 * the same transaction as the block it describes (ADR-0027), so the consistent
	 * thing to do with an advance already under way is to let it land.
	 */
	readonly stopIndexing: {readonly request: undefined; readonly response: HostProgress};
	/**
	 * RECONFIGURE THE SOURCE: fold it in a generation BESIDE the live one.
	 *
	 * The SOURCE and nothing else, because the source is the only half of a
	 * generation that is DATA. A generation is a stream and a fold over it; the fold
	 * is code, so changing it is a new worker bundle rather than a message (ADR-0082),
	 * and the stream CONFIG is one mutable value on the one keeper a container holds,
	 * so it is not settable per generation (`GenerationSpec.source`).
	 *
	 * What the host does with it is the generation machinery unchanged: the new
	 * generation folds beside the canonical one, which goes on answering every read,
	 * and the **canonical pointer** moves when the promotion policy says so --
	 * `on-catch-up` once the new fold reaches the cursor the live one has,
	 * `immediate` at once, `manual` never on its own.
	 *
	 * A REFUSAL crosses as the refusal it is (`GenerationCapReachedError`, which is
	 * the one this case meets), carrying its own fields: see `PortError`. What the
	 * new generation meets later, while it FOLDS, is reported on `progress` like any
	 * other driver failure.
	 */
	readonly reconfigure: {
		readonly request: {readonly source: IndexingSource<Abi>};
		readonly response: HostReconfigure;
	};
	/**
	 * EVERY GENERATION THIS HOST HOLDS, in the order it built them, with the one
	 * answering reads marked.
	 *
	 * Asked rather than pushed: a generation list changes when a caller
	 * RECONFIGURES or a pointer moves, which is a handful of times in a session, and
	 * pushing it would be a second signal to keep in step with one nobody is
	 * watching between reconfigures.
	 */
	readonly generations: {readonly request: undefined; readonly response: readonly HostGeneration[]};
	/**
	 * THE PROMOTION POLICY IN FORCE, as the container resolved it.
	 *
	 * Reported rather than re-derived, and NOTHING IS DEFAULTED AT THIS BOUNDARY:
	 * there is one default everywhere (`on-catch-up`), it lives with the type it
	 * belongs to, and a second copy of it in the browser -- or in the tab, one step
	 * further out -- is how two runtimes come to disagree about which value an app is
	 * running under (`CONTEXT.md`, *canonical pointer*).
	 */
	readonly promotion: {readonly request: undefined; readonly response: UsedPromotionConfig};
	/**
	 * DOES THE INDEXED STATE ALREADY ACCOUNT FOR THESE TRANSACTIONS? One verdict
	 * per hash, from the window the host's canonical generation maintains.
	 *
	 * A LIST in, a record out, because an app with a pending queue asks about the
	 * QUEUE: a call per transaction would be a round trip per transaction for a
	 * question every one of them answers off the same window, built once per call
	 * (`indexWindow`).
	 *
	 * ## The verdict crosses WHOLE, and must never become a boolean
	 *
	 * `TxInclusionVerdict` is `@etherfold/core`'s own type, carried unchanged: a
	 * STATUS and the BASIS for it. Narrowing it at this boundary would destroy the
	 * distinction the type exists for -- `unknown` has two causes (`not-synced`,
	 * `window-not-covering`) and an app renders those differently from an honest
	 * `absent`, because dropping an optimistic update on "I cannot tell" is the
	 * double-count this whole surface exists to prevent.
	 *
	 * `minedAtBlock` crosses PER QUERY and is not decoration: the window is SPARSE,
	 * so `absent` means only "not in the window", and a caller holding a RECEIPT
	 * closes that through the `below-window` branch. A tab is exactly where a
	 * caller has a receipt.
	 *
	 * ## A SNAPSHOT, and deliberately not a subscription
	 *
	 * It is answered against the state at the moment of the call, so an app
	 * watching a transaction ASKS AGAIN rather than being handed something live.
	 * The window moves as the fold advances and as reorgs are concluded, and a
	 * verdict pushed at a tab would be a second progress signal with the same
	 * cadence as the one already on this port -- `progress` is what tells an app
	 * that asking again is worth it.
	 */
	readonly checkTxInclusion: {
		readonly request: {readonly queries: readonly TxInclusionQuery[]};
		readonly response: Record<string, TxInclusionVerdict>;
	};
	/**
	 * START PUSHING progress to this tab, and answer where the fold is NOW.
	 *
	 * The current value comes back as the RESPONSE rather than as a push chasing
	 * it, which is what makes a tab that attached half way through a fold correct
	 * immediately: there is no window in which it holds nothing, and no race
	 * between a first push and the answer to a question it also asked.
	 *
	 * Named for WHAT it subscribes to rather than taking a topic argument, on the
	 * same ground the four reads are four cases: the envelope's dispatch already is
	 * that narrowing, and a later push would otherwise make one case's response
	 * type depend on its request's contents.
	 */
	readonly subscribeToProgress: {readonly request: undefined; readonly response: HostProgress};
	/**
	 * STOP PUSHING progress to this tab.
	 *
	 * The host stops POSTING, rather than the tab stopping listening: an
	 * unsubscribed tab that still received the messages would be paying the cost
	 * the push cadence exists to bound.
	 */
	readonly unsubscribeFromProgress: {readonly request: undefined; readonly response: undefined};
	/**
	 * WHAT THE HOST'S STORE WAS BUILT WITH, so a tab's surface can be checked
	 * against it.
	 *
	 * The same-thread surface compares its declarations with the store's at
	 * CONSTRUCTION and refuses a disagreement naming both (`assertDeclaredBy`),
	 * because a surface generated from a stale copy types its rows off columns the
	 * store does not have. A port cannot answer that question synchronously, so it
	 * is asked here -- once, when a surface is built -- and the refusal lands on
	 * the first read instead of on the constructor.
	 */
	readonly declarations: {readonly request: undefined; readonly response: readonly NormalizedEntity[]};
	/** One entity at the tip, or `undefined` if it is absent. */
	readonly getCurrent: {
		readonly request: {readonly entity: string; readonly id: EntityId};
		readonly response: PortRow | undefined;
	};
	/** One entity as of a block NUMBER. Refused, never answered from the tip, outside retention. */
	readonly getAsOf: {
		readonly request: {readonly entity: string; readonly id: EntityId; readonly at: number};
		readonly response: PortRow | undefined;
	};
	/** The rows of an id PREFIX at the tip, ascending, bounded by a REQUIRED limit. */
	readonly listCurrent: {
		readonly request: {readonly entity: string; readonly prefix: EntityIdPrefix; readonly limit: number};
		readonly response: Listing<PortRow>;
	};
	/** The same listing as of a block NUMBER. */
	readonly listAsOf: {
		readonly request: {
			readonly entity: string;
			readonly prefix: EntityIdPrefix;
			readonly at: number;
			readonly limit: number;
		};
		readonly response: Listing<PortRow>;
	};
};

/**
 * EVERY MESSAGE THE HOST SENDS THAT NOBODY ASKED FOR, as a map from push name to
 * what it carries.
 *
 * The third message kind, and the reason it exists is ADR-0082's "status is
 * PUSHED, and the control surface NARROWS": reproducing the main thread's
 * reactive triple across a port would mean either polling on a timer somebody
 * invented or duplicating state in every tab. So the host says when something
 * CHANGED, and an app builds whatever reactive wrapper its framework wants over
 * that signal (`createProgressReadable` is the one for the common case).
 *
 * A push is SUBSCRIBED TO, never broadcast: nothing is posted until a tab asks,
 * and `unsubscribeFromProgress` stops it. A later push adds a key here and its
 * own subscribe/unsubscribe pair of cases.
 *
 * Deliberately NOT a cross-tab mechanism. This is a host telling ITS OWN tab how
 * it is doing; how a READER tab in another window learns that state moved is
 * `a-reader-learns-when-the-state-moved`'s decision.
 */
export type PortPushes = {
	/**
	 * WHERE THE FOLD HAS GOT TO, pushed when it CHANGED.
	 *
	 * The cadence is APPLIED WORK and never a timer: the container publishes a
	 * cursor per applied batch, and that is what moves this. A value identical to
	 * the last one pushed is not sent at all, so a host resting at the tip is
	 * silent rather than emitting a heartbeat an app would have to ignore.
	 */
	readonly progress: HostProgress;
};

export type PortPushName = keyof PortPushes & string;
export type PortPushValue<Name extends PortPushName> = PortPushes[Name];

/**
 * A host saying something unprompted.
 *
 * It carries NO correlation id, and that absence is the shape of the thing: an
 * id correlates an answer with a question, and nobody asked.
 *
 * Written as a mapped type so that the whole of it is a DISCRIMINATED UNION on
 * `push`: a tab narrows a push by its name and gets the value that name carries,
 * with no cast, and that stays true when a later task adds a second name.
 */
export type PortPush<Name extends PortPushName = PortPushName> = {
	[Named in Name]: {
		readonly protocol: typeof INDEXER_PORT_PROTOCOL;
		readonly kind: 'push';
		readonly push: Named;
		readonly value: PortPushValue<Named>;
	};
}[Name];

export type PortCaseName = keyof PortCases & string;
export type PortRequestPayload<Case extends PortCaseName> = PortCases[Case]['request'];
export type PortResponseValue<Case extends PortCaseName> = PortCases[Case]['response'];

/** A tab asking. `id` is the correlation, and it is unique per port rather than globally. */
export type PortRequest<Case extends PortCaseName = PortCaseName> = {
	readonly protocol: typeof INDEXER_PORT_PROTOCOL;
	readonly kind: 'request';
	readonly id: number;
	readonly case: Case;
	readonly payload: PortRequestPayload<Case>;
};

/**
 * A host answering, carrying the case it answers as well as the id.
 *
 * The case is redundant for correlation and is there for the REFUSAL path: a
 * response that could not be built, or could not be cloned, names the surface it
 * belongs to rather than an opaque number.
 */
export type PortResponse<Case extends PortCaseName = PortCaseName> = {
	readonly protocol: typeof INDEXER_PORT_PROTOCOL;
	readonly kind: 'response';
	readonly id: number;
	readonly case: Case;
} & ({readonly ok: true; readonly value: PortResponseValue<Case>} | {readonly ok: false; readonly error: PortError});

function isOurs(value: unknown): value is {protocol: string; kind: string} {
	if (typeof value !== 'object' || value === null) return false;
	const message = value as {protocol?: unknown; kind?: unknown};
	return message.protocol === INDEXER_PORT_PROTOCOL && typeof message.kind === 'string';
}

/** Ours, and CORRELATED: the two kinds that pair a question with its answer. */
function isEnvelope(value: unknown): value is {protocol: string; kind: string; id: number} {
	return isOurs(value) && typeof (value as {id?: unknown}).id === 'number';
}

/** Ours and a request. Anything else on the endpoint belongs to somebody else. */
export function isPortRequest(value: unknown): value is PortRequest {
	return isEnvelope(value) && value.kind === 'request';
}

/** Ours and a response. */
export function isPortResponse(value: unknown): value is PortResponse {
	return isEnvelope(value) && value.kind === 'response';
}

/**
 * Ours and a push.
 *
 * It carries no `id`, so it is recognised by its own `push` NAME instead: a
 * message with neither a correlation id nor a push name is not something this
 * port sent.
 */
export function isPortPush(value: unknown): value is PortPush {
	return isOurs(value) && value.kind === 'push' && typeof (value as {push?: unknown}).push === 'string';
}
