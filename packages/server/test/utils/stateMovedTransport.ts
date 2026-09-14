import {createClient} from '@libsql/client';
import {
	openReceivingIndexer,
	serializeWireBatch,
	type LogEvent,
	type StateMoved,
	type WireBatch,
} from '@etherfold/core';
import type {ConnectPosition, StateMovedTransport} from '@etherfold/state-moved-conformance';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {expect} from 'vitest';
import {
	applySchema,
	createServer,
	emissionAppenderFor,
	generationRegistryPortOnSQL,
	indexerEntryOn,
	storedEmissionReplaySource,
	STATE_MOVED_EVENT,
	STATE_MOVED_PROGRESS_EVENT,
} from '../../src/index.js';
import {
	ALICE,
	BOB,
	CONTRACT,
	SOURCE,
	START_BLOCK,
	STREAM_CONFIG,
	TOKEN,
	transfer,
	ZERO,
	type TestABI,
} from './feedHarness.js';
import {openSignalStream, type SignalStream} from './signalStream.js';

/**
 * THE THIRD TRANSPORT, AS `@etherfold/state-moved-conformance` ASKS FOR IT:
 * `GET /{indexer}/state-moved`, over the network.
 *
 * The other two are `@etherfold/browser`'s, adapted there against the SAME case
 * list. That is the whole of why this file exists: three adapters built against
 * one decided shape agree on the day they are written and drift one edit at a
 * time afterwards, each still passing the tests in its own file, and ADR-0083's
 * claim is precisely that they do NOT -- that an app writes one handler and
 * pointing it at a hosted indexer is a deployment choice rather than a rewrite.
 *
 * ## What the READER here is
 *
 * A real HTTP client on a real SSE stream (`signalStream.ts`), with the frames
 * turned into calls to the plain `StateMovedHandler` an app would write. Nothing
 * is in-process: the value the suite's handler is given is what came off the
 * wire and back through `JSON.parse`, which is the half a deep-equality in this
 * package's own tests could not catch.
 *
 * ## What the PRODUCER here is
 *
 * The receiving container in `@etherfold/core`, fed exactly as a log-fetcher
 * feeds it: an ingest POST carrying a wire batch. This package applies no blocks
 * and this file does not pretend it does -- a retraction is CAUSED by re-sending
 * a block under a different hash and letting the fold conclude what it
 * concludes, and a promotion is a successor generation catching up over the
 * stored stream.
 */

const NAME = 'alpha';

/**
 * THE FIRST BLOCK THIS WORLD PUTS AN EVENT IN: the source's own start block, with
 * no lead.
 *
 * It CARRIED one, `START_BLOCK + FINALITY + 1`, and the lead was not a property
 * of this fixture at all -- it was working around a defect in the engine. A
 * SUCCESSOR catches up by REPLAYING the stored emission stream from
 * `cursor - finality`, the stream's own `startBlock` is where its first batch was
 * accepted from, and the read start used to be floored at 0 -- so a fold still
 * inside the first `finality` blocks asked for a range the stream honestly did
 * not reach back to and the rebuild could not begin. `getFromBlock` now floors at
 * the source's earliest block, so a world level with its own start block is
 * served, which is exactly what this fixture is. Removing the lead is therefore
 * also what keeps the fix asserted from THIS side: put it back and the world
 * stops exercising the condition at all.
 */
const FIRST_EVENT_BLOCK = START_BLOCK;

/** One block of the chain as this world told the server about it. */
type Told = {block: number; hash: string; id: bigint; to: string};

function freshDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/**
 * The FOLD, at a version the caller may move.
 *
 * The version is a parameter because a PROCESSOR change over an unchanged stream
 * is what makes the promotion case cheap: the same logs, a different fold, so
 * the successor re-folds the stored stream and fetches nothing.
 */
function entityProcessorAt(version: string): EntityProcessor<TestABI> {
	return {
		version,
		entities: [{name: 'token', id: ['id'], fields: {owner: 'text'}}],
		async onTransfer(state, event) {
			// A BURN this processor does not track: decoded, handed to the handler, and the
			// handler takes a branch that mutates nothing. That is how a block is APPLIED
			// while touching no entity, which is what `applyNextEmptyBlock` drives. It is a
			// different thing from a range carrying no logs, which applies no block at all.
			if (event.args.to === ZERO) return;
			state.set('token', {id: (event.args as {id: bigint}).id.toString()}, {owner: event.args.to});
		},
	};
}

function foldAt(version: string) {
	return {
		createState: () => freshDatabase(),
		createProcessor: (state: RemoteSQL) => new VersionedStateEventProcessor<TestABI>(state, entityProcessorAt(version)),
	};
}

/**
 * OPEN A HOSTED INDEXER AND A CLIENT'S VIEW OF IT.
 *
 * `holdsStreamsAcrossRequests` is declared because this host is a Node process
 * and can: the refusal on a runtime that cannot is its own case in
 * `aRemoteClientLearnsTheStateMoved.test.ts`, and is not a thing a conformance
 * suite about the SIGNAL has an opinion on.
 */
