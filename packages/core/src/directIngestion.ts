import type {Abi} from 'abitype';
import {NoLiveReceiverError} from './errors.js';
import type {IngestionResponse, IngestionTarget} from './logFetcher.js';
import type {LogIngestion} from './streamBuilder.js';
import {sameWireContext} from './internal/engine/utils.js';
import type {UntypedWireBatch, WireBatch, WireContext} from './types.js';

/**
 * WHICH RECEIVERS ARE LIVE AT THE MOMENT OF THE ASK, answered fresh every time.
 *
 * The same question `IndexerRegistryEntry.liveIngestions` asks on the HTTP side
 * (`@etherfold/server`) and the same answer a generation container gives it
 * (`ReceivingIndexer.liveIngestions`), so the in-process wire routes on the fact
 * the network one already routes on rather than on a second one. It is a
 * FUNCTION and not a list because the set MOVES while a deployment runs: a
 * successor is registered beside the incumbent, a generation is deleted by
 * another process, and writer succession hands the wire from one fold to the
 * next -- none of which this side is told about.
 */
export type LiveIngestions = () => Promise<readonly LogIngestion[]>;

/**
 * The ADR-0004 wire, with no wire.
 *
 * `createHttpIngestion` puts a network between the two halves; this one puts
 * nothing between them, so a single deployable can fetch and process in one
 * place while keeping every property the split has. That is possible only
 * because both sides of the contract are INTERFACES rather than an HTTP client
 * and an HTTP route: the fetcher pushes into an `IngestionTarget`, the receiver
 * implements `LogIngestion`, and this is the eighteen lines that make one the
 * other.
 *
 * ## What is kept, which is nearly all of it
 *
 * The receiver is still authoritative about the cursor, still derives every
 * reorg, and still refuses a batch that does not start where it says. The
 * fetcher still holds no cursor, still asks before its first fetch, and is still
 * corrected rather than crashed when it asks from the wrong place. None of that
 * came from HTTP; it came from the contract, so none of it is lost by removing
 * the transport.
 *
 * What IS lost is only what the transport was carrying: a network hop, a shared
 * secret, and the two failure modes that go with them (an unreachable server, a
 * wrong token). A combined deployment has none of those, and the code that would
 * have handled them costs nothing because it is keyed off errors that can no
 * longer be thrown.
 *
 * ## The one thing to get right
 *
 * A cursor refusal must come back as a `CursorCorrection` and not as a throw.
 * `UnexpectedFromBlockError` is the ONE resumable refusal in the contract, and a
 * sender that received it as an exception would treat the ordinary case (a
 * restart, a lost acknowledgement, a second fetcher) as a fault. The HTTP
 * transport does this by mapping a `409`; here it is done by recognising the
 * error, STRUCTURALLY rather than with `instanceof`, for the same reason
 * `isRetryable` is structural: two copies of this package in one dependency tree
 * would otherwise turn the correction path into a crash, and it would happen
 * only in the deployments that bundle awkwardly.
 *
 * ## ONE RECEIVER, or WHICHEVER OF SEVERAL IS LIVE AT THE ASK
 *
 * A single `LogIngestion` is the shape that has always been here and is what a
 * caller holding one receiver passes. A {@link LiveIngestions} function is the
 * other arm, and it is what a caller holding a GENERATION CONTAINER passes,
 * because such a caller has no single receiver to hand over: a container holds
 * several folds and only some of them have one -- a FOLLOWER re-folds a stored
 * stream and is deliberately not addressable on the wire (ADR-0044) -- and WHICH
 * of them is live moves while the process runs.
 *
 * It is one function with a widened parameter rather than a sibling beside it,
 * because there is ONE concept here ("the ADR-0004 wire, with no wire") and a
 * second name for it would be a second thing to keep in step. On the resolving
 * arm this routes exactly as the HTTP route does: the batch's own `{source,
 * config}` selects among the live receivers, using `@etherfold/core`'s own
 * comparison, so a target cannot select a receiver that then refuses the batch.
 *
 * What it will NOT do is invent an answer when nothing matches. See
 * {@link NoLiveReceiverError} for why the empty case and the foreign-context case
 * are the same refusal carrying different `retryable` flags.
 */
export function createDirectIngestion(ingestion: LogIngestion | LiveIngestions): IngestionTarget {
	/**
	 * The receiver this ask is FOR, resolved now rather than captured.
	 *
	 * The single-receiver arm keeps its exact behaviour, comment and all: the
	 * asker's context is IGNORED, because there is nothing to select between and
	 * answering from anything but it would be inventing a second address in a
	 * process that has one. The wrong-source check still happens, one step later,
	 * off the context handed BACK.
	 */
	async function receiverFor(context: WireContext): Promise<LogIngestion> {
		if (typeof ingestion !== 'function') return ingestion;
		const live = await ingestion();
		const found = live.find((receiver) => sameWireContext(receiver.context, context));
		if (found) return found;
		throw new NoLiveReceiverError(
			live.map((receiver) => receiver.context),
			context,
		);
	}

	return {
		async expectedFromBlock(context: WireContext) {
			const receiver = await receiverFor(context);
			// The context is handed BACK as well, so a combined deployment that wired the
			// wrong source together still fails at the ask instead of after a fetch -- which
			// is the same check, made by the same side, as on the wire.
			return {expectedFromBlock: await receiver.expectedFromBlock(), context: receiver.context};
		},

		async send(batch: WireBatch<Abi>): Promise<IngestionResponse> {
			// RESOLVED PER BATCH and never per process: a deployment whose live receiver
			// moved between two cycles feeds the one it holds NOW, which is the whole reason
			// the resolving arm exists.
			const receiver = await receiverFor(batch.context);
			try {
				const outcome = await receiver.receive(batch as UntypedWireBatch);
				return {
					accepted: true,
					expectedFromBlock: outcome.expectedFromBlock,
					applied: outcome.applied,
					retracted: outcome.retracted,
					reorg: outcome.reorg,
				};
			} catch (err) {
				const refusal = err as {name?: string; expectedFromBlock?: unknown};
				if (refusal?.name === 'UnexpectedFromBlockError' && typeof refusal.expectedFromBlock === 'number') {
					return {accepted: false, expectedFromBlock: refusal.expectedFromBlock};
				}
				// everything else is what it already was, including its `retryable` flag:
				// there is no status code here to flatten it into
				throw err;
			}
		},
	};
}
