import 'fake-indexeddb/auto';
import type {GenerationContext} from '@etherfold/core';
import {
	BlockNotRetainedError,
	StoreClaimAbandonedError,
	type EntityDeclaration,
	type Mutation,
	type StateStore,
	type StateStoreBackend,
	type WritableStateStore,
} from '@etherfold/state-store';
import {IndexedDBStateStore} from '@etherfold/state-store-indexeddb';
import {describe, expect, expectTypeOf, it} from 'vitest';
import {
	createSnapshot,
	EntityEventProcessor,
	EntityStateView,
	stateFactoriesFrom,
	SYNC_CURSOR_KEY,
	type BootstrapOutcome,
	type StateSnapshot,
} from '../src/index.js';
import {finality, lastSync, processor, SOURCE, timestampOf, transfer, type TestABI} from './utils/fixtures.js';

/**
 * ONE STORE CONSTRUCTOR, BOTH SEATS OF THE TAB ELECTION (ADR-0097).
 *
 * The factories are asked the questions the host asks them, with the arguments
 * the host hands them, over REAL separate connections to one IndexedDB database
 * (`fake-indexeddb`), which is what a leader tab and a reader tab are: two opens
 * of one name. The browser suites run the same helper under a real election.
 */

let counter = 0;
const CONTEXT: GenerationContext = {stream: 'stream-digest'};
const SNAPSHOT_AT = 12_000;
const BODY = 'https://publications.example/app/state.ndjson.gz';

/** The ONE constructor, recording what it was asked to open. */
function constructor() {
	const databaseName = `state-factories-${counter++}`;
	const opened: {stream: string; entities: readonly EntityDeclaration[]}[] = [];
	return {
		databaseName,
		opened,
		open: async (context: GenerationContext, entities: readonly EntityDeclaration[]): Promise<StateStoreBackend> => {
			opened.push({stream: context.stream, entities});
			const store = new IndexedDBStateStore(entities, {databaseName: `${databaseName}-${context.stream}`});
			await store.migrate();
			return store;
		},
	};
}

