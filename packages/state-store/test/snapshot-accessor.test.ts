import {describe, expect, it} from 'vitest';
import {
	BlockNotRetainedError,
	encodeSnapshot,
	MemoryStateStore,
	openForWriting,
	openSnapshotAware,
	type EntityDeclaration,
	type StateStoreBackend,
} from '../src/index.js';
import {ACCOUNT, TOKEN, block, owns} from './utils/fixtures.js';

/**
 * A SNAPSHOT-AWARE STORE OFFERS THE QUERY LAYER'S TWO READS (ADR-0099), and keeps
 * its own floor in front of them.
 *
 * `graphqlQueryHandler` answers a query through the store's `accessor()` and
 * `tip()`, which are not part of the seam. The documented boot path opens every
 * store through `openSnapshotAware`, bootstrapped or not, so the wrapper has to
 * offer both where the store underneath has them, and an accessor read as of a
 * block below the installed floor has to be REFUSED rather than answered from
 * rows that carry no history below it (ADR-0095, ADR-0028).
 *
 * The store underneath here is the memory store with a recording accessor bolted
 * on, so each case can see exactly which reads reached it.
 */

const FLOOR = 1_000;
const DECLARATIONS: readonly EntityDeclaration[] = [TOKEN, ACCOUNT];

type Call = {readonly method: string; readonly query: unknown};

/**
 * The memory store, plus an accessor that records what reached it, and a tip.
 *
 * Composed over a memory store rather than a subclass of one, because the memory
 * store keeps its own highest block in a field named `tip`, which an instance
 * property would hide a `tip()` method behind.
 */
type QueryableMemoryStore = StateStoreBackend & {
	readonly calls: Call[];
	readonly tipCalls: number;
	accessor(options?: {readonly label?: string}): unknown;
	tip(): Promise<number | undefined>;
};

