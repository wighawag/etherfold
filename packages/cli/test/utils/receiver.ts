import {StreamBuilder, type FetchLike} from '@etherfold/core';
import {EntityEventProcessor} from '@etherfold/processor-entities';
import {createServer, emissionAppenderFor, indexerRegistry} from '@etherfold/server';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {abi, nftProcessor, SOURCE} from './chain.js';

export {SOURCE};

// ---------------------------------------------------------------------------------------------------
// THE OTHER HALF OF A SPLIT DEPLOYMENT, SUPPLIED BY THE TEST
// ---------------------------------------------------------------------------------------------------
// `etherfold fetch` is the chain-facing half, so driving it needs something on
// the other end of the wire. This is the REAL receiver -- the Hono app over a
// real `StreamBuilder` over the same entity processor the rest of these tests
// fold, on a real local libSQL database -- reached through an in-process `fetch`
// rather than a socket, exactly as `packages/fetcher-host/test/harness.ts` and
// `packages/server/test/fetcherRoundTrip.test.ts` do it. Only the NODE is fake.
//
// A mocked receiver would mock the thing under test: what the command must get
// right is that the cursor lives HERE, so the `409` that puts a restarted
// fetcher back on track has to come from the real endpoint.
// ---------------------------------------------------------------------------------------------------

/** The shared secret of the wire, under the same name on both sides. */
export const TOKEN = 'the-split-deployments-shared-secret';

/** Where the fetcher pushes. No socket is bound: the test hands over the `fetch` that answers. */
export const ENDPOINT = 'http://indexer.test';

/** Both halves hash `{source, config}` into the wire identity, so both must resolve this same number. */
export const FINALITY = 3;

/**
 * The NAMED INDEXER both halves are deployed with: configuration on each side,
 * a ROUTE SEGMENT between them (`/{indexer}/ingest`), and never a field in the
 * envelope (ADR-0036).
 */
export const INDEXER = 'alpha';

export type RunningReceiver = {
	/** The in-process wire a test hands the command, in place of the runtime's own `fetch`. */
	fetch: FetchLike;
	/** Every request that crossed it, so a test can assert what the wire actually carried. */
	requests: {path: string; status: number}[];
	/** What the receiver folded: the counter the processor keeps, and who owns a token. */
	transfers(): Promise<number>;
	ownerOf(id: bigint): Promise<string | undefined>;
};

export async function startReceiver(): Promise<RunningReceiver> {
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	const store = new VersionedStateStore(db, nftProcessor.entities, {finalityDepth: FINALITY});
	const processor = new EntityEventProcessor<typeof abi>(store, nftProcessor, {finalityDepth: FINALITY});
	// the APPENDER is the host's, exactly as it is in `etherfold index`: the route
	// writes nothing, and a fold is stored by whoever owns the store (ADR-0052)
	const builder = new StreamBuilder<typeof abi, unknown>(processor, SOURCE, {
		stream: {finality: FINALITY},
		appendEmissions: emissionAppenderFor(db, INDEXER),
	});
	const app = createServer<{INGEST_TOKEN?: string}>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN}),
		getIndexer: indexerRegistry({[INDEXER]: builder}),
	});
	await app.request('/admin/setup', {method: 'POST'});
	// the processor's own tables, which a real host gets when the first batch
	// lands. Done up front so a test can ASK about state that was never written:
	// "nothing was applied" is the assertion after a refusal, and it should not
	// come back as a missing table.
	await processor.load(SOURCE, builder.streamConfig);

	const requests: {path: string; status: number}[] = [];
	return {
		requests,
		fetch: async (url, init) => {
			const response = await app.request(url as string, init as RequestInit);
			requests.push({path: new URL(url as string, ENDPOINT).pathname, status: response.status});
			return response;
		},
		transfers: async () => (await store.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value ?? 0,
		ownerOf: async (id) =>
			(await store.getCurrent<{owner: string}>('nft', {tokenID: id.toString().padStart(78, '0')}))?.owner,
	};
}
