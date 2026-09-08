import {describe, expect, it} from 'vitest';
import type {RebuildReport} from '@etherfold/core';
import {newlyStalledFollowers} from '../src/followers.js';

/**
 * WHAT THE POLL LOOP SAYS ABOUT A FOLLOWER THAT CANNOT ADVANCE.
 *
 * ADR-0070 gave `RebuildReport` a stop reason so a host could tell "call again"
 * from "calling again will do exactly this for ever". This is the consumer, and
 * it exists because a capability nothing reads is a claim rather than a feature.
 *
 * The decision is separated from the loop precisely so it can be asserted:
 * driving a whole CLI to reach a stalled rebuild is expensive, and the review
 * that asked for this found the logic could be INVERTED WHOLESALE with the CLI
 * suite still green. Every case here fails against that inversion.
 */

function reportWith(processor: string, stopped: RebuildReport['stopped']): RebuildReport {
	return {
		generation: {stream: 'stream-a', processor},
		fromBlock: 100,
		toBlock: undefined,
		scanned: 0,
		replayed: 0,
		retracted: 0,
		highWater: 0,
		complete: false,
		stopped,
	};
}

describe('a follower that cannot advance is reported, once', () => {
	it('says nothing about the reasons another call can fix', () => {
		const reported = new Set<string>();

		// `budget` has more waiting NOW; `nothing-stored` and `stream-consumed` may
		// have more later. All three are the ordinary case and are not news.
		const fresh = newlyStalledFollowers(
			[
				reportWith('a', {reason: 'budget'}),
				reportWith('b', {reason: 'nothing-stored'}),
				reportWith('c', {reason: 'stream-consumed'}),
			],
			reported,
		);

		expect(fresh).toEqual([]);
		expect(reported.size).toBe(0);
	});

	it('names each reason a retry cannot fix, and names WHICH reason', () => {
		const reported = new Set<string>();

		const fresh = newlyStalledFollowers(
			[
				reportWith('a', {reason: 'does-not-reach-back', startBlock: 500}),
				reportWith('b', {reason: 'undecodable'}),
				reportWith('c', {reason: 'inconsistent', detail: 'a gap'}),
			],
			reported,
		);

		expect(fresh.map((stalled) => stalled.reason)).toEqual(['does-not-reach-back', 'undecodable', 'inconsistent']);
		expect(reported.size).toBe(3);
	});

	it('says it ONCE, not on every cycle: a permanent condition would fill a log at the poll rate', () => {
		const reported = new Set<string>();
		const stuck = [reportWith('a', {reason: 'does-not-reach-back', startBlock: 500})];

		expect(newlyStalledFollowers(stuck, reported)).toHaveLength(1);
		expect(newlyStalledFollowers(stuck, reported)).toEqual([]);
		expect(newlyStalledFollowers(stuck, reported)).toEqual([]);
	});

	it('FORGETS a follower that recovers, so a later stall is heard rather than swallowed', () => {
		// The half a bare "report once" would get wrong: a follower can stall because
		// its writer has not appended yet, recover when it does, and stall again later
		// for a different reason. A stale entry would make the second one silent.
		const reported = new Set<string>();

		expect(newlyStalledFollowers([reportWith('a', {reason: 'undecodable'})], reported)).toHaveLength(1);
		expect(newlyStalledFollowers([reportWith('a', {reason: 'budget'})], reported)).toEqual([]);
		expect(reported.size).toBe(0);
		expect(newlyStalledFollowers([reportWith('a', {reason: 'undecodable'})], reported)).toHaveLength(1);
	});

	it('tracks each generation separately, so one stalled follower does not mute another', () => {
		const reported = new Set<string>();

		expect(newlyStalledFollowers([reportWith('a', {reason: 'undecodable'})], reported)).toHaveLength(1);
		const second = newlyStalledFollowers(
			[reportWith('a', {reason: 'undecodable'}), reportWith('b', {reason: 'undecodable'})],
			reported,
		);

		expect(second).toHaveLength(1);
		expect(second[0].id).not.toBe('');
		expect(reported.size).toBe(2);
	});
});
