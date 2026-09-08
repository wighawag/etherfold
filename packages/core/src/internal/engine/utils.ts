import type {Abi} from 'abitype';
import {logs} from 'named-logs';
import {InvalidBatchError, TimestamplessLogError, UnexpectedFromBlockError} from '../../errors.js';
import type {
	AllContractData,
	ArgumentFilter,
	ContextIdentifier,
	EventBlock,
	FilterRule,
	IndexingSource,
	LastSync,
	LogEvent,
	LogParseConfig,
	ProvidedStreamConfig,
	SourceHashEntry,
	UsedStreamConfig,
	WireContext,
} from '../../types.js';
import {canonical_form, simple_hash} from '../../utils/hash.js';
import {normalizeAddress} from '../utils/address.js';

const namedLogger = logs('@etherfold/core');

/**
 * How a reorg was concluded.
 *
 * - `contradiction`: the same block height now carries a DIFFERENT hash. This is proof.
 * - `absence`: a block we held is simply not present in the re-fetched range. This is an
 *   INFERENCE, and it is indistinguishable from a sender that under-delivered the range
 *   (a truncated `eth_getLogs`, a wrong address/topic filter). It still reverts state, so
 *   it is reported separately and loudly. See `docs/adr/0004`.
 */
export type ReorgCause = 'contradiction' | 'absence';

export type ReorgDetection = {cause: ReorgCause; blockNumber: number; blockHash: string};