function published(at = SNAPSHOT_AT): Promise<StateSnapshot> {
	const rows: Mutation[] = [
		{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xalice', transferCount: 9}},
		{type: 'upsert', entity: 'counter', id: {name: 'transfers'}, values: {value: 9}},
	];
	return createSnapshot<TestABI>({
		takenAt: {number: at, hash: `0x${at.toString(16)}`, timestamp: timestampOf(at)},
		entities: processor.entities,
		rows,
		lastSync: lastSync({lastToBlock: at, lastFromBlock: at - 10, latestBlock: at + 1_000}),
		processor: 'proc-v1',
		savedAt: '2026-09-30T00:00:00.000Z',
	});
}

/** A host serving one snapshot body, recording what was asked and with what `init`. */
function serving(snapshot: StateSnapshot, onRequest?: () => void) {
	const asked: {url: string; init: unknown}[] = [];
	const fetch = (async (input: unknown, init?: unknown) => {
		asked.push({url: String(input), init});
		onRequest?.();
		if (String(input) === BODY) return new Response(snapshot.document);
		return new Response('not found', {status: 404});
	}) as typeof globalThis.fetch;
	return {fetch, asked};
}

const patience = () => ({signal: new AbortController().signal});

/** Index one transfer through the writer, so a reader has something the WRITER wrote to read. */
async function foldOne(store: WritableStateStore, block: number) {
	const runtime = new EntityEventProcessor<TestABI>(store, processor);
	await runtime.load(SOURCE, {finality});
	await runtime.process([transfer(block, '0xN', {from: '0x0', to: '0xbob', id: 2n})], {
		...lastSync({lastToBlock: block, latestBlock: block}),
	});
}

describe('stateFactoriesFrom', () => {
	it('opens ONE database for both seats: the reader reads the rows the writer wrote', async () => {
		const {open, opened} = constructor();
		const factories = stateFactoriesFrom({open, entities: processor.entities});

		const writer = await factories.createState(CONTEXT, patience());
		await foldOne(writer, 100);
		const reader = await factories.openState(CONTEXT);

		expect(opened).toEqual([
			{stream: CONTEXT.stream, entities: processor.entities},
			{stream: CONTEXT.stream, entities: processor.entities},
		]);
		expect(reader.state).toBeInstanceOf(EntityStateView);
		expect(await reader.store.getCurrent('token', {id: '2'})).toMatchObject({owner: '0xbob'});
	});

	it('hands the reader a store that cannot write, by type', async () => {
		const factories = stateFactoriesFrom({open: constructor().open, entities: processor.entities});

		const reader = await factories.openState(CONTEXT);
		const writer = await factories.createState(CONTEXT, patience());

		expectTypeOf(reader.store).toEqualTypeOf<StateStore>();
		expectTypeOf(reader.store).not.toHaveProperty('applyBlock');
		expectTypeOf(writer).toEqualTypeOf<WritableStateStore>();
		// @ts-expect-error: a reader names no mutating verb
		void reader.store.applyBlock;
	});

	it('declares the store from a published BUNDLE, from its own processor, and from `entities` for a module', async () => {
		const other: EntityDeclaration[] = [{name: 'thing', id: ['id'], fields: {label: 'text'}}];
		const {open, opened} = constructor();
		const factories = stateFactoriesFrom({open, entities: other});

		await factories.createState(CONTEXT, patience(), {processor});
		await factories.openState(CONTEXT, {processor});
		await factories.openState({stream: 'another-stream'});

		// the bundle is the fold that writes the store, so its declarations win
		expect(opened.map((call) => call.entities)).toEqual([processor.entities, processor.entities, other]);
		expect(opened[2].stream).toBe('another-stream');
	});

	it('refuses, by name, when there are no declarations to open with', async () => {
		const factories = stateFactoriesFrom({open: constructor().open});

		await expect(factories.openState(CONTEXT)).rejects.toThrow(/entities/);
		await expect(factories.createState(CONTEXT, patience(), {processor: {}})).rejects.toThrow(/entities/);
	});

	it('starts the writer from the published snapshot, and the reader never downloads one', async () => {
		const snapshot = await published();
		const host = serving(snapshot);
		const outcomes: BootstrapOutcome[] = [];
		const factories = stateFactoriesFrom({
			open: constructor().open,
			entities: processor.entities,
			fetch: host.fetch,
			finalityDepth: finality,
			onBootstrap: (outcome) => outcomes.push(outcome),
		});

		const writer = await factories.createState(CONTEXT, patience(), undefined, {
			locations: [BODY],
			processor: 'proc-v1',
			replaceLocal: false,
		});
		expect(outcomes).toEqual([{status: 'bootstrapped', at: SNAPSHOT_AT, from: BODY}]);
		expect(await writer.readCursor(SYNC_CURSOR_KEY)).toBeDefined();
		const downloads = host.asked.length;

		const reader = await factories.openState(CONTEXT);

		expect(host.asked).toHaveLength(downloads);
		expect(await reader.store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice', transferCount: 9});
		// opened SNAPSHOT-AWARE, so the reader keeps the floor the install recorded
		await expect(reader.store.getAsOf('token', {id: '1'}, SNAPSHOT_AT - 1)).rejects.toBeInstanceOf(
			BlockNotRetainedError,
		);
	});

	it('forwards `replaceLocal`, so an abandoned catch-up REPLACES the local state', async () => {
		const {open} = constructor();
		const snapshot = await published();
		const host = serving(snapshot);
		const outcomes: BootstrapOutcome[] = [];
		const factories = stateFactoriesFrom({
			open,
			entities: processor.entities,
			fetch: host.fetch,
			onBootstrap: (outcome) => outcomes.push(outcome),
		});
		// a tab that indexed itself up to a block behind the snapshot
		await foldOne(await factories.createState(CONTEXT, patience()), 100);
		const snapshotFor = (replaceLocal: boolean) => ({locations: [BODY], processor: 'proc-v1', replaceLocal});

		await factories.createState(CONTEXT, patience(), undefined, snapshotFor(false));
		const replaced = await factories.createState(CONTEXT, patience(), undefined, snapshotFor(true));

		expect(outcomes).toEqual([
			{status: 'kept-local', at: 100},
			{status: 'bootstrapped', at: SNAPSHOT_AT, from: BODY},
		]);
		expect(await replaced.getCurrent('token', {id: '2'})).toBeUndefined();
		expect(await replaced.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
	});

	it('hands the claim signal to `openForWriting` and to NOTHING else, so it never bounds the download', async () => {
		const snapshot = await published();
		const controller = new AbortController();
		// the host's patience runs out WHILE the snapshot downloads
		const host = serving(snapshot, () => controller.abort(new Error('the claim was not landed in time')));
		const outcomes: BootstrapOutcome[] = [];
		const factories = stateFactoriesFrom({
			open: constructor().open,
			entities: processor.entities,
			fetch: host.fetch,
			onBootstrap: (outcome) => outcomes.push(outcome),
		});

		const claimed = factories.createState(CONTEXT, {signal: controller.signal}, undefined, {
			locations: [BODY],
			processor: 'proc-v1',
		});

		// the CLAIM is refused by the signal...
		await expect(claimed).rejects.toBeInstanceOf(StoreClaimAbandonedError);
		// ...and the download it was not handed ran to the end
		expect(outcomes).toEqual([{status: 'bootstrapped', at: SNAPSHOT_AT, from: BODY}]);
		expect(host.asked.every((request) => request.init === undefined)).toBe(true);
	});
});
