import type {Abi, FoldReporter, LastSync, LogEvent} from '@etherfold/core';
import {createMutationContext, type Mutation, type StateStore, type WritableStateStore} from '@etherfold/state-store';
import {logs} from 'named-logs';
import {serializeLastSync, syncedThrough} from './cursor.js';
import {blockPointer, forkPoint, groupByBlock} from './stream.js';
import type {EntityProcessor} from './types.js';

const logger = logs('@etherfold/processor-entities');

/**
 * Run the author's handlers over ONE block's events, collecting the mutations.
 *
 * The staging area is what gives read-your-writes inside the block, and the
 * result is coalesced per business key: see `createMutationContext`.
 */
export async function runBlockHandlers<ABI extends Abi, ProcessorConfig>(
	store: StateStore,
	processor: EntityProcessor<ABI, ProcessorConfig>,
	events: readonly LogEvent<ABI>[],
	config: ProcessorConfig,
): Promise<Mutation[]> {
	const {state, mutations} = createMutationContext(store);

	for (const event of events) {
		if ('decodeError' in event) {
			if (processor.handleUnparsedEvent) {
				await processor.handleUnparsedEvent(state, event);
			}
			continue;
		}
		const handler = (processor as Record<string, unknown>)[`on${event.eventName}`];
		if (typeof handler === 'function') {
			await (handler as (...args: unknown[]) => unknown | Promise<unknown>).call(processor, state, event, config);
		}
	}

	return mutations();
}

/**
 * Apply a whole stream to a store, reverting first if any of it is a retraction.
 *
 * This is the backend-agnostic half of processing, and every backend gets it
 * identically because it is written once, here, against `StateStore`. The stream
 * is a flat list in which reorged-out events carry `removed: true` and are
 * followed by the canonical replacements, if there are any. Three things about
 * how that becomes storage calls are load-bearing:
 *
 * 1. **Revert ONCE, at the fork point**, not per removed event. The fork point
 *    is one below the LOWEST removed block in the stream, and it has to be
 *    computed over the whole stream before anything is applied. Reverting per
 *    event would issue N reverts where the second is a no-op at best and, if the
 *    events were ordered high-to-low, would revert to the wrong height.
 *
 * 2. **A removed event is a removed event, whatever caused it.** The engine
 *    emits retractions both when a height is replaced by a different hash (a
 *    contradiction) and when a block's logs simply vanish with no replacement
 *    (an absence: the transaction went back to the mempool). This reads `removed`
 *    and never looks at what replaced anything, so the second case cannot be
 *    missed. Wiring the revert to "a new hash appeared at this height" would
 *    reproduce `d24872f` one layer down, where the symptom is a row nobody
 *    notices instead of a state object somebody prints.
 *
 * 3. **Revert precedes apply**, which is also what makes replay safe. A store
 *    records a block plainly and a re-applied block raises on purpose.
 *    `revertTo(fork)` drops every block above the fork, and the canonical events
 *    in the same stream are all at or above `fork + 1`, so the replacements
 *    cannot collide with the branch they replace.
 *
 * One block is exactly one `applyBlock`, which is one atomic unit, which is why
 * a handler never has to reason about more than the block it is in.
 *
 * 4. **The cursor rides WITH the block**, when one is given. `cursor` is the
 *    `LastSync` this stream ends at, and each block is applied together with the
 *    cursor that describes THAT block (`syncedThrough`), in the store's own
 *    transaction. That is why the cursor lives behind the storage seam: nothing
 *    above the store can make the two atomic, and the gap between them is not
 *    self-healing in either direction (see `cursor.ts`). A caller that omits it
 *    -- a test, or the conformance workload -- gets the old behaviour and owns
 *    its own cursor.
 *
 * 5. **A block that was applied is REPORTED**, when a reporter is given, and it
 *    is reported from HERE because this is where the mutations are. The
 *    `Mutation` objects carry the entity name and `@etherfold/core` has no
 *    mutation vocabulary at all, so the touched-entity set is produced at this
 *    layer and RELAYED upward into the signal a reader learns from (ADR-0083).
 *    One report per `applyBlock` that RETURNED, after it returned: a block that
 *    threw was not applied, and reporting it would tell a reader to re-read for a
 *    change that is not there. A block whose handlers produced NO mutation is
 *    still reported, with an empty set -- it was applied, the cursor moved with
 *    it, and "applied" is the thing being reported.
 *
 * 6. **The REVERT is reported too, naming the fork point**, and it is reported
 *    from here for the same reason: rule 1's fork point is derived HERE, from the
 *    `removed` markers core emitted, and core is where the reader-facing signal is
 *    assembled. A reorg WITHDRAWS data, so a channel that reported only rule 5
 *    would leave a reader rendering the branch the chain abandoned. It is reported
 *    AFTER `revertTo` returned and BEFORE the replacements are applied, which is
 *    the order they happened in: a reader told the other way round would re-read
 *    the replacement and then be told to throw it away. What it names is the fork
 *    point and NOT the rows that moved -- `revertTo` answers `void` at the seam,
 *    on purpose, and the token that rotates with this retraction already says
 *    invalidate everything.
 */
