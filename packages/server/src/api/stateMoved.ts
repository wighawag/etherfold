import {generationDigestOf, type StateMoved, type StateMovedDetach} from '@etherfold/core';
import {Hono} from 'hono';
import type {Context} from 'hono';
import {logs} from 'named-logs';
import {readStreamCoverage} from '../emissions.js';
import type {Env} from '../env.js';
import type {IndexerRegistryEntry} from '../registry.js';
import {resolveCanonicalGeneration, resolveIndexer} from './resolve.js';
import {setup} from '../setup.js';
import type {ServerOptions} from '../types.js';

const logger = logs('@etherfold/server');

/**
 * THE FRAME NAME a notification arrives under: `@etherfold/core`'s `StateMoved`,
 * serialised as JSON and otherwise untouched.
 *
 * Exported because an app reading this stream matches on it, and a string copied
 * into a client is a contract nothing checks.
 */
export const STATE_MOVED_EVENT = 'state-moved';
/** THE FRAME NAME progress arrives under. See `StateMovedProgress`. */
export const STATE_MOVED_PROGRESS_EVENT = 'progress';

/**
 * WHERE THE FOLD HAS GOT TO, as a remote reader renders it, plus the two
 * identities it compares.
 *
 * The vocabulary is the one a TAB already binds to a progress bar
 * (`HostProgress`, `@etherfold/browser`, ADR-0082) rather than a second one for
 * the network: `lastToBlock` is how far the fold has got, `latestBlock` is the
 * chain tip as of that batch, and the distance is `blocksBehindTip` -- named for
 * the tip it measures against, because the bare word `blocksBehind` already means
 * how far a NON-CANONICAL generation is behind the canonical one.
 *
 * ## It is NOT a cursor, and it is NOT a feed position
 *
 * A reader of this stream holds nothing between frames and asks for nothing from
 * a position: the numbers here are rendered, and they are the SERVER's own
 * (`_stream_coverage`, the coverage claim the fold writes on every batch,
 * including one that carried no logs). Nothing here deserialises the processor's
 * **sync cursor**, which is opaque behind the storage seam (ADR-0027) -- which is
 * also the whole reason this rides the stream at all: a reader cannot compute it,
 * so the side that knows must say.
 *
 * ## What ABSENT means
 *
 * Absent rather than zeroed, on the rule the browser's progress already follows:
 * "it has folded nothing yet" and "it is level at block 0" are different claims,
 * and an app that renders a progress bar from a `0` it was handed before the
 * first batch shows a full one. The three block figures are therefore absent
 * together until this named indexer has folded a batch and learnt a tip.
 */
export type StateMovedProgress = {
	/** How far the canonical fold's stream is claimed to cover. Absent before the first batch. */
	lastToBlock?: number;
	/** The chain tip as the sender reported it on that batch. Absent likewise. */
	latestBlock?: number;
	/** The distance between the two: the number in "syncing, 400 blocks behind", `0` at the tip. */
	blocksBehindTip?: number;
	/**
	 * The **coherence token** in force. COMPARE it, never parse it.
	 *
	 * It rides progress as well as notifications for exactly ONE reason: a client
	 * connecting is told this AT ONCE, so a reconnecting one knows immediately
	 * whether what it already holds is stale. That is how a remote reader converges,
	 * because it has no state query surface to re-read (ADR-0083); a tab does, which
	 * is why the port's progress push carries no token.
	 */
	coherence: string;
	/** WHICH generation answers reads, as the opaque digest every other surface advertises. */
	generation: string;
};

