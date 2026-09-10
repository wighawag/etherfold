import type {EntityDeclaration} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {PatchStateStore} from '../src/index.js';

/**
 * What this store says about itself, before anything is read.
 *
 * Two claims, and both are refusals in disguise. `revert-only` says a historical
 * read will not be answered, so a caller that needs one discovers it at startup
 * instead of from a wrong number in production. `memory-only` says the state
 * will not be there after a reload, so a caller discovers THAT at startup
 * instead of from an empty tab.
 */

const ENTITIES: readonly EntityDeclaration[] = [{name: 'token', id: ['id'], fields: {owner: 'text'}}];

describe('the capability report', () => {
	it('claims revert-only history and memory-only durability, before `migrate`', () => {
		const store = new PatchStateStore(ENTITIES, {retention: 'revert-only', finalityDepth: 64});

		expect(store.capabilities).toEqual({
			retention: {kind: 'revert-only'},
			asOf: false,
			// honestly false: the storage is an instance field, so no second writer
			// can reach it and a writer token here would only compare with itself
			singleWriter: false,
			durability: 'memory-only',
		});
	});

	it('says the same with nothing configured: the claim is about the representation', () => {
		// A finality depth changes what gets PRUNED, never what can be answered.
		expect(new PatchStateStore(ENTITIES).capabilities).toEqual({
			retention: {kind: 'revert-only'},
			asOf: false,
			singleWriter: false,
			durability: 'memory-only',
		});
	});

	it('loses everything with the process, which is what `memory-only` means', async () => {
		const store = new PatchStateStore(ENTITIES);
		await store.migrate();
		await store.applyBlock({number: 100, hash: '0xaa', timestamp: 1_700_000_000}, [
			{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xalice'}},
		]);

		// a reload is a new store, and a new store is empty: there is no persistence
		// seam under this one to rescue it, deliberately (see the README and ADR-0023).
		const reloaded = new PatchStateStore(ENTITIES);
		await reloaded.migrate();
		expect(await reloaded.getCurrent('token', {id: '1'})).toBeUndefined();
		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
	});
});

describe('a retention this store cannot honour is refused where it is configured', () => {
	it('refuses a window, rather than quietly reporting less than it was set to', () => {
		expect(() => new PatchStateStore(ENTITIES, {retention: {blocks: 128} as never})).toThrow(/revert-only/);
		// and it says why, so the reader learns the sparsity fact at the point of
		// the mistake rather than from a finding they have not read
		expect(() => new PatchStateStore(ENTITIES, {retention: {blocks: 128} as never})).toThrow(/429/);
	});

	it('refuses `unbounded` too: keeping everything is not something a patch log can do', () => {
		expect(() => new PatchStateStore(ENTITIES, {retention: 'unbounded' as never})).toThrow(/revert-only/);
	});

	it('refuses a finality depth that is not a whole number of blocks', () => {
		expect(() => new PatchStateStore(ENTITIES, {finalityDepth: 1.5})).toThrow(/finality depth/i);
		expect(() => new PatchStateStore(ENTITIES, {finalityDepth: -1})).toThrow(/finality depth/i);
	});

	it('validates the declarations at construction, exactly as every other backend does', () => {
		expect(() => new PatchStateStore([{name: 'token', id: ['id'], fields: {_upper: 'text'}} as never])).toThrow(
			/reserved/i,
		);
	});
});