export function wait(seconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export type BlockOfEvents<ABI extends Abi> = {hash: string; number: number; events: LogEvent<ABI>[]};

/**
 * Group the logs of a FETCH, which is a complete re-read of a block range and
 * carries no verdicts.
 *
 * This is the FETCH rule and it is NOT the replay rule -- a distinction worth
 * stating because reading it as one is precisely the defect ADR-0042 closes. A
 * `removed` marker is dropped here because a stateless `eth_getLogs` cannot
 * produce one, so its presence means the input is not a fetch; a stored
 * EMISSION stream, where the marker IS the retraction, is grouped by
 * `groupStreamPerBlock` and walked by `generateStreamFromReplay`, and
 * `IndexerGeneration.feed` refuses one rather than quietly handing it here.
 */
export function groupLogsPerBlock<ABI extends Abi>(logEvents: LogEvent<ABI>[]): BlockOfEvents<ABI>[] {
	const groups: {[hash: string]: BlockOfEvents<ABI>} = {};
	const logEventsGroupedPerBlock: BlockOfEvents<ABI>[] = [];
	for (const event of logEvents) {
		if (event.removed) {
			// we skip event removed as we deal with them manually
			// we do not even expect them to be possible here
			// the system is designed to be operating with stateless eth_getLogs rather than stateful filter
			continue;
		}
		let group = groups[event.blockHash];
		if (!group) {
			group = groups[event.blockHash] = {
				hash: event.blockHash,
				number: event.blockNumber,
				events: [],
			};
			logEventsGroupedPerBlock.push(group);
		}
		group.events.push(event);
	}
	return logEventsGroupedPerBlock;
}

/**
 * Group an ALREADY-GENERATED stream for delivery, retractions included.
 *
 * This is the counterpart to `groupLogsPerBlock`, and the difference is the
 * whole point. `groupLogsPerBlock` groups logs coming IN from a fetch, where a
 * `removed` marker has no business existing and is dropped. This groups the
 * stream going OUT to a processor, where a `removed` marker is the retraction
 * itself and dropping it loses the only instruction to revert.
 *
 * Retracted and applied events are kept in SEPARATE groups even when they share
 * a block hash, which they genuinely can: when a reorg is detected at the first
 * unconfirmed block, every later unconfirmed block is retracted too, and a
 * re-fetch that still contains one of them re-applies it under the same hash.
 * Merging those two into one group would hand the processor a block that is
 * simultaneously retracted and applied.
 *
 * The grouping is over CONSECUTIVE RUNS and not over the whole list, which
 * matters as soon as the stream being grouped is a whole STORED stream rather
 * than one generated batch. A stream that spans many cycles can apply a block,
 * retract it and apply it again under the same hash (the chain went A, then B,
 * then back to A), and keying a map by `{removed, hash}` alone would fold that
 * third emission back into the FIRST group -- delivering the re-application
 * before the retraction it undoes. A run boundary is exactly one emission, which
 * is the unit the stream is written in.
 */
export function groupStreamPerBlock<ABI extends Abi>(
	stream: LogEvent<ABI>[],
): (BlockOfEvents<ABI> & {removed: boolean})[] {
	const ordered: (BlockOfEvents<ABI> & {removed: boolean})[] = [];
	let current: (BlockOfEvents<ABI> & {removed: boolean}) | undefined;
	for (const event of stream) {
		const removed = event.removed ? true : false;
		if (!current || current.hash !== event.blockHash || current.removed !== removed) {
			current = {hash: event.blockHash, number: event.blockNumber, events: [], removed};
			ordered.push(current);
		}
		current.events.push(event);
	}
	return ordered;
}

/** One `process()` call's worth of a generated stream: the events, and the cursor TRUE OF THEM ALONE. */
export type DeliveryBatch<ABI extends Abi> = {
	events: LogEvent<ABI>[];
	lastSync: LastSync<ABI>;
};

/**
 * CUT A GENERATED STREAM INTO THE `process()` CALLS IT IS DELIVERED IN, and give
 * each one a cursor that is true on its own.
 *
 * Extracted because TWO paths deliver a generated stream to a processor and the
 * rule must not fork: `IndexerGeneration.promiseToFeed` (the single-process
 * engine) and `GenerationRebuild` (the chain-free, bounded catch-up on the
 * server and the CLI). It is a pure cut, so each caller keeps its own
 * notifications, cancellation and pacing.
 *
 * Three rules, and each of them is a bug that has been paid for:
 *
 * 1. **Every retraction goes in ONE batch, whatever `batchSize` says.** A revert
 *    is a single decision about a fork point, so splitting it across two calls
 *    would leave the processor briefly holding half a dead branch, and a
 *    processor that reverts to the lowest retracted block would compute that fork
 *    point from a partial view.
 * 2. **A batch STOPS at the first retraction after it**, which is what keeps an
 *    application and its OWN retraction out of one call. A REPLAY can carry both
 *    -- the stored stream holds `+X`, `-X` and the replacement `+Y` at ONE block
 *    -- and a store records a block plainly, so handing all three to one call
 *    reverts to the fork and then applies two blocks at the same height, which is
 *    a primary-key collision and not a fold. That falls out of the two loops
 *    below rather than being a rule of its own, and it is the reason a REPLAY
 *    cannot skip this cut while a FETCH can (`StreamBuilder` does): in a fetch a
 *    retraction always refers to something an earlier batch applied.
 * 3. **Each batch's cursor is narrowed to what IT has folded**, and only the LAST
 *    gets the stream's own. The processor PERSISTS the cursor it is handed, so an
 *    intermediate batch carrying the FINAL window would claim to have synced
 *    through X while listing blocks above X as folded -- and resuming from that
 *    skips exactly the blocks in between, permanently and without a word. A
 *    retraction-only batch has folded nothing above the fork, so it reports the
 *    fork point: that IS a move backwards, and it is correct, because the state
 *    really is back there until the replacements land.
 */
export function batchStreamForDelivery<ABI extends Abi>(
	eventStream: LogEvent<ABI>[],
	newLastSync: LastSync<ABI>,
	batchSize: number,
): DeliveryBatch<ABI>[] {
	// Retractions are delivered, not dropped. `groupLogsPerBlock` skips `removed`
	// events, which is right for logs coming IN from a fetch and wrong here: this
	// stream is what the PROCESSOR consumes, and a `removed` marker is the only
	// instruction it ever gets to revert.
	const eventsInGroups = groupStreamPerBlock(eventStream);
	const batches: DeliveryBatch<ABI>[] = [];
	while (eventsInGroups.length > 0) {
		const list: LogEvent<ABI>[] = [];
		while (eventsInGroups.length > 0 && (eventsInGroups[0] as {removed: boolean}).removed) {
			list.push(...(eventsInGroups.shift() as {events: LogEvent<ABI>[]}).events);
		}
		while (eventsInGroups.length > 0 && !(eventsInGroups[0] as {removed: boolean}).removed && list.length < batchSize) {
			list.push(...(eventsInGroups.shift() as {events: LogEvent<ABI>[]}).events);
		}
		if (list.length === 0) {
			// unreachable while `batchSize` is at least 1, and a `break` rather than a
			// `continue` so that a zero one cannot spin instead of finishing
			break;
		}
		const applied = list.filter((event) => !event.removed);
		const isFinalBatch = eventsInGroups.length === 0;
		const foldedThrough =
			applied.length > 0
				? (applied[applied.length - 1] as LogEvent<ABI>).blockNumber
				: Math.max(0, Math.min(...list.map((event) => event.blockNumber)) - 1);
		batches.push({
			events: list,
			lastSync: isFinalBatch ? newLastSync : cursorSyncedThrough(newLastSync, foldedThrough),
		});
	}
	return batches;
}

/**
 * Turn a STORED emission stream back into the stream to deliver, honouring the
 * verdicts it already carries.
 *
 * This is the IN direction of the same seam `groupStreamPerBlock` is the OUT
 * direction of, and it exists because a REPLAY is not a FETCH.
 * `generateStreamToAppend` takes raw logs from a stateless `eth_getLogs` -- a
 * complete re-read of a range, carrying no verdicts -- and DERIVES every
 * retraction by comparing the cursor's unconfirmed window against the incoming
 * blocks by number. A stored stream is the opposite kind of input: it is a
 * DELTA that already records what was applied and what was taken back, at the
 * original block, flagged `removed`.
 *
 * Routing one through the other is the defect this closes. A rebuild starts from
 * a fresh cursor whose window is EMPTY, so there was nothing to derive a
 * retraction from, and `groupLogsPerBlock` drops the `removed` events out of
 * what it is handed (rightly: in a fetch such a marker has no business
 * existing). A stream containing a reorg therefore replayed as both branches
 * applied as live blocks, with no revert anywhere.
 *
 * ## The WINDOW is rebuilt by walking the stream, not by filtering it
 *
 * The cursor a replay leaves behind must be the one the live run held, window
 * included, or the first tip cycle after it re-reads the finality window, finds
 * the replacement block missing from the window, and applies it a SECOND time.
 * So the walk maintains the window as it goes: an applied block enters it, a
 * retracted block LEAVES it. Filtering the stream for its non-`removed` entries
 * instead would leave both branches of a reorg at one height -- a window no live
 * run ever held.
 *
 * The walk deliberately does NOT prune by finality as it goes, only at the end:
 * the stored stream records no per-batch chain tip, and keeping every live block
 * in hand until the end is what guarantees a retraction always finds the block
 * it retracts. The final prune uses `newLastToBlock`, which is the carry-forward
 * rule `generateStreamToAppend` applies to a block it is keeping.
 *
 * ## Why the window is also what DE-DUPLICATES
 *
 * A replay has two shapes. A REBUILD hands over the whole stream against an
 * empty window. A CATCH-UP hands over the part of it above a kept state's resume
 * point, which reaches back over the finality window and therefore re-offers
 * blocks that state already applied -- and those are exactly the blocks in its
 * window. So an applied block whose hash is already there is SKIPPED rather than
 * delivered twice. That is the same job the fetch path's window-membership test
 * does (`generateStreamToAppend`), and the two are decided the same way for the
 * same reason: a held block is named by its hash, never by a height, because a
 * height names whichever branch won.
 */
export function generateStreamFromReplay<ABI extends Abi>(
	lastSync: LastSync<ABI>,
	defaultFromBlock: number,
	storedStream: LogEvent<ABI>[],
	{
		newLatestBlock,
		newLastFromBlock,
		newLastToBlock,
		finality,
	}: {newLatestBlock: number; newLastFromBlock: number; newLastToBlock: number; finality: number},
): {eventStream: LogEvent<ABI>[]; newLastSync: LastSync<ABI>} {
	const expectedFromBlock = getFromBlock(lastSync, defaultFromBlock, finality);
	if (newLastFromBlock !== expectedFromBlock) {
		// The same refusal `generateStreamToAppend` makes, for the same reason: a
		// stream that does not reach back to where this cursor resumes would leave a
		// hole behind a cursor claiming to cover it.
		throw new UnexpectedFromBlockError(expectedFromBlock, newLastFromBlock);
	}

	// Keyed by block HASH, and ORDERED by first appearance. A hash names one block;
	// a height names whichever branch won, which is the thing under dispute here.
	const live = new Map<string, EventBlock<ABI>>();
	const order: string[] = [];
	for (const unconfirmedBlock of lastSync.unconfirmedBlocks) {
		if (!live.has(unconfirmedBlock.hash)) {
			order.push(unconfirmedBlock.hash);
		}
		live.set(unconfirmedBlock.hash, unconfirmedBlock);
	}

	const eventStream: LogEvent<ABI>[] = [];
	for (const group of groupStreamPerBlock(storedStream)) {
		if (group.removed) {
			if (!live.has(group.hash)) {
				// nothing to take back: this block was never applied under this cursor, so
				// telling the processor to revert it would be an instruction about state it
				// does not hold
				continue;
			}
			live.delete(group.hash);
			eventStream.push(...group.events);
		} else {
			if (live.has(group.hash)) {
				// already applied: a catch-up replay re-offers the window it reached back over
				continue;
			}
			live.set(group.hash, {
				hash: group.hash,
				number: group.number,
				events: group.events.map((event) => ({...event})),
			});
			order.push(group.hash);
			eventStream.push(...group.events);
		}
	}

	// The finality prune happens ONCE, here, and not during the walk: a stored
	// stream records no per-batch chain tip, and keeping every live block in hand
	// until the end is what guarantees a retraction always finds the block it
	// retracts. `newLastToBlock` is the bound `generateStreamToAppend` carries a
	// block forward on, which is what a replayed block is.
	const newUnconfirmedBlocks: EventBlock<ABI>[] = [];
	const kept = new Set<string>();
	for (const hash of order) {
		const block = live.get(hash);
		if (!block || kept.has(hash)) {
			// retracted on the way through, or already taken: a hash that was applied,
			// retracted and applied again appears in `order` twice
			continue;
		}
		kept.add(hash);
		if (newLastToBlock - block.number <= finality) {
			newUnconfirmedBlocks.push(block);
		}
	}
	// ASCENDING, which is what the next fetch reads it as: `generateStreamToAppend`
	// walks this list in order and stops at the first block the incoming range
	// contradicts, so a window out of block order would conclude the wrong fork
	// point. First-appearance order is already ascending for every stream a fetch
	// path writes; the sort says so rather than assuming it.
	newUnconfirmedBlocks.sort((a, b) => a.number - b.number);

	return {
		eventStream,
		newLastSync: {
			context: lastSync.context,
			lastFromBlock: newLastFromBlock,
			latestBlock: newLatestBlock,
			lastToBlock: newLastToBlock,
			unconfirmedBlocks: newUnconfirmedBlocks,
		},
	};
}

/**
 * The identity of a block in the unconfirmed window: its HEIGHT and its HASH.
 *
 * Both halves, because neither alone answers "have we already applied this". A
 * height names whichever branch won, which is the thing under dispute during a
 * reorg; a hash alone would let a block be matched at a height nothing claims.
 * It is the key `generateStreamFromReplay` walks its window by, spelled here so
 * the two paths cannot drift into two ideas of what a held block is.
 */
function windowKeyOf(number: number, hash: string): string {
	return `${number}:${hash}`;
}

/**
 * Shape a FETCH -- a complete re-read of a block range -- into the stream to
 * append, deriving every retraction from the unconfirmed window.
 *
 * ## A re-fetched block is NEW unless the window already holds it
 *
 * The rule that decides which incoming blocks are DELIVERED is MEMBERSHIP of the
 * retained window, by `(number, hash)`. It is not a height threshold, and it was
 * one: the function used to admit a block only at or above
 * `startingBlockForNewEvent` (`reorgBlock.number` on a reorg, the window's top
 * plus one otherwise). That threshold encodes the claim "we already hold
 * everything below this height", and the claim is FALSE, because
 * `unconfirmedBlocks` holds only EVENT-BEARING blocks and is therefore SPARSE:
 * its lowest entry is usually far above the height the chain actually forked at.
 * So when the fork was below the lowest block we held logs for, every log the
 * replacement branch carried in that gap was inside the re-fetched range,
 * dropped by the comparison, and never fetched again -- the next range starts
 * above it. Silent, permanent loss (`docs/adr/0051`).
 *
 * Membership is SOUND because of an invariant `getFromBlock` maintains: a
 * re-fetch never starts below `latestBlock - finality`, and a block that carried
 * events inside that window entered `unconfirmedBlocks` when it was applied. So
 * every incoming block we have already applied is still in the window -- unless
 * it was RETRACTED, which is why the test reads the window that SURVIVED the
 * retraction rather than the one we arrived with. "The window holds it" is
 * therefore a complete test for "we already applied it", and nothing is
 * delivered twice.
 *
 * It is also the rule the REPLAY path in this file already applies, by hash, for
 * the same de-duplication reason. The two were meant to agree; only one of them
 * got the sparse-window case right.
 */
export function generateStreamToAppend<ABI extends Abi>(
	lastSync: LastSync<ABI>,
	defaultFromBlock: number,
	newEvents: LogEvent<ABI>[],
	{
		newLatestBlock,
		newLastFromBlock,
		newLastToBlock,
		finality,
	}: {newLatestBlock: number; newLastFromBlock: number; newLastToBlock: number; finality: number},
): {eventStream: LogEvent<ABI>[]; newLastSync: LastSync<ABI>; reorg?: ReorgDetection} {
	const expectedFromBlock = getFromBlock(lastSync, defaultFromBlock, finality);

	if (newLastFromBlock !== expectedFromBlock) {
		// Typed, because this refusal IS the resumption protocol of ADR-0004: the
		// receiving side answers with the block the sender must re-send from, and a
		// caller that had to parse that number out of the message would break the
		// next time the message was reworded. Thrown from HERE, before a single
		// event is shaped, so a refused batch applies nothing by construction.
		throw new UnexpectedFromBlockError(expectedFromBlock, newLastFromBlock);
	}

	const logEventsGroupedPerBlock = groupLogsPerBlock(newEvents);
	const eventStream: LogEvent<ABI>[] = [];

	const lastUnconfirmedBlocks = lastSync.unconfirmedBlocks;

	// find reorgs
	//
	// This is driven by the blocks we previously held as unconfirmed, NOT by the incoming list.
	// A reorg can REMOVE a block's logs without replacing them at another block-with-logs (the
	// transaction went back to the mempool and is not re-mined yet), in which case the re-fetch
	// legitimately returns FEWER blocks than we hold. Iterating the incoming list would then
	// never look at the vanished block, so its events would never be retracted and it would
	// later be pruned from unconfirmedBlocks silently, baking the dead branch into the state.
	//
	// Incoming blocks are therefore matched by block NUMBER: a missing entry (block no longer
	// has any of our logs) and a differing hash (block replaced) are both a reorg at that block.
	const newBlockHashPerNumber = new Map<number, string>();
	for (const block of logEventsGroupedPerBlock) {
		newBlockHashPerNumber.set(block.number, block.hash);
	}

	let reorgBlock: EventBlock<ABI> | undefined;
	let reorgCause: ReorgCause | undefined;
	let reorgedBlockIndex = 0;
	for (let i = 0; i < lastUnconfirmedBlocks.length; i++) {
		const unconfirmedBlock = lastUnconfirmedBlocks[i];
		if (unconfirmedBlock.number < newLastFromBlock || unconfirmedBlock.number > newLastToBlock) {
			// the re-fetch did not cover this block, so its absence proves nothing
			reorgedBlockIndex = i + 1;
			continue;
		}
		const newHashAtSameHeight = newBlockHashPerNumber.get(unconfirmedBlock.number);
		if (newHashAtSameHeight !== unconfirmedBlock.hash) {
			reorgBlock = unconfirmedBlock;
			// A CONTRADICTION is proof: the same height now carries a different block.
			// An ABSENCE is an inference: the block simply is not in the payload, which is
			// indistinguishable from a sender that under-delivered the range (a truncated
			// eth_getLogs, a wrong filter). Both revert state, so the two are reported
			// separately: a rising rate of absence-driven reverts means truncation or
			// misconfiguration, not chain activity. See docs/adr/0004.
			reorgCause = newHashAtSameHeight === undefined ? 'absence' : 'contradiction';
			reorgedBlockIndex = i;
			break;
		}
		reorgedBlockIndex = i + 1;
	}

	if (reorgBlock && reorgCause) {
		const detail = {
			cause: reorgCause,
			blockNumber: reorgBlock.number,
			blockHash: reorgBlock.hash,
			fromBlock: newLastFromBlock,
			toBlock: newLastToBlock,
		};
		if (reorgCause === 'absence') {
			namedLogger.error(
				`reorg concluded from ABSENCE: block ${reorgBlock.number} (${reorgBlock.hash}) carries no logs in the re-fetched range [${newLastFromBlock}, ${newLastToBlock}]. State will be reverted. If this is frequent, suspect a truncated log fetch or a wrong filter rather than chain reorgs.`,
				detail,
			);
		} else {
			namedLogger.info(`reorg detected at block ${reorgBlock.number} (${reorgBlock.hash} replaced)`, detail);
		}
	}

	if (reorgBlock) {
		// re-add event to the stream but flag them as removed
		for (let i = reorgedBlockIndex; i < lastUnconfirmedBlocks.length; i++) {
			for (const event of lastUnconfirmedBlocks[i].events) {
				eventStream.push({
					...event,
					removed: true,
				});
			}
		}
	}

	// THE RETAINED WINDOW: the blocks we applied and did NOT just take back.
	//
	// The retraction above re-emitted `reorgedBlockIndex` onward as `removed`, so
	// they have left the window and a re-offer of one of them is NEW again -- which
	// is exactly what a reorg concluded at the first window block produces, where
	// every later block is retracted and the re-fetch still carries some of them
	// under their own hashes. Where nothing reorged the walk above ran to the end,
	// so `reorgedBlockIndex` is the window's length and this is all of it.
	const retainedBlocks = lastUnconfirmedBlocks.slice(0, reorgedBlockIndex);
	const retained = new Set(retainedBlocks.map((block) => windowKeyOf(block.number, block.hash)));

	// new events and new unconfirmed blocks
	const newUnconfirmedBlocks: EventBlock<ABI>[] = [];

	// re-add older unconfirmed blocks that might get reorg later still
	// only if they are new enough (finality check)
	for (const unconfirmedBlock of retainedBlocks) {
		if (newLastToBlock - unconfirmedBlock.number <= finality) {
			newUnconfirmedBlocks.push(unconfirmedBlock);
		}
	}

	for (const block of logEventsGroupedPerBlock) {
		const isUnconfirmedBlock = newLatestBlock - block.number <= finality;
		// A block is NEW unless the retained window already holds it, hash included.
		// Never "new because it is above some height", which is the claim a SPARSE
		// window cannot support: see the function's own doc comment.
		if (block.events.length > 0 && !retained.has(windowKeyOf(block.number, block.hash))) {
			const newEventsPerBlock: LogEvent<ABI>[] = [];
			for (const event of block.events) {
				eventStream.push(event);
				if (isUnconfirmedBlock) {
					newEventsPerBlock.push({...event});
				}
			}
			if (isUnconfirmedBlock) {
				newUnconfirmedBlocks.push({
					hash: block.hash,
					number: block.number,
					events: newEventsPerBlock,
				});
			}
		}
	}

	// ASCENDING, which is what every reader of this window assumes: the next
	// cycle's reorg walk stops at the first block the incoming range contradicts,
	// and `cursorSyncedThrough` cuts the window as a PREFIX. Under the old height
	// threshold the order fell out for free, because nothing below a retained block
	// could be delivered. Membership removes that guarantee -- a block the window
	// never held can now be delivered from below the lowest retained one -- so the
	// order is stated rather than assumed, exactly as `generateStreamFromReplay`
	// states it. The sort is stable, so a retained block stays ahead of a delivered
	// block at the same height.
	newUnconfirmedBlocks.sort((a, b) => a.number - b.number);

	return {
		eventStream,
		newLastSync: {
			context: lastSync.context,
			lastFromBlock: newLastFromBlock,
			latestBlock: newLatestBlock,
			lastToBlock: newLastToBlock,
			unconfirmedBlocks: newUnconfirmedBlocks,
		},
		reorg:
			reorgBlock && reorgCause
				? {cause: reorgCause, blockNumber: reorgBlock.number, blockHash: reorgBlock.hash}
				: undefined,
	};
}

/**
 * The block numbers of a payload must ASCEND, and a payload that does not is
 * REFUSED rather than quietly repaired.
 *
 * The engine reads a payload in order and DELIVERS it in that order, so an
 * unordered payload becomes an unordered stream: a processor reverts once at the
 * fork point and then applies each block as it comes, and a block arriving after
 * a higher-numbered one is applied out of order, against a store that has
 * already recorded blocks above it. Losing or misplacing logs is the one outcome
 * an indexer must never produce quietly.
 *
 * It used to be worse than misordered: while a HEIGHT decided which incoming
 * blocks were new, a group appearing after a higher-numbered one was DROPPED
 * outright, and the window it left behind put the next cycle's boundary wrong
 * too. Window membership (`generateStreamToAppend`) removed that particular
 * damage -- a block is judged by what the window holds and not by where it sits
 * in the payload -- which is why this refusal is now about ORDER OF DELIVERY
 * alone. It is not a reason to relax it.
 *
 * Refusing rather than sorting is deliberate. `eth_getLogs` returns logs in
 * ascending order, and no node has a reason to do otherwise, so an unordered
 * payload means something upstream is wrong -- a merging proxy, a sharded
 * provider reassembling shards, a host building a batch by hand. Sorting would
 * paper over that and leave the real fault to surface later as missing data;
 * failing names it at the point it can still be traced. If a provider is ever
 * found doing this legitimately, this is the place to revisit, with the evidence
 * in hand.
 *
 * Equal block numbers are fine: several logs share a block, and their order
 * within it is the node's `logIndex`, not this rule's business.
 */
export function assertAscendingByBlock<ABI extends Abi>(logs: readonly LogEvent<ABI>[], source: string): void {
	for (let i = 1; i < logs.length; i++) {
		const previous = logs[i - 1];
		const current = logs[i];
		if (current.blockNumber < previous.blockNumber) {
			throw new InvalidBatchError(
				`${source} carries a log at block ${current.blockNumber} after one at block ${previous.blockNumber}. ` +
					`Logs must ascend by block: the engine reads a payload in order, and a block appearing after a higher ` +
					`one is dropped rather than folded. This is refused instead of sorted because a node returning logs out ` +
					`of order means something upstream reordered them, and silently repairing it hides that.`,
			);
		}
	}
}

/**
 * Every log a fetch returned carries a `blockTimestamp`, and a range holding one
 * that does not is REFUSED at the fetch boundary.
 *
 * This is the fetch-boundary half of the two-place refusal of ADR-0073, and it
 * is here -- beside `assertAscendingByBlock` -- because it is the same kind of
 * check: ONE property of the node's answer, asserted once, by both deployment
 * shapes of ADR-0003 (the single-process `IndexerGeneration` and the split
 * `LogFetcher`, which is the only side of a split that talks to a chain).
 *
 * It refuses ONE ROUND TRIP IN, before the range is enriched, folded, stored or
 * pushed, and it names the NODE rather than the block, because every cause is
 * node-level and the operator's fix differs per cause (see
 * `TimestamplessLogError`, which carries the four).
 *
 * `blockTimestamp` is read TOLERANTLY on the way in (`parseLogBlockTimestamp`:
 * hex or decimal quantity, and anything else dropped rather than coerced), so
 * "the node sent nothing" and "the node sent something unreadable" arrive here
 * as ONE outcome, `undefined`. That is deliberate and must stay: neither may
 * become a number, and this is the place that turns the absence into a refusal
 * rather than into a guess.
 *
 * It does NOT replace `blockPointer`'s fold-time refusal, which sees streams
 * this never can (a seed install, a fixture replay). See `TimestamplessLogError`.
 */
export function assertLogsCarryTimestamps<ABI extends Abi>(logs: readonly LogEvent<ABI>[], source: string): void {
	for (const log of logs) {
		if (log.blockTimestamp === undefined) {
			throw new TimestamplessLogError(log.blockNumber, log.blockHash, source);
		}
	}
}

/**
 * The cursor that describes a fold SYNCED THROUGH `blockNumber`, and the one
 * rule for narrowing a cursor anywhere in this system.
 *
 * A cursor is not a label, it is a claim that can be resumed from, so every
 * cursor that is PUBLISHED or PERSISTED has to be true on its own. Narrowing one
 * is therefore not "copy it and lower `lastToBlock`": the unconfirmed window is
 * the set of blocks already folded, and the engine treats the top of it as the
 * boundary above which events are NEW. A window reaching ABOVE `lastToBlock`
 * makes the blocks in between invisible -- they are neither below the resume
 * point nor above the window, so nothing ever delivers them, and the loss is
 * silent and permanent.
 *
 * ## What is truncated, and what deliberately is not
 *
 * - `lastToBlock` becomes `blockNumber`, which is the point: it is what
 *   `getFromBlock` resumes from.
 * - `unconfirmedBlocks` is cut to the ones at or below it. They are ascending, so
 *   this is a prefix, and it has to be one.
 * - `latestBlock` is NOT truncated. It is the chain tip that was observed, not
 *   progress through it, and lowering it would widen the re-fetch window for no
 *   reason.
 * - `context` is not touched: it is the identity the core validates, and it is
 *   the same identity whichever block of the stream this is.
 *
 * It lives HERE, in the engine, because two layers need the identical rule and a
 * second implementation is a divergence waiting to happen: the batch loop in
 * `promiseToFeed` narrows a cursor per BATCH, and `applyEventStream` narrows one
 * per BLOCK (`@etherfold/processor-entities` re-exports this as `syncedThrough`).
 * The last unit of a stream needs no narrowing at all and gets the `lastSync`
 * itself, so the common case costs nothing.
 */
export function cursorSyncedThrough<ABI extends Abi>(lastSync: LastSync<ABI>, blockNumber: number): LastSync<ABI> {
	return {
		context: lastSync.context,
		lastFromBlock: lastSync.lastFromBlock,
		latestBlock: lastSync.latestBlock,
		lastToBlock: blockNumber,
		unconfirmedBlocks: lastSync.unconfirmedBlocks.filter((block) => block.number <= blockNumber),
	};
}

export function getFromBlock<ABI extends Abi>(
	lastSync: LastSync<ABI>,
	defaultFromBlock: number,
	finality: number,
): number {
	return lastSync.latestBlock === 0
		? defaultFromBlock
		: Math.max(Math.min(lastSync.lastToBlock + 1, lastSync.latestBlock - finality), 0);
}

/**
 * The earliest block a source can have anything to say about: the lowest
 * `startBlock` among its contracts, or 0 when any of them declares none.
 *
 * Extracted so the two things that need it -- the single-process
 * `IndexerGeneration` and the receive-only `StreamBuilder` -- read the same
 * answer. It is the floor `getFromBlock` returns before anything has been
 * indexed, so two implementations of it would put the two deployment shapes on
 * two different first batches.
 */
export function defaultFromBlockOf<ABI extends Abi>(source: IndexingSource<ABI>): number {
	let fromBlockFromContracts: undefined | number;
	if (Array.isArray(source.contracts)) {
		for (const contractData of source.contracts) {
			if (contractData.startBlock) {
				if (fromBlockFromContracts === undefined || contractData.startBlock < fromBlockFromContracts) {
					fromBlockFromContracts = contractData.startBlock;
				}
			} else {
				fromBlockFromContracts = 0;
			}
		}
	} else {
		fromBlockFromContracts = (source.contracts as unknown as AllContractData<ABI>).startBlock || 0;
	}
	return fromBlockFromContracts || 0;
}

export type InvalidationReason = 'stream-config' | 'entry-changed' | 'entry-added' | 'entry-removed';

/**
 * WHETHER one half of the stored data is still valid, and FROM WHICH BLOCK it
 * stopped being so.
 *
 * The block is deliberately part of the answer even though the only thing acting
 * on it today is "therefore discard everything and re-index from the start
 * block". A later refinement wants to BRANCH the stream at the boundary instead:
 * with the cursor at 900 and an entry appended at 780, blocks `0..779` were
 * fetched under a filter that was correct and complete, so only `780..900`
 * actually needs re-fetching. Collapsing this into a bare boolean, or burying
 * "re-index from the start block" inside the comparison, would make that a
 * rewrite instead of a refinement. See
 * `work/notes/ideas/a-stream-branches-instead-of-being-discarded.md`.
 */
export type InvalidationVerdict =
	| {valid: true}
	| {
			valid: false;
			/** The lowest block at which the stored data stopped describing this source. */
			invalidFromBlock: number;
			reason: InvalidationReason;
	  };

/**
 * The TWO verdicts, because the fetch and the fold do not depend on the same
 * thing and one verdict could not say so.
 *
 * - `stream` is about the raw logs, fetched under a topic-and-address filter. It
 *   survives everything that did not GROW that filter, so a shrunken topic set
 *   leaves a strict SUPERSET, which is reusable: decode less.
 * - `state` is about the fold over DECODED events. It dies whenever the decoding
 *   shape moved, even if not one log needs re-fetching.
 *
 * A renamed non-indexed parameter is the case that proves they are two
 * questions: `topic0` hashes types and not names, so the fetch is untouched and
 * the decode is not.
 *
 * The implication runs ONE WAY, by construction rather than by rule: an invalid
 * stream is always an invalid state too, because everything `streamHash` commits
 * to (the address, the `topic0`, the range) is also committed to by `hash`, so
 * nothing can move the filter without moving the decode. The converse is exactly
 * what this type exists to express.
 */
export type SourceInvalidation = {
	state: InvalidationVerdict;
	stream: InvalidationVerdict;
};

/** A source-hash list written by the code that hashed the WHOLE source into one entry. */
function isWholeSourceContext(entries: readonly SourceHashEntry[]): boolean {
	return entries.length === 1 && entries[0].startBlock === 0 && entries[0].streamHash === undefined;
}

/**
 * The diff between two entry lists, as SETS rather than element-wise by index.
 *
 * By index was workable while every entry was per-RANGE and the list was ordered
 * by `startBlock`, so an append landed at the end. It is not workable now that
 * an un-ranged source puts every one of its events at the same block: inserting
 * an event shifts whatever sorts after it, and every shifted entry would read as
 * a change to something already indexed. A set diff asks the question that was
 * always meant -- which entries are NEW, which are GONE -- and is immune to
 * where they land.
 *
 * `removalInvalidates` is the whole of the stream/state difference. A removed
 * entry means state was folded from an event we no longer index, so the state is
 * stale; but it means the filter only ever asked for MORE than it now needs, so
 * the stream is a superset and stands.
 *
 * The MINIMUM matching block is reported rather than the first one found, so the
 * answer is the earliest block that stopped being valid rather than an artefact
 * of list order.
 */
function verdictOn(
	current: readonly SourceHashEntry[],
	stored: readonly SourceHashEntry[],
	digestOf: (entry: SourceHashEntry) => string,
	lastToBlock: number,
	removalInvalidates: boolean,
): InvalidationVerdict {
	const storedDigests = new Set(stored.map(digestOf));
	const currentDigests = new Set(current.map(digestOf));
	const added = current.filter((entry) => !storedDigests.has(digestOf(entry)));
	const removed = removalInvalidates ? stored.filter((entry) => !currentDigests.has(digestOf(entry))) : [];
	const addedBlocks = new Set(added.map((entry) => entry.startBlock));
	const removedBlocks = new Set(removed.map((entry) => entry.startBlock));

	let invalidFromBlock: number | undefined;
	let reason: InvalidationReason | undefined;
	const invalidFrom = (block: number, why: InvalidationReason) => {
		if (invalidFromBlock === undefined || block < invalidFromBlock) {
			invalidFromBlock = block;
			reason = why;
		}
	};

	// An entry the stored context LACKS only invalidates if it could have
	// contributed: an event (or a contract) that starts above what was indexed had
	// nothing to say yet, so appending it costs nothing.
	for (const entry of added) {
		if (entry.startBlock <= lastToBlock) {
			invalidFrom(entry.startBlock, removedBlocks.has(entry.startBlock) ? 'entry-changed' : 'entry-added');
		}
	}
	for (const entry of removed) {
		if (entry.startBlock <= lastToBlock) {
			invalidFrom(entry.startBlock, addedBlocks.has(entry.startBlock) ? 'entry-changed' : 'entry-removed');
		}
	}

	if (invalidFromBlock === undefined || reason === undefined) {
		return {valid: true};
	}
	return {valid: false, invalidFromBlock, reason};
}

/**
 * Whether a persisted `lastSync` describes the source and stream config we are
 * running now, from where it stopped doing so, and SEPARATELY for the raw log
 * stream and for the state folded out of it.
 *
 * It answers about the first two identities only; `context.processor` is
 * compared separately by the caller, because the two mismatches mean different
 * things (a processor upgrade is expected and routine, a source change is not).
 *
 * A differing stream config invalidates EVERYTHING, from block 0, on both
 * halves: it is hashed into the wire identity and describes how logs were
 * fetched as much as what they meant.
 *
 * ## Reading a context written before this split
 *
 * `ContextIdentifier` is PERSISTED, so a stored context has to be readable
 * whatever version wrote it. There are three shapes, and a context that does not
 * describe a changed source must never read as invalid -- that would silently
 * re-index every existing deployment on upgrade, which is the exact cost
 * per-event hashing removes.
 *
 * - **per-event** (what this code writes): both halves are decided
 *   independently.
 * - **per-range, no `streamHash`** (what the ranged path wrote): the `hash` of
 *   every entry is computed exactly as it was, so the set diff on `hash` matches
 *   byte for byte and the state verdict is unchanged. The stored entries say
 *   nothing about the FILTER they were fetched under, so the stream half falls
 *   back to the state verdict rather than guessing.
 * - **one whole-source entry** (what an un-ranged source wrote): a digest over
 *   bytes no per-event entry reproduces, so it is compared against the one thing
 *   that does reproduce them, `legacyHash` on the block-0 entry. Equal means the
 *   source did not move and NOTHING is invalidated; unequal means it did, and
 *   the old entry cannot say where, so both halves go from block 0 exactly as
 *   they did before. Either way the next save writes the per-event list, so a
 *   deployment pays this at most once.
 */
export function sourceInvalidationOf(
	// this is the indexer settings to be applied
	indexerSourceHashes: SourceHashEntry[],
	indexerConfigHash: string,
	// this is the stream loaded
	lastToBlock: number,
	context: ContextIdentifier,
): SourceInvalidation {
	if (context.config !== indexerConfigHash) {
		const bothHalves = {valid: false, invalidFromBlock: 0, reason: 'stream-config'} as const;
		return {state: bothHalves, stream: bothHalves};
	}

	const stored = context.source;
	const legacyHash = indexerSourceHashes[0]?.legacyHash;
	if (legacyHash !== undefined && isWholeSourceContext(stored)) {
		if (stored[0].hash === legacyHash) {
			return {state: {valid: true}, stream: {valid: true}};
		}
		const bothHalves = {valid: false, invalidFromBlock: 0, reason: 'entry-changed'} as const;
		return {state: bothHalves, stream: bothHalves};
	}

	const state = verdictOn(indexerSourceHashes, stored, (entry) => entry.hash, lastToBlock, true);
	const bothSidesKnowTheFilter =
		indexerSourceHashes.every((entry) => entry.streamHash !== undefined) &&
		stored.every((entry) => entry.streamHash !== undefined);
	const stream = bothSidesKnowTheFilter
		? verdictOn(indexerSourceHashes, stored, (entry) => entry.streamHash as string, lastToBlock, false)
		: state;
	return {state, stream};
}

/**
 * Whether the persisted STATE is still a fold over what this source means.
 *
 * The narrow surface the callers that only ever discard everything want;
 * `sourceInvalidationOf` is where the block lives, so acting on it later does
 * not mean re-deriving the rule.
 */
export function stateMatches(
	// this is the indexer settings to be applied
	indexerSourceHashes: SourceHashEntry[],
	indexerConfigHash: string,
	// this is the stream loaded
	lastToBlock: number,
	context: ContextIdentifier,
	// if they do not match the indexer will take over and restart from zero
): boolean {
	return sourceInvalidationOf(indexerSourceHashes, indexerConfigHash, lastToBlock, context).state.valid;
}

/**
 * Whether the cached raw log STREAM was fetched under a filter this source is
 * still covered by.
 *
 * Deliberately a different question from `stateMatches`, and a weaker one: the
 * stream is reusable whenever the topic-and-address filter did not GROW, so a
 * discarded state can still be rebuilt from it without going back to the node.
 */
export function streamMatches(
	indexerSourceHashes: SourceHashEntry[],
	indexerConfigHash: string,
	lastToBlock: number,
	context: ContextIdentifier,
): boolean {
	return sourceInvalidationOf(indexerSourceHashes, indexerConfigHash, lastToBlock, context).stream.valid;
}

/**
 * The stream config as it is actually USED, defaults filled in.
 *
 * One implementation, because the resolved object is HASHED into the wire
 * identity: `IndexerGeneration`, the receiving `StreamBuilder` and the sending
 * `LogFetcher` must all reach the same `finality` from the same input, or two
 * halves of one deployment would compute different `config` hashes and every
 * batch would be refused with a digest neither side can read.
 */
/**
 * ONE argument-filter entry in canonical form: trailing wildcards dropped, and
 * each slot's OR list sorted and de-duplicated.
 *
 * Trailing `null`s constrain nothing, so `[me, null]` and `[me]` are the same
 * question; an OR list within a slot is a SET, so its order is not information.
 */
function canonicalArgumentFilter(match: ArgumentFilter): ArgumentFilter {
	let end = match.length;
	while (end > 0 && match[end - 1] === null) {
		end--;
	}
	return match.slice(0, end).map((slot) => (Array.isArray(slot) ? [...new Set(slot)].sort() : slot));
}

/**
 * The argument-filter rules in CANONICAL form, so two authored spellings of one
 * meaning are ONE STREAM.
 *
 * A stream is identified by its fetch filter, and `parse` is hashed into that
 * identity on the strength of these rules. So the rules have to be normalised
 * before they are hashed, exactly as `finality` is defaulted before it is
 * hashed, or reordering two rules or two `match` entries -- neither of which
 * changes a single request -- would fork a new stream and re-fetch the whole
 * history.
 *
 * What is canonicalised: the `contracts` addresses (through `normalizeAddress`,
 * then sorted and de-duplicated, since a scope is a SET), each `match` entry
 * (trailing wildcards trimmed, OR lists sorted), the `match` entries themselves
 * (sorted and de-duplicated, since the OR across them is a set too), and the
 * rules (sorted and de-duplicated for the same reason).
 *
 * What deliberately is NOT: `event` is left exactly as written, so a NAME and
 * the canonical SIGNATURE it happens to cover today stay two streams. Resolving
 * one into the other needs the SOURCE, which a config normalisation does not
 * have, and the two are different intents anyway -- a name follows an upgrade
 * onto a second `topic0` and a signature does not.
 */
function canonicalFilterRules(rules: readonly FilterRule[]): FilterRule[] {
	const canonical = rules.map((rule) => ({
		event: rule.event,
		...(rule.contracts === undefined
			? {}
			: {contracts: [...new Set(rule.contracts.map((address) => normalizeAddress(address)))].sort()}),
		match: dedupeSorted(rule.match.map(canonicalArgumentFilter)),
	}));
	return dedupeSorted(canonical);
}

/** Sort by canonical bytes and drop repeats, which is what makes a list a SET. */
function dedupeSorted<T>(values: readonly T[]): T[] {
	const seen = new Map<string, T>();
	for (const value of values) {
		const key = canonical_form(value);
		if (!seen.has(key)) {
			seen.set(key, value);
		}
	}
	return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value);
}

