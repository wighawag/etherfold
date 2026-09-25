import {NoLiveReceiverError, type LogIngestion} from '@etherfold/core';
import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {prepareIndexing, type IndexingDependencies} from '../src/index.js';
import type {Options} from '../src/types.js';
import {ALICE, BOB, entityModule, fakeChain, START_BLOCK, transfer, ZERO} from './utils/chain.js';
import {bundleOf, identityOf} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------------------------------
// THE COMBINED WIRE FEEDS WHAT THE CONTAINER HOLDS NOW, NOT WHAT IT HELD AT `open`
// ---------------------------------------------------------------------------------------------------
// `prepareIndexing` used to hand the fetcher host `createDirectIngestion(
// container.ingestion)`: ONE receiver, read off the container once, at assembly.
// Two things were wrong with it and only one of them was visible.
//
// The visible one is that the getter THROWS -- "the opening fold of this
// ReceivingIndexer has no receiver, which `open` cannot produce: the first fold
// held on a stream is never a follower" -- so the whole assembly rested on a
// property of how `follows` is currently DERIVED rather than on the shape.
// ADR-0087 retires it: a restarted deployment over a stream the registry already
// carries comes up holding a FOLLOWER, and a follower has no receiver at all,
// because a stream is ONE address on the wire (ADR-0044).
//
// The other is that a captured receiver is PINNED. A named indexer holds several
// live wire contexts and WHICH of them is live MOVES while the process runs -- a
// generation deleted by another process, writer succession handing the wire from
// one fold to the next -- and none of that reaches this side as an event. The
// SERVER's ingest route already answers this correctly: it asks the entry which
// contexts are LIVE at the moment a batch arrives (`liveIngestions`) rather than
// remembering one. The combined shape was the one place that still remembered.
//
// So the claim asserted here is the WIRING, at the deployment seam: the same host
// object, the same fetcher, two cycles, and a different answer each time because
// the folds this process holds moved in between. `packages/core/test/
// directIngestion.test.ts` asserts what the target itself does with that answer,
// including why the empty case is RETRYABLE and a foreign context is not.
// ---------------------------------------------------------------------------------------------------

const SQLITE: Options = {
	processor: './nfts.js',
	nodeUrl: 'http://localhost:0',
	store: 'sqlite',
	db: ':memory:',
};

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
];
const TIP = START_BLOCK + 50;

const ARRIVAL = identityOf('the-fold-this-deployment-came-up-with');

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

function depsFor(db: RemoteSQL): IndexingDependencies {
	return {
		importModule: async () => entityModule,
		processorBundle: bundleOf(ARRIVAL),
		provider: fakeChain().serve(LOGS, TIP).provider,
		createDB: () => db,
		sleep: async () => {},
		// ONE attempt at the ask, so this suite measures the ANSWER rather than the
		// bounded retry core spends inside a cycle on any retryable failure
		env: {MAX_BLOCKS_PER_FETCH: '20', RETRY_ATTEMPTS: '1', RETRY_INITIAL_DELAY_MS: '0'},
	};
}

describe('the combined wire', () => {
	it('asks the container which folds are LIVE on every cycle, rather than feeding one read at open', async () => {
		const prepared = await prepareIndexing('build', SQLITE, depsFor(oneDatabase()));

		// The container's OWN answer, kept so it can be handed back: what is substituted
		// below is the ANSWER to "which folds are live right now", which is exactly the
		// thing that moves under a running deployment and the thing a process cannot be
		// told about. Driving the loop with it empty is deliberately not attempted --
		// the refusal is retryable, so the loop would back off and try again for ever,
		// which is the shape a `run` should have and is nothing to do with this claim.
		const held = prepared.container.liveIngestions.bind(prepared.container);
		let live: readonly LogIngestion[] = [];
		prepared.container.liveIngestions = async () => live;

		// NOTHING LIVE: there is nowhere to push, and the cycle says so rather than
		// fetching a range into a receiver that is not there. Retryable, because the
		// container's own rebuild and writer succession are what close this state
		// (ADR-0044), so the process stays up and a line is written every cycle.
		const nothingToFeed = await prepared.host.runCycle();
		expect(nothingToFeed.kind).toBe('retry');
		expect(nothingToFeed.kind === 'retry' && nothingToFeed.error).toBeInstanceOf(NoLiveReceiverError);

		// ...and the very next cycle, on the SAME host and the SAME fetcher, lands --
		// because the answer moved, not because anything was rebuilt here
		prepared.container.liveIngestions = held;
		live = await held();
		const landed = await prepared.host.runCycle();
		expect(landed.kind).toBe('progress');
	});

	it('does not let a ONE-SHOT wait out a state only a gap between cycles could close', async () => {
		const prepared = await prepareIndexing('build', SQLITE, depsFor(oneDatabase()));
		prepared.container.liveIngestions = async () => [];

		// The refusal is RETRYABLE and on a `run` that is right: the rebuild in the gap
		// between cycles is what advances the follower, and succession hands it the wire
		// once it is level. A `build` HAS no such gap -- its rebuild is one step taken
		// after the loop -- so retrying is a hang, and it exits on the refusal instead of
		// reporting a success it did not earn.
		await expect(prepared.index()).rejects.toThrow(/no live receiver at all/);
	});

	it('comes up holding a receiver it REPORTS rather than one it feeds through', async () => {
		const prepared = await prepareIndexing('build', SQLITE, depsFor(oneDatabase()));

		// the opening fold of a first build is not a follower, so it has one -- and the
		// assembly reads it off the HELD FOLD, where it is already optional, instead of
		// through the assertion that used to stand over it
		expect(prepared.streamWriter).toBe((await prepared.container.liveIngestions())[0]);
	});
});