/**
 * THE STATE-MOVED SIGNAL, over the network: `GET /{indexer}/state-moved`.
 *
 * The third transport of ADR-0083 and the first one that is not a browser
 * primitive. A client opens it and is told, best-effort, that the state moved --
 * the same `{kind, block, coherence, entities, generation}` value a tab receives
 * over its port or off the cross-tab channel, serialised as JSON and otherwise
 * untouched -- so pointing an app at a hosted indexer instead of at its own
 * worker changes a DEPLOYMENT CHOICE and not a line of its notification handling.
 *
 * ## THIS PACKAGE APPLIES NO BLOCKS, so this is a TRANSPORT and not a producer
 *
 * The fold happens in the receiving container (`@etherfold/core`), which
 * publishes what it applied, and a route holds an ENTRY rather than a container
 * -- so what this attaches to is `IndexerRegistryEntry.onStateMoved`, the way a
 * host reaches that publication. Nothing here folds, nothing here derives a
 * change by watching storage, and nothing here decides WHAT is published. A
 * second transport (a `graphql-ws` adapter, a hibernating socket) attaches at the
 * same seam with NO change to the publication, which is what ADR-0083 means by
 * the producer being transport-agnostic; the tests demonstrate it with an
 * in-process subscriber beside this one.
 *
 * ## SERVER-SENT EVENTS, and TWO frame kinds
 *
 * SSE because the signal is block-paced, one-directional and best-effort, so a
 * socket's lifecycle buys nothing. The two frames are deliberately the same two
 * things a TAB is told over its port (ADR-0082), and they keep that ADR's rule
 * about what a late joiner gets:
 *
 * - `progress` -- WHERE THE FOLD IS, sent ON CONNECT and again whenever it moves.
 *   The port's progress subscribe ANSWERS with the current value for the same
 *   reason: progress is a STATE, and a client that has just attached has
 *   something to render.
 * - `state-moved` -- one frame per notification, and NOTHING on connect. A
 *   notification is a thing that HAPPENED: a client is never handed one it missed,
 *   because there is nothing held to replay and replaying would have it invalidate
 *   for a block it may already have read.
 *
 * ## NOTHING IS HELD PER CLIENT
 *
 * One handler reference per open stream, inside the producer, and that is the
 * whole of it: nothing buffered, nothing retried, nothing remembered about a
 * client that went away, and no client identity to remember it by. A disconnect
 * detaches (the stream's own `cancel`, plus the request's abort signal), so a
 * server that has been connected to a thousand times holds exactly what it held
 * before. A client that missed a notification is repaired by the next one plus
 * the coherence token, and a client that RECONNECTS is repaired by the `progress`
 * frame it is handed at once.
 *
 * ## NO HEARTBEAT, deliberately
 *
 * Nothing is written to an idle stream to keep an intermediary from closing it.
 * An interval invented here would be the polling interval this whole ADR exists
 * to replace, wearing a different name, and no number would be right for a Node
 * process, a reverse proxy and a CDN at once. What makes that cheap rather than
 * negligent is the design above: a dropped stream costs a reconnect, and a
 * reconnect is answered AT ONCE with the position and the token, so a client that
 * was cut off while the chain was quiet learns on reconnect that it missed
 * nothing. A deployment that needs its connections held open configures its own
 * edge, which is where an idle timeout lives. (`X-Accel-Buffering: no` is sent
 * for the neighbouring problem and is not one: it asks a buffering proxy not to
 * WITHHOLD frames that were written, which would make a live signal arrive in
 * batches.)
 *
 * ## It is a PUBLIC read, like the feed
 *
 * `INGEST_TOKEN` guards the fetcher's private API -- the routes that can move the
 * cursor -- and this one moves nothing and reads no rows. What crosses is a block
 * number, entity NAMES and two opaque digests, which is strictly less than the
 * feed already serves anonymously. A deployment that needs it private puts it
 * behind its own edge, exactly as it does for `/{indexer}/feed`.
 *
 * ## The two REFUSALS, and why neither is a silent degradation
 *
 * - **The runtime cannot hold a stream across requests** (`501`,
 *   `state-moved-unsupported-runtime`). The Cloudflare Worker case: an ingest POST
 *   cannot write into a stream a different request opened, so a connection accepted
 *   there would be a client waiting for ever on a server that looks healthy. It is
 *   decided by a capability the HOST DECLARED (`ServerOptions.holdsStreamsAcrossRequests`)
 *   and never by detecting a runtime, which this package may not name at all.
 * - **The entry has no publisher** (`501`, `state-moved-not-published`). A host
 *   holding a bare receiver and no container publishes nothing
 *   (`singleContextEntry`), so absent is a capability statement exactly as it is
 *   for `generations` and `promote`, and this refuses rather than attaching to
 *   silence.
 *
 * Both are `501` because both say "this deployment does not do that", which is
 * what the ingest routes already answer on a host with no registry. The name
 * refusals are the shared ones (`501` no registry, `404` a name this host was not
 * built with), and an indexer with no generation answering reads yet refuses with
 * the `503` every other read here answers (ADR-0058) -- inherited from
 * `resolveCanonicalGeneration` rather than restated.
 *
 * ## What is deliberately NOT here
 *
 * A GraphQL runtime, schema or subscription. The signal is the PRIMITIVE and a
 * subscription is a derivable ADAPTER over it, anticipated for this server and
 * deliberately not built: a subscription is derivable from a signal by wrapping
 * it, while a signal is not derivable from a subscription without a GraphQL
 * runtime -- which is exactly what a read-surface-only app has deliberately not
 * loaded.
 */