/**
 * `parse` with its rules canonicalised, and the SAME OBJECT back when there are
 * none.
 *
 * Returning the input untouched where `filters` is absent is not an
 * optimisation, it is the guarantee that a deployment which does not use
 * argument filters hashes to exactly the digest it hashed to before rules
 * existed, so nothing it holds is re-fetched.
 */
function resolveParseConfig(parse: LogParseConfig | undefined): LogParseConfig | undefined {
	if (!parse || !parse.filters) {
		return parse;
	}
	if (parse.filters.length === 0) {
		// an empty rule list constrains nothing, which is what NO rule list means, so
		// the key goes rather than hashing as a third spelling of the same stream
		const {filters: _dropped, ...rest} = parse;
		return rest;
	}
	return {...parse, filters: canonicalFilterRules(parse.filters)};
}

export function resolveStreamConfig(stream: ProvidedStreamConfig | undefined): UsedStreamConfig {
	// An explicit `undefined` is an ABSENT KEY, not a value. A plain spread would
	// let `{finality: undefined}` overwrite the default back to nothing: every
	// field here is optional, so that object type-checks, and the damage is silent
	// -- `finality` becomes `undefined`, `getFromBlock`'s `latestBlock - finality`
	// is NaN, and the config hashes as if no default applied, so it also reads as a
	// different config from every other spelling of the default. It is exactly what
	// a JSON round-trip or an options object built as `{finality: opts.finality}`
	// produces, so it is ordinary rather than exotic.
	//
	// This is the same rule `canonical_form`/`simple_hash` already apply (pinned by
	// `test/hash.test.ts`, "treats an explicit undefined as absent, exactly as JSON
	// does"), and the resolver disagreeing with the digest it feeds is what made the
	// disagreement reachable at all.
	const provided: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(stream || {})) {
		if (value !== undefined) {
			provided[key] = value;
		}
	}
	const resolved = {finality: 17, ...(provided as ProvidedStreamConfig)};
	// The argument filters are canonicalised HERE, for the same reason `finality`
	// is defaulted here: this object is what gets HASHED into the stream identity,
	// so two spellings of one filter must become one value before anything reads
	// it. It is idempotent, so a caller holding an already-resolved config reaches
	// the same bytes and no stored digest moves.
	const parse = resolveParseConfig(resolved.parse);
	return parse === resolved.parse ? resolved : {...resolved, parse};
}

