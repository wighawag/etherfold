import {
	BlockNotRetainedError,
	MemoryStateStore,
	createReadSurface,
	declareEntities,
	openForWriting,
	type StateStore,
	type WritableStateStore,
} from '@etherfold/state-store';
import {PatchStateStore} from '@etherfold/state-store-patch';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {createClient} from '@libsql/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {applyEventStream, type EntityProcessor} from '../src/index.js';
import {processor as fixtureProcessor, transfer, type TestABI} from './utils/fixtures.js';

/**
 * ONE description of the data, driving the storage AND the reads, on every
 * backend.
 *
 * The array below is what the processor declares (so the store owns the layout,
 * the versions and the revert) and it is what the read surface is generated
 * from. There is no second description anywhere in this file: no table name, no
 * column string, and no hand-written row type. Rename `owner` here and the
 * reader stops compiling.
 */
const entities = declareEntities([
	{name: 'token', id: 'id', fields: {owner: 'text', transferCount: 'integer'}},
	{name: 'counter', id: 'name', fields: {value: 'integer'}},
]);

/** The fixture processor, declaring those entities: the write half of the same object. */
const processor: EntityProcessor<TestABI> = {...fixtureProcessor, entities};

const backends = [
	{name: 'memory', make: (): Promise<WritableStateStore> => openForWriting(new MemoryStateStore(entities))},
	{
		name: 'sqlite',
		make: (): Promise<WritableStateStore> =>
			openForWriting(new VersionedStateStore(new RemoteLibSQL(createClient({url: ':memory:'})), entities)),
	},
	{
		name: 'patch',
		make: (): Promise<WritableStateStore> => openForWriting(new PatchStateStore(entities, {retention: 'revert-only'})),
	},
];

const STREAM = [
	transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
	transfer(100, '0xA', {from: '0xalice', to: '0xbob', id: 1n}),
	transfer(101, '0xB', {from: '0x0', to: '0xzoe', id: 2n}),
];

/**
 * The reader, written ONCE, against the declarations and against no backend.
 *
 * It is typed as `StateStore`, which is the whole claim: the surface a consumer
 * gets is generated from the declarations, so the same function runs against
 * versioned SQL rows, versioned rows in a Map, and a patch log.
 */
async function report(store: StateStore): Promise<Record<string, unknown>> {
	const surface = createReadSurface(store, entities);
	const token = await surface.token.getCurrent({id: '1'});
	const counter = await surface.counter.getCurrent({name: 'transfers'});
	// `token.owner` is `string | null` and `counter.value` is `number | null`,
	// both read off the declaration above rather than declared again here.
	return {owner: token?.owner, transferCount: token?.transferCount, transfers: counter?.value};
}

describe.each(backends)('the generated read surface runs unchanged on $name', (backend) => {
	it('answers the same questions with the same values', async () => {
		const store = await backend.make();
		await applyEventStream(store, processor, STREAM, undefined);

		expect(await report(store)).toEqual({owner: '0xbob', transferCount: 2, transfers: 3});
	});

	it('answers `undefined` for an entity that is absent, and nothing else', async () => {
		const store = await backend.make();
		await applyEventStream(store, processor, STREAM, undefined);
		const surface = createReadSurface(store, entities);

		expect(await surface.token.getCurrent({id: '99'})).toBeUndefined();
	});
});

describe('a historical read is answered or refused, never served from the tip', () => {
	it('answers as of an earlier block where the backend retains it', async () => {
		for (const backend of backends.filter((candidate) => candidate.name !== 'patch')) {
			const store = await backend.make();
			await applyEventStream(store, processor, STREAM, undefined);
			const surface = createReadSurface(store, entities);

			expect(await surface.counter.getAsOf({name: 'transfers'}, 100)).toMatchObject({value: 2});
			expect(await surface.token.getAsOf({id: '2'}, 100)).toBeUndefined();
		}
	});

	it('refuses, on the backend that keeps no history, rather than answering from the tip', async () => {
		// The patch store advertises `revert-only`: it keeps reverse patches for
		// reorg revert and answers no historical read at all. The generated surface
		// propagates that refusal; swallowing it into `undefined` would read as
		// "the counter did not exist then", which is a number a caller acts on.
		const store = await openForWriting(new PatchStateStore(entities, {retention: 'revert-only'}));
		await applyEventStream(store, processor, STREAM, undefined);
		const surface = createReadSurface(store, entities);

		expect(store.capabilities.asOf).toBe(false);
		await expect(surface.counter.getAsOf({name: 'transfers'}, 100)).rejects.toThrow(BlockNotRetainedError);
	});
});