export function getStateMovedAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	return new Hono<{Bindings: CustomEnv}>()
		.use(setup({serverOptions: options}))
		.get('/:indexer/state-moved', async (c) => {
			const resolved = resolveIndexer(options, c as never, 'state-moved');
			if (!resolved.ok) return resolved.response;
			const {name, entry} = resolved;

			if (!options.holdsStreamsAcrossRequests) return unsupportedRuntime(c as never, name);
			const subscribe = entry.onStateMoved;
			const coherenceNow = entry.coherenceNow;
			// BOTH or neither: they are one publisher's two answers, and a stream that
			// could deliver notifications but not say which token is in force could not
			// answer a reconnecting client, which is the whole of its convergence story.
			if (!subscribe || !coherenceNow) return notPublished(c as never, name);

			// The same refusal every other read here answers, and for the same reason: an
			// indexer that holds no generation answering reads has nothing to report a
			// position FROM, and an empty answer would be indistinguishable from a quiet
			// chain (ADR-0058).
			const answering = await resolveCanonicalGeneration(c as never, resolved, 'state-moved');
			if (!answering.ok) return answering.response;

			// READ BEFORE THE STREAM EXISTS, so that a failure here is an ordinary refusal
			// rather than a stream that opens and immediately dies. The generation it was
			// just resolved to is handed over rather than resolved a second time: two reads
			// could answer about two generations, which is the pairing every other read here
			// takes in one call.
			const openingProgress = await readProgress(entry, name, answering);

			const encoder = new TextEncoder();
			let detach: StateMovedDetach | undefined;
			let closed = false;
			/** The last progress frame sent, so an unchanged one is not sent twice. */
			let lastProgress: string | undefined;

			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					const close = () => {
						if (closed) return;
						closed = true;
						// LET GO of the producer FIRST: from here on this client costs nothing at all
						detach?.();
						try {
							controller.close();
						} catch {
							// already closed by the runtime tearing the response down
						}
					};

					const send = (event: string, data: unknown): boolean => {
						if (closed) return false;
						try {
							controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
							return true;
						} catch (err) {
							// The client is gone and the runtime has not told us yet. Not an error: a
							// reader closing a tab is the ordinary end of one of these.
							logger.info(`state-moved: a client of ${JSON.stringify(name)} could not be written to; letting go`, err);
							close();
							return false;
						}
					};

					const sendProgress = (progress: Omit<StateMovedProgress, 'coherence'> | undefined) => {
						if (!progress) return;
						// the token is read AT SEND TIME, so a frame never carries one that has been
						// rotated away from since the figures were read
						const frame: StateMovedProgress = {...progress, coherence: coherenceNow()};
						const serialised = JSON.stringify(frame);
						if (serialised === lastProgress) return;
						if (send(STATE_MOVED_PROGRESS_EVENT, frame)) lastProgress = serialised;
					};

					/**
					 * RE-READ where the fold is, at most one read in flight per client.
					 *
					 * A notification fires per BLOCK and the figures move per BATCH, so a
					 * catching-up batch would otherwise cost one pair of reads per block. The
					 * coalescing is back-pressure from the database rather than an invented
					 * interval: notifications arriving while a read is in flight are served by a
					 * single re-read after it.
					 */
					let reading = false;
					let again = false;
					const refreshProgress = async () => {
						if (reading) {
							again = true;
							return;
						}
						reading = true;
						try {
							do {
								again = false;
								sendProgress(await readProgress(entry, name));
							} while (again && !closed);
						} catch (err) {
							// Progress is the SECOND thing on this stream and must never take the
							// first one down: a database blip costs a stale figure, not the signal.
							logger.error(`state-moved: could not re-read where ${JSON.stringify(name)} has got to`, err);
						} finally {
							reading = false;
						}
					};

					// ON CONNECT: where the fold is, under which token, from which generation.
					// This is what a RECONNECTING client converges on, since it has no state query
					// surface to re-read (ADR-0083).
					sendProgress(openingProgress);
					// A client that was already gone before it was told anything: subscribing now
					// would attach a handler nothing will ever detach, which is the one kind of
					// per-client state this producer must not accumulate.
					if (closed) return;

					detach = subscribe((moved: StateMoved) => {
						if (!send(STATE_MOVED_EVENT, moved)) return;
						void refreshProgress();
					});

					// A CLIENT THAT VANISHED, as the runtime reports it. `cancel` below covers a
					// consumer that let go of the body; this covers a connection dropped
					// underneath one.
					const signal = c.req.raw.signal;
					if (signal) {
						if (signal.aborted) close();
						else signal.addEventListener('abort', close, {once: true});
					}
				},
				cancel() {
					closed = true;
					detach?.();
				},
			});

			return c.body(body, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					// Ask a buffering reverse proxy to pass frames through as they are written:
					// a signal delivered in batches is a signal that lost the only thing it had.
					'X-Accel-Buffering': 'no',
				},
			});
		});
}