export async function applyEventStream<ABI extends Abi, ProcessorConfig>(
	store: WritableStateStore,
	processor: EntityProcessor<ABI, ProcessorConfig>,
	eventStream: readonly LogEvent<ABI>[],
	config: ProcessorConfig,
	cursor?: {key: string; lastSync: LastSync<ABI>},
	report?: FoldReporter,
): Promise<void> {
	const fork = forkPoint(eventStream);
	if (fork !== undefined) {
		logger.info(`retraction in stream: reverting state above block ${fork}`);
		await store.revertTo(fork);
		// AFTER the revert returned, exactly as a block is reported after it landed: a
		// revert that threw took nothing back, and telling a reader otherwise would
		// rotate a token over a branch that is still standing.
		report?.({kind: 'retracted', forkPoint: fork});
	}

	const blocks = groupByBlock(eventStream);
	for (const [index, block] of blocks.entries()) {
		const mutations = await runBlockHandlers(store, processor, block.events, config);
		// The LAST block carries the stream's own cursor rather than a truncated one:
		// the stream covered every block up to `lastToBlock`, so the heights above it
		// carry none of our logs and there is nothing left to apply between them.
		const write =
			cursor &&
			(index === blocks.length - 1
				? {key: cursor.key, value: serializeLastSync(cursor.lastSync)}
				: {key: cursor.key, value: serializeLastSync(syncedThrough(cursor.lastSync, block.number))});
		await store.applyBlock(blockPointer(block), mutations, write);
		report?.({kind: 'applied', block: block.number, entities: entitiesTouchedBy(mutations)});
	}

	// A stream with no blocks in it is still progress: a range that carried none of
	// our logs was scanned, and a cursor that did not record it would have every
	// restart re-scan it forever. There is no block to be atomic WITH, and none is
	// needed: nothing was applied, so a crash here costs a re-scan and not a wedge.
	if (cursor && blocks.length === 0) {
		await store.writeCursor(cursor.key, serializeLastSync(cursor.lastSync));
	}
}

/**
 * The entity NAMES a block's mutations touched: deduplicated, and SORTED so that
 * two runs of one block produce one payload.
 *
 * NAMES and not ids (ADR-0083): the set is bounded by the DECLARATION rather
 * than by the block, so the worst block on the real measured stream (457
 * mutations) reports at most as many names as the processor declares. Derived
 * from the mutations ACTUALLY applied, so a declared entity nothing touched is
 * absent -- which is what makes narrow invalidation worth anything.
 */
function entitiesTouchedBy(mutations: readonly Mutation[]): string[] {
	return [...new Set(mutations.map((mutation) => mutation.entity))].sort();
}
