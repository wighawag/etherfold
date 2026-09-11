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
 * WHERE THE FOLD HAS GOT TO, and the evidence of WHERE IT IS RUNNING.
 *
 * The minimum surface that proves the path end to end: a tab that gets an answer
 * at all has proof the host is alive (which is why there is no `alive` field --
 * an answer IS that fact), and the two block numbers are how far the fold has
 * got and how far it has to go.
 *
 * It deliberately reports NO derived figure. `createIndexerState` computes
 * percentages and a blocks-behind count for the main-thread case, and
 * `GenerationProgress.blocksBehind` already means something else (how far a
 * non-canonical generation is behind the CANONICAL one, not behind the tip).
 * Carrying a second meaning of that word across the boundary is exactly the
 * muddle the glossary exists to prevent, so the two numbers cross and the
 * derivations are `a-tab-sees-sync-progress-pushed-from-the-worker`'s to place.
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
	/**
	 * How far the fold has got. Absent until the container has published a cursor.
	 *
	 * THE TRAP, which is the container's and is reported rather than re-decided
	 * here: a generation that has loaded and not yet FETCHED publishes `0` for both
	 * of these -- it has folded nothing and has not learnt a tip. So equality alone
	 * does not mean CAUGHT UP, it means "as far as this cursor knows", and a tab
	 * rendering a progress figure has to know which of the two it is looking at. It
	 * is left as the container's own figures deliberately: inventing a third value
	 * here to disambiguate would be a second meaning of a cursor, and the phase an
	 * app actually renders is
	 * `a-tab-sees-sync-progress-pushed-from-the-worker`'s to place.
	 */
	readonly lastToBlock?: number;
	/** The chain tip as of that advance. Absent until the container has published a cursor. */
	readonly latestBlock?: number;
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
 * EVERY SURFACE THE PORT CARRIES, as a map from case name to what it takes and
 * what it answers.
 *
 * One key today. A later task adds a key and gets its request typed, its response
 * typed and its clone-safety checked, with no change to the transport, the
 * correlation or either end's plumbing -- which is the property ADR-0082 asked
 * for.
 */
export type PortCases = {
	/** How far the fold has got. Takes nothing. */
	readonly progress: {readonly request: undefined; readonly response: HostProgress};
};

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

function isEnvelope(value: unknown): value is {protocol: string; kind: string; id: number} {
	if (typeof value !== 'object' || value === null) return false;
	const message = value as {protocol?: unknown; kind?: unknown; id?: unknown};
	return (
		message.protocol === INDEXER_PORT_PROTOCOL && typeof message.kind === 'string' && typeof message.id === 'number'
	);
}

/** Ours and a request. Anything else on the endpoint belongs to somebody else. */
export function isPortRequest(value: unknown): value is PortRequest {
	return isEnvelope(value) && value.kind === 'request';
}

/** Ours and a response. */
export function isPortResponse(value: unknown): value is PortResponse {
	return isEnvelope(value) && value.kind === 'response';
}