/**
 * WHERE THE FOLD HAS GOT TO, from the rows this package already owns.
 *
 * Two reads and one answer: WHICH generation answers reads, and the **coverage
 * claim** of the stream that generation folds. They are read together for the
 * same reason a feed response resolves both halves at once -- computed
 * separately, the figures could describe different generations.
 *
 * The coverage claim is the honest source and deliberately not the cursor: it is
 * written on EVERY batch, including one that carried no logs (which is exactly
 * the case a figure derived from the rows would under-report), it is this
 * package's own row rather than the processor's opaque cursor (ADR-0027), and it
 * carries the tip the sender reported beside the block reached, so the distance
 * between them is a subtraction rather than a second mechanism.
 *
 * What it is a claim ABOUT is the STREAM, which is the one thing to know before
 * reading a number off it: several generations may fold one stream, and a
 * generation still REBUILDING is behind the claim. That is not a lie here,
 * because a rebuilding generation is never the one answering reads -- the pointer
 * moves at the END of a rebuild -- so the claim is where the canonical fold is
 * being fed to.
 */
async function readProgress(
	entry: IndexerRegistryEntry,
	name: string,
	known?: {stream: string; generation: string},
): Promise<Omit<StateMovedProgress, 'coherence'> | undefined> {
	// RE-RESOLVED on every refresh and not captured: the pointer MOVES, and a stream
	// that went on reporting the generation it opened under would name a lineage that
	// has stopped answering -- which is the one thing `generation` exists to say.
	const at = known ?? (await currentGeneration(entry));
	if (!at) return undefined;
	const {stream, generation} = at;
	const coverage = await readStreamCoverage(entry.db, {indexer: name, stream});
	// NOTHING FOLDED YET: the three block figures are absent together rather than
	// zeroed, because "level at block 0" is a different claim from "nothing yet".
	if (!coverage || coverage.latestBlock <= 0) return {generation};
	return {
		generation,
		lastToBlock: coverage.lastToBlock,
		latestBlock: coverage.latestBlock,
		blocksBehindTip: Math.max(0, coverage.latestBlock - coverage.lastToBlock),
	};
}

/** WHICH generation answers reads right now, with the digest a response advertises. */
async function currentGeneration(
	entry: IndexerRegistryEntry,
): Promise<{stream: string; generation: string} | undefined> {
	const canonical = await entry.canonicalGeneration();
	if (!canonical) return undefined;
	return {stream: canonical.stream, generation: generationDigestOf(canonical)};
}

/**
 * This runtime cannot hold the connection across invocations, and the host said
 * so.
 *
 * `501` and not a `503`: nothing here is temporary and no retry helps. It names
 * the field a host sets, because the caller who meets this is ordinarily the
 * OPERATOR of the deployment rather than the app -- and it names the remedy on
 * Cloudflare, so that "this is unsupported" does not read as "this is broken".
 */
function unsupportedRuntime(c: Context<{Bindings: Env}>, name: string) {
	logger.info(
		`state-moved: refused a client of ${JSON.stringify(name)}: this host has not declared that it can hold a ` +
			`stream open across requests`,
	);
	return c.json(
		{
			success: false,
			error: 'state-moved-unsupported-runtime',
			indexer: name,
			message:
				`this deployment cannot serve the state-moved signal. A block is folded inside an INGEST request and the ` +
				`stream is opened by another, so the runtime has to let one request write into a stream a different one ` +
				`opened. A host that can says so with \`holdsStreamsAcrossRequests\`; this one has not, so the connection ` +
				`is refused rather than accepted and never written to. On Cloudflare Workers it cannot be declared: an ` +
				`I/O object created in one request handler is unreachable from another, and the remedy is a Durable ` +
				`Object, which is infrastructure a deployment takes on deliberately.`,
		} as const,
		501,
	);
}

/**
 * This named indexer publishes nothing to attach to.
 *
 * The other half of the same capability statement, and kept apart from the
 * refusal above because the remedy is a different person's: that one is a
 * RUNTIME a deployment chose, this is a HOST that registered a bare receiver
 * rather than a generation container, so nothing under this name has a publisher
 * at all.
 */
function notPublished(c: Context<{Bindings: Env}>, name: string) {
	logger.info(`state-moved: ${JSON.stringify(name)} resolves to a host that publishes no signal; refused`);
	return c.json(
		{
			success: false,
			error: 'state-moved-not-published',
			indexer: name,
			message:
				`this named indexer publishes no state-moved signal, so there is nothing to stream. The signal is ` +
				`produced by the generation container that APPLIES the blocks; a host that registered a bare receiver ` +
				`registers no publisher with it, and this refuses rather than holding a connection open on silence.`,
		} as const,
		501,
	);
}