/**
 * The digest of a stream config, and THE ONLY PLACE A STREAM CONFIG IS HASHED.
 *
 * It RESOLVES before it hashes, so an unset `finality` and the default written
 * out are one config -- exactly as they are already one stream to
 * `streamDigestOf`, which resolves for the same reason. `resolveStreamConfig` is
 * idempotent, so a caller that already holds a `UsedStreamConfig` (the wire
 * identity, a `StreamBuilder`) reaches the same bytes through here as it did
 * hashing directly, and no stored digest moves.
 *
 * ## Why it is a function and not two well-behaved call sites
 *
 * It was two call sites, and they DIVERGED. `reinit` hashed the config it had
 * resolved; `updateIndexer` hashed the config as the caller PASSED it. Since the
 * stored hash always carried `finality` and a caller usually leaves it unset --
 * which is what the resolver exists for -- the two could never match, so
 * `sourceInvalidationOf` reported `reason: 'stream-config'` on a reconfigure
 * that moved nothing, and that verdict invalidates the STREAM half from block 0:
 * the cache is cleared and the whole history is re-fetched from the node.
 *
 * A comment cannot hold that shut, and the resolve is the easy half to forget
 * precisely because forgetting it still compiles and still produces a digest.
 * So the step is ONE function every caller goes through, and
 * `test/updateIndexer.test.ts` asserts that no second site in the package hashes
 * a config at all.
 */