function queryableMemoryStore(declarations: readonly EntityDeclaration[]): QueryableMemoryStore {
	const memory = new MemoryStateStore(declarations);
	const calls: Call[] = [];
	let tipCalls = 0;
	const extra: Record<PropertyKey, unknown> = {
		calls,
		get tipCalls() {
			return tipCalls;
		},
		accessor: (options?: {readonly label?: string}) => recordingAccessor(calls, options),
		tip: async () => {
			tipCalls++;
			return 4_242;
		},
	};
	return new Proxy(memory, {
		get(target, key) {
			if (key in extra) return extra[key];
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as unknown as QueryableMemoryStore;
}

function recordingAccessor(calls: Call[], options?: {readonly label?: string}) {
	return {
		label: options?.label ?? 'unlabelled',
		async find(query: {readonly at?: number}) {
			calls.push({method: 'find', query});
			return {rows: [], truncated: false};
		},
		async children(query: {readonly at?: number}) {
			calls.push({method: 'children', query});
			return [];
		},
		/** A read the seam does not have yet: it takes a `ReadAt` like the others. */
		async later(query: {readonly at?: number}) {
			calls.push({method: 'later', query});
			return 'answered';
		},
	};
}

type Floored = {
	find(query: {at?: number}): Promise<unknown>;
	children(query: {at?: number}): Promise<unknown>;
	later(query: {at?: number}): Promise<unknown>;
	readonly label: string;
};

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A no-history document at `FLOOR`. */
function snapshot(): Promise<Uint8Array> {
	return bytesOf(
		encodeSnapshot(
			{processor: 'proc-v1', savedAt: '2026-09-28T00:00:00.000Z', takenAt: block(FLOOR), floor: FLOOR},
			DECLARATIONS,
			[{block: block(FLOOR), mutations: [owns('1', '0xalice', 3)]}],
		),
	);
}

async function bootstrapped() {
	const inner = queryableMemoryStore(DECLARATIONS);
	const store = await openSnapshotAware(inner);
	await store.bootstrap(await snapshot());
	return {inner, store};
}

function accessorOf(store: {accessor?: (options?: never) => unknown}, options?: unknown): Floored {
	expect(typeof store.accessor).toBe('function');
	return store.accessor!(options as never) as Floored;
}

describe('a snapshot-aware store and the query layer', () => {
	it('offers no accessor and no tip when the store underneath has neither', async () => {
		const store = await openSnapshotAware(new MemoryStateStore(DECLARATIONS));
		expect(typeof store.accessor).not.toBe('function');
		expect(typeof store.tip).not.toBe('function');
		// and so neither does the claimed handle over it
		const claimed = (await openForWriting(store)) as {accessor?: unknown; tip?: unknown};
		expect(typeof claimed.accessor).not.toBe('function');
		expect(typeof claimed.tip).not.toBe('function');
	});

	it('reads the tip from the store underneath', async () => {
		const {inner, store} = await bootstrapped();
		expect(await store.tip!()).toBe(4_242);
		expect(inner.tipCalls).toBe(1);
	});

	it('hands the options to the store underneath, and keeps what the accessor carries besides its reads', async () => {
		const {store} = await bootstrapped();
		expect(accessorOf(store, {label: 'bound-60'}).label).toBe('bound-60');
	});

	it('never bootstrapped, passes every read through, whatever block it names', async () => {
		const inner = queryableMemoryStore(DECLARATIONS);
		const store = await openSnapshotAware(inner);
		const accessor = accessorOf(store);
		await accessor.find({at: 1});
		await accessor.children({at: 0});
		await accessor.find({});
		expect(inner.calls.map((call) => call.method)).toEqual(['find', 'children', 'find']);
	});

	it('bootstrapped, refuses every read below the floor with block-not-retained, before the store underneath is asked', async () => {
		const {inner, store} = await bootstrapped();
		const accessor = accessorOf(store);
		for (const read of [accessor.find, accessor.children, accessor.later]) {
			const refusal = await read({at: FLOOR - 1}).catch((error: unknown) => error);
			expect(refusal).toBeInstanceOf(BlockNotRetainedError);
			expect((refusal as BlockNotRetainedError).requested).toBe(FLOOR - 1);
		}
		expect(inner.calls).toEqual([]);
	});

	it('refuses exactly what `getAsOf` refuses: the same error, from the same narrowed claim', async () => {
		const {store} = await bootstrapped();
		const fromSeam = await store.getAsOf('token', {id: '1'}, FLOOR - 1).catch((error: unknown) => error);
		const fromAccessor = await accessorOf(store)
			.find({at: FLOOR - 1})
			.catch((error: unknown) => error);
		expect(fromAccessor).toBeInstanceOf(BlockNotRetainedError);
		expect((fromAccessor as Error).message).toBe((fromSeam as Error).message);
	});

	it('bootstrapped, answers a read at the floor and above it, and a tip read, through the store underneath unchanged', async () => {
		const {inner, store} = await bootstrapped();
		await store.applyBlock(block(FLOOR + 5), []);
		const accessor = accessorOf(store);
		expect(await accessor.find({at: FLOOR})).toEqual({rows: [], truncated: false});
		await accessor.children({at: FLOOR + 5});
		expect(await accessor.later({at: FLOOR + 1})).toBe('answered');
		await accessor.find({});
		expect(inner.calls).toEqual([
			{method: 'find', query: {at: FLOOR}},
			{method: 'children', query: {at: FLOOR + 5}},
			{method: 'later', query: {at: FLOOR + 1}},
			{method: 'find', query: {}},
		]);
	});

	it('checks the floor on every call, so an accessor built before a wipe and a bootstrap follows the floor', async () => {
		const inner = queryableMemoryStore(DECLARATIONS);
		const store = await openSnapshotAware(inner);
		const accessor = accessorOf(store);
		await accessor.find({at: 1});
		await store.bootstrap(await snapshot());
		await expect(accessor.find({at: 1})).rejects.toBeInstanceOf(BlockNotRetainedError);
		await store.revertTo(-1);
		await accessor.find({at: 1});
		expect(inner.calls.map((call) => (call.query as {at?: number}).at)).toEqual([1, 1]);
	});

	it('is what the claimed handle forwards, so a writer answering queries keeps the floor too', async () => {
		const {inner, store} = await bootstrapped();
		const claimed = await openForWriting(store);
		const accessor = accessorOf(claimed as {accessor?: (options?: never) => unknown});
		await expect(accessor.find({at: FLOOR - 1})).rejects.toBeInstanceOf(BlockNotRetainedError);
		await accessor.find({at: FLOOR});
		expect(inner.calls).toEqual([{method: 'find', query: {at: FLOOR}}]);
		expect(await (claimed as {tip?: () => Promise<number | undefined>}).tip!()).toBe(4_242);
	});
});
