import {describe, expect, it} from 'vitest';
import {MemoryStateStore} from '@etherfold/state-store';
import {assertClonable, UnclonableValueError} from '../src/index.js';
import {processor} from '../browser/workload.js';

/**
 * WHAT MAY CROSS THE PORT, refused where it is WRITTEN.
 *
 * The failure this exists to end is `postMessage` throwing a `DataCloneError`
 * that names an OBJECT and not the FIELD it sat in, from a stack belonging to
 * the boundary rather than to the caller. So the check runs before the post, on
 * both ends, and every case a later task adds to the envelope inherits it.
 *
 * The `@etherfold/state-store` instance below is the case worth being careful
 * about, and it is why this refuses more than structured clone does: clone does
 * NOT refuse a class instance -- it copies the own properties, drops the
 * prototype, and hands the other side a bag with no methods. A store, a
 * processor or a provider sent that way "arrives" and then fails on its first
 * call, one layer away from anything that would explain it.
 */
describe('what the indexer port refuses to carry', () => {
	it('refuses a function, naming the field it sat in', () => {
		const message = {source: {chainId: '1'}, createProcessor: () => undefined};

		expect(() => assertClonable(message, `the 'init' request`)).toThrow(UnclonableValueError);
		expect(() => assertClonable(message, `the 'init' request`)).toThrow(
			/the 'init' request\.createProcessor cannot cross the indexer port: a function is CODE/,
		);
	});

	it('names the whole path to a nested field, so a big payload says WHERE', () => {
		const message = {rows: [{id: '1'}, {id: '2', read: () => undefined}]};

		try {
			assertClonable(message, 'the response');
			expect.unreachable('a function nested two levels down must still be refused');
		} catch (error) {
			expect((error as UnclonableValueError).path).toBe('the response.rows[1].read');
		}
	});

	it('refuses a LIVE OBJECT, which structured clone would silently flatten', () => {
		const store = new MemoryStateStore(processor.entities);

		try {
			assertClonable({state: store}, 'the response');
			expect.unreachable('a store handle must not be posted');
		} catch (error) {
			expect((error as UnclonableValueError).path).toBe('the response.state');
			expect((error as Error).message).toContain('MemoryStateStore');
			expect((error as Error).message).toContain('prototype dropped');
		}
	});

	it('carries the data shapes the surfaces actually use', () => {
		const payload = {
			lastToBlock: 105,
			latestBlock: 105,
			name: 'etherfold',
			absent: undefined,
			nothing: null,
			big: 10n,
			when: new Date(0),
			rows: [{owner: '0x11', ids: ['1', '2']}],
			byId: new Map([['1', {owner: '0x11'}]]),
			seen: new Set([1, 2]),
			bytes: new Uint8Array([1, 2, 3]),
		};

		expect(() => assertClonable(payload, 'the response')).not.toThrow();
		// the claim in the form that matters: the runtime agrees
		expect(structuredClone(payload)).toEqual(payload);
	});

	it('carries a cycle, because structured clone does', () => {
		const cyclic: Record<string, unknown> = {name: 'a'};
		cyclic.self = cyclic;

		expect(() => assertClonable(cyclic, 'the response')).not.toThrow();
	});

	it('refuses a symbol, which a copy of could never be', () => {
		expect(() => assertClonable({key: Symbol('id')}, 'the response')).toThrow(/the response\.key cannot cross/);
	});
});
