import type {Abi} from 'abitype';
import type {IngestionResponse, IngestionTarget} from './logFetcher.js';
import type {LogIngestion} from './streamBuilder.js';
import type {UntypedWireBatch, WireBatch} from './types.js';

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
 */
export function createDirectIngestion(ingestion: LogIngestion): IngestionTarget {
	return {
		async expectedFromBlock() {
			// The asker's own context is deliberately IGNORED here: there is exactly one
			// receiver in this shape, so there is nothing to select between, and answering
			// from anything but it would be inventing a second address in a process that
			// has one. The context is handed BACK as well, so a combined deployment that
			// wired the wrong source together still fails at the ask instead of after a
			// fetch -- which is the same check, made by the same side, as on the wire.
			return {expectedFromBlock: await ingestion.expectedFromBlock(), context: ingestion.context};
		},

		async send(batch: WireBatch<Abi>): Promise<IngestionResponse> {
			try {
				const outcome = await ingestion.receive(batch as UntypedWireBatch);
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