export async function openServerTransport(): Promise<StateMovedTransport> {
	const db = freshDatabase();
	await applySchema(db);
	const indexer = await openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, NAME),
		source: SOURCE,
		stream: STREAM_CONFIG,
		appendEmissions: emissionAppenderFor(db, NAME),
		replay: storedEmissionReplaySource<TestABI>(db, NAME),
		generation: foldAt('1.0.0'),
	});
	const app = createServer<{INGEST_TOKEN?: string}>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN}),
		getIndexer: (_c, name) => (name === NAME ? indexerEntryOn(db, indexer) : undefined),
		holdsStreamsAcrossRequests: true,
	});

	/** The chain as this world has told the server about it, in block order. */
	const told: Told[] = [];
	const clients: SignalStream[] = [];

	/**
	 * PUSH what the server does not yet hold, as a log-fetcher pushes it.
	 *
	 * The batch is rebuilt from `told` every time rather than carrying only the
	 * new block, because ADR-0004's sending rule is that a payload holds EVERY log
	 * in `[fromBlock, toBlock]`: a partial range is how a receiver infers an
	 * absence, and an absence is a reorg.
	 */
	const push = async (toBlock: number): Promise<void> => {
		const fromBlock = await indexer.ingestion.expectedFromBlock();
		const logs = told
			.filter((one) => one.block >= fromBlock && one.block <= toBlock)
			.map((one) => transfer(one.block, one.hash, one.to, one.id, 0, CONTRACT) as LogEvent<TestABI>);
		const batch: WireBatch<TestABI> = {
			context: indexer.ingestion.context,
			fromBlock,
			toBlock,
			latestBlock: toBlock,
			logs,
		};
		const response = await app.request(`/${NAME}/ingest`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
			body: serializeWireBatch(batch),
		});
		expect(response.status, await response.clone().text()).toBe(200);
		await rebuild();
	};

	/**
	 * DRIVE THE REBUILD until every generation that is rebuilding says it is
	 * finished.
	 *
	 * A no-op before a promotion, and the whole of what moves the fold after one:
	 * the ingest reaches the generation that WRITES the stream, and a successor --
	 * which is a FOLLOWER over that same stream -- reaches the new emission through
	 * this call, which is a thing the HOST schedules doing BOUNDED work (ADR-0022)
	 * rather than a side effect of the append. So a push that is not followed by
	 * this is a block the fold answering reads has not applied, and nothing would
	 * be published for it.
	 */
	const rebuild = async (): Promise<void> => {
		for (let round = 0; round < 60; round++) {
			const reports = await indexer.rebuildMore();
			if (reports.every((report) => report.complete)) return;
		}
		throw new Error(`a generation never finished rebuilding`);
	};

	return {
		async onStateMoved(handler) {
			// A REMOTE READER IS A CONNECTION. Two readers are two streams, which is the
			// honest model here and is also what makes "the producer holds nothing per
			// client" checkable rather than asserted.
			const client = await openSignalStream(app, `/${NAME}/state-moved`, {
				onEvent: (frame) => {
					if (frame.event === STATE_MOVED_EVENT) handler(frame.data as unknown as StateMoved);
				},
			});
			clients.push(client);
			return () => {
				void client.close();
			};
		},

		async applyNextBlock(): Promise<number> {
			const block = (told.at(-1)?.block ?? FIRST_EVENT_BLOCK - 1) + 1;
			told.push({block, hash: `0xa${block.toString(16)}`, id: BigInt(block), to: ALICE});
			await push(block);
			return block;
		},

		async applyNextEmptyBlock(): Promise<number> {
			// The same event-bearing block as above, sent TO the zero address, which
			// `entityProcessorAt` does not track: the receiving fold applies the block and
			// mutates nothing, so the changed-set crossing the stream is empty.
			const block = (told.at(-1)?.block ?? FIRST_EVENT_BLOCK - 1) + 1;
			told.push({block, hash: `0xa${block.toString(16)}`, id: BigInt(block), to: ZERO});
			await push(block);
			return block;
		},

		async retract(): Promise<number> {
			// THE BLOCK IT JUST APPLIED comes back carrying a different hash, inside the
			// window the receiver still holds. Nothing here says the word retraction: the
			// fold compares the window against what arrived and concludes it.
			const last = told.at(-1)!;
			told[told.length - 1] = {
				block: last.block,
				hash: `0xb${last.block.toString(16)}`,
				id: BigInt(last.block + 1000),
				to: BOB,
			};
			await push(last.block);
			return last.block - 1;
		},

		async promote(): Promise<void> {
			// A PROCESSOR change: the same stream, so the successor fetches nothing and
			// catches up by re-folding what the emission table already holds. The pointer
			// moves under the ordinary default once it is level.
			const before = await indexer.canonical();
			await indexer.add(foldAt('2.0.0'));
			for (let round = 0; round < 60; round++) {
				if ((await indexer.canonical())?.processor !== before?.processor) return;
				// The pointer moves at the END of a rebuild rather than inside one, so a
				// `complete` report is not yet a promotion: the loop re-reads it afterwards.
				await indexer.rebuildMore();
			}
			throw new Error(`the successor generation never became canonical`);
		},

		/**
		 * WHERE THE FOLD IS, as a CONNECTING reader is told it.
		 *
		 * This is the half that stands in for a read on this transport, and it is
		 * absent rather than approximated: the server exposes status, ingest, feed and
		 * admin, and the query layer is deliberately deferred to
		 * `the-same-query-runs-against-a-worker-and-a-server`. A reader here therefore
		 * converges by being TOLD the position and the token at once rather than by
		 * re-querying state it cannot yet ask for (ADR-0083).
		 */
		async positionOnConnect(): Promise<ConnectPosition> {
			const client = await openSignalStream(app, `/${NAME}/state-moved`);
			await client.waitFor(
				(events) => events.some((frame) => frame.event === STATE_MOVED_PROGRESS_EVENT),
				'the position on connect',
			);
			const frame = client.progress()[0] as {lastToBlock?: number; coherence: string};
			await client.close();
			return {lastToBlock: frame.lastToBlock, coherence: frame.coherence};
		},

		async close(): Promise<void> {
			for (const client of clients) await client.close();
		},
	};
}
