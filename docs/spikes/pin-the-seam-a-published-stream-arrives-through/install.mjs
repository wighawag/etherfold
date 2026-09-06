/**
 * THE CANDIDATE INSTALL, isolated so it can be measured rather than re-derived.
 *
 * This is the half of the seam decision that is easy to leave vague: what
 * INSTALLING a seed actually writes. The claim it exists to test is that
 * installing needs no new keeper operation and no substrate access at all,
 * because the public keeper seam (`ExistingStream.saveNewEvents`) already takes
 * exactly what a seed has to deliver, and `createSegmentedStream` already owns
 * every rule that would otherwise have to be restated here: which ordinal a
 * segment takes, what the cursor record holds, where the stream's `startBlock`
 * comes from, and which batches would leave a hole.
 *
 * PROTOTYPE CODE. It answers a question; it is not the implementation. The
 * measuring task (`measure-what-a-published-stream-costs-to-install-and-pick-its-shape`)
 * imports it so that what is measured is the install that was actually pinned.
 *
 * Two things it deliberately does NOT do, because they belong to later tasks in
 * this exploration: it does not fetch (the loading interface is the ADR's
 * business, and this takes a fixture already in hand), and it checks NOTHING
 * about whether the seed is for this stream (`decide-what-a-mismatched-seed-digest-does`)
 * or whether it is trustworthy (`decide-who-verifies-a-stream-seed-and-against-what`).
 */

/**
 * ONE EVENT, stripped of its decoded half.
 *
 * A COPY of `storedEventOf` from `packages/core/src/internal/stream/strip.ts`,
 * and the copy is itself a finding: that module is `internal/` and is not
 * exported from `@etherfold/core`, so an install written outside the engine
 * cannot reach the one implementation of this rule. The ADR names exporting it
 * as a build item; duplicating it here is the thing a real implementation must
 * NOT do.
 */
export function storedEventOf(event) {
	const {args: _args, eventName: _eventName, decodeError: _decodeError, ...raw} = event;
	return raw;
}

/**
 * The fixture's events cut into BATCHES, each one a whole number of blocks.
 *
 * Blocks are never split across two batches. Nothing in the keeper requires it
 * (a read concatenates the segments and filters by block, so a split block would
 * read back identically), but a segment that holds half a block is a segment
 * whose cursor cannot honestly say which blocks it covers, and the cursor is the
 * whole point of the exercise.
 *
 * `maxEvents` is a free parameter, NOT a decision this spike makes: it is one of
 * the things the measuring task varies.
 */
export function batchesOf(eventStream, maxEvents) {
	const batches = [];
	let current = [];
	for (let i = 0; i < eventStream.length; i++) {
		const event = eventStream[i];
		const previous = eventStream[i - 1];
		const boundary = previous !== undefined && previous.blockNumber !== event.blockNumber;
		if (boundary && current.length >= maxEvents) {
			batches.push(current);
			current = [];
		}
		current.push(event);
	}
	if (current.length > 0) {
		batches.push(current);
	}
	return batches;
}

/**
 * Install a captured stream into a keeper, through the seam and nothing else.
 *
 * The block arithmetic is the load-bearing part, and there are exactly three
 * rules, each one forced by something `createSegmentedStream` or the load path
 * already does:
 *
 *  1. The FIRST batch's `lastFromBlock` is the CAPTURE's own `fromBlock`, not
 *     its first event's block. The keeper writes that value once, as the
 *     stream's `startBlock`, and `fetchFrom` clears the whole subtree when
 *     `startBlock > fromBlock` -- so a seed that claimed to start at its first
 *     EVENT would be deleted on first load by a client whose source starts
 *     earlier, which is the ordinary case (the first contract's `startBlock` is
 *     usually below the first log it emitted).
 *
 *  2. Each later batch continues the previous one: `lastFromBlock` is the
 *     previous `lastToBlock + 1`. A batch starting above that is REFUSED by the
 *     keeper (it would leave a hole no later check could see), and a batch
 *     starting below it is an overlap the keeper accepts as an ordinary tip
 *     re-scan, which for an install would silently duplicate events.
 *
 *  3. The LAST batch's `lastToBlock` is the capture's own `lastToBlock`, which
 *     is ABOVE its last event-bearing block. This is the client-side counterpart
 *     of the stored stream's coverage claim (ADR-0055): the rows cannot say how
 *     far the stream REACHES, because a quiet range moves the cursor without
 *     adding one. Cut this short and the client re-scans every quiet block at
 *     the end of the capture, which on a public node is exactly the fetch it
 *     cannot make.
 *
 * The `context` written is the SEED's own, verbatim. Writing the client's own
 * hashes instead would make the load path's `streamMatches` check vacuous, since
 * it would then be comparing the client against itself.
 */
export async function installStreamSeed(keeper, source, fixture, options = {}) {
	const {maxEvents = 1000, onBatch} = options;
	const batches = batchesOf(fixture.eventStream, maxEvents);
	const coverageFrom = fixture.provenance.fromBlock ?? fixture.lastSync.lastFromBlock;
	const coverageTo = fixture.lastSync.lastToBlock;

	let previousTo;
	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		const last = i === batches.length - 1;
		const lastFromBlock = previousTo === undefined ? coverageFrom : previousTo + 1;
		const lastToBlock = last ? coverageTo : batch[batch.length - 1].blockNumber;

		const outcome = await keeper.saveNewEvents(source, {
			eventStream: batch.map(storedEventOf),
			lastSync: {
				context: fixture.lastSync.context,
				latestBlock: fixture.lastSync.latestBlock,
				lastFromBlock,
				lastToBlock,
				unconfirmedBlocks: [],
			},
		});
		if (outcome === 'declined') {
			// Reported rather than thrown, and never swallowed: a declined batch means
			// the arithmetic above is wrong, and the stream stops where it stopped.
			return {installed: i, batches: batches.length, declinedAt: i};
		}
		previousTo = lastToBlock;
		onBatch?.({index: i, events: batch.length, lastFromBlock, lastToBlock});
	}
	return {installed: batches.length, batches: batches.length, declinedAt: undefined};
}