export function streamConfigHashOf(stream: ProvidedStreamConfig | UsedStreamConfig | undefined): string {
	return simple_hash(resolveStreamConfig(stream));
}

/**
 * The `{source, config}` identity a sender asserts and a receiver checks.
 *
 * Derived here rather than at each end, for the same reason `getFromBlock` is:
 * the two halves of the wire must compute the SAME digest from the same
 * declarations, and a second implementation of it is a mismatch waiting to
 * happen. `context.processor` is deliberately absent -- a log-fetcher has no way
 * to know which processor version runs on the other side (ADR-0004).
 */
export function wireContextOf<ABI extends Abi>(
	source: IndexingSource<ABI>,
	streamConfig: UsedStreamConfig,
): WireContext {
	return {
		source: [{startBlock: 0, hash: simple_hash(source)}],
		config: streamConfigHashOf(streamConfig),
	};
}

/** Whether two wire identities name the same indexer. */
export function sameWireContext(a: WireContext | undefined, b: WireContext | undefined): boolean {
	if (!a || !b || !Array.isArray(a.source) || !Array.isArray(b.source)) {
		return false;
	}
	return (
		a.config === b.config &&
		a.source.length === b.source.length &&
		a.source.every((entry, i) => b.source[i]?.hash === entry.hash)
	);
}
