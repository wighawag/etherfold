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
 */
export type PortCases = {
	/** How far the fold has got. Takes nothing. */
	readonly progress: {readonly request: undefined; readonly response: HostProgress};
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
