import type {Abi, LogEvent} from '@etherfold/core';
import {normalizeBlockTimestamp, type BlockPointer} from '@etherfold/state-store';

/** One block's worth of applied events, in stream order. */
export type BlockOfEvents<ABI extends Abi> = {number: number; hash: string; events: LogEvent<ABI>[]};

/**
 * One below the lowest retracted block in the stream, or `undefined` if nothing
 * was retracted.
 *
 * `min` over the whole stream rather than "the first removed event" because the
 * ordering of retractions is the engine's business, not a processor's, and a
 * revert to the wrong height is silent in both directions: too high leaves dead
 * rows live, too low drops canonical history that nothing will re-apply.
 */
export function forkPoint<ABI extends Abi>(eventStream: readonly LogEvent<ABI>[]): number | undefined {
	let lowest: number | undefined;
	for (const event of eventStream) {
		if (!event.removed) continue;
		lowest = lowest === undefined ? event.blockNumber : Math.min(lowest, event.blockNumber);
	}
	return lowest === undefined ? undefined : lowest - 1;
}

/**
 * Group the APPLIED events by block, preserving stream order.
 *
 * Keyed by block hash, matching the core's `groupLogsPerBlock`, so that two
 * distinct blocks at the same height (which is exactly what a reorg produces
 * inside one stream) stay two blocks. Removed events are dropped here: they were
 * already answered by the revert, and re-running them as mutations would apply
 * the dead branch a second time.
 */
export function groupByBlock<ABI extends Abi>(eventStream: readonly LogEvent<ABI>[]): BlockOfEvents<ABI>[] {
	const byHash = new Map<string, BlockOfEvents<ABI>>();
	const ordered: BlockOfEvents<ABI>[] = [];
	for (const event of eventStream) {
		if (event.removed) continue;
		let group = byHash.get(event.blockHash);
		if (!group) {
			group = {number: event.blockNumber, hash: event.blockHash, events: []};
			byHash.set(event.blockHash, group);
			ordered.push(group);
		}
		group.events.push(event);
	}
	return ordered;
}

/**
 * The block to record, built from the events themselves.
 *
 * The timestamp comes off the log, which is the whole point: a node implementing
 * `execution-apis#639` puts it there, so recording the time axis costs no extra
 * request. When it is missing the block is NOT recorded on a guess. A zero or an
 * interpolated value would not fail, it would answer confidently about the wrong
 * block for as long as the store lives, and a read as of a timestamp has no way
 * to tell a caller it was lied to.
 */
export function blockPointer<ABI extends Abi>(block: BlockOfEvents<ABI>): BlockPointer {
	const withTimestamp = block.events.find((event) => event.blockTimestamp !== undefined);
	if (!withTimestamp || withTimestamp.blockTimestamp === undefined) {
		throw new Error(
			`no blockTimestamp on any event of block ${block.number} (${block.hash}). Nodes implementing ` +
				`execution-apis#639 (geth >= 1.16.0, reth, besu, erigon, anvil, and EDR >= 0.20.0) put it on the log ` +
				`itself. Reaching this means the node did not: it predates the change, or it is a Hardhat version ` +
				`bundling an older EDR (3.16.0 still ships edr 0.19.0 -- override @nomicfoundation/edr to >=0.20.0 ` +
				`rather than waiting for the bump), or it is forking a node that predates it, or it is answering ` +
				`from an EDR RPC cache written before the change. Upgrade the node, or populate blockTimestamp ` +
				`before feeding this stream in. There is no fallback to fetch the block with: the engine reads ` +
				`the timestamp off the log and makes no other data call (ADR-0073). This refuses to guess, ` +
				`because a wrong timestamp breaks the time axis silently.`,
		);
	}
	return {
		number: block.number,
		hash: block.hash,
		timestamp: normalizeBlockTimestamp(withTimestamp.blockTimestamp),
	};
}
