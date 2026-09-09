import {readFileSync} from 'node:fs';
import {BlockNotRetainedError, BlockUnavailableError, type EntityDeclaration} from '@etherfold/state-store';
import {beforeEach, describe, expect, it} from 'vitest';
import {codeOnly} from './utils/codeOnly.js';
import {PatchStateStore} from '../src/index.js';

/**
 * The single failure mode this backend exists to prevent: a historical read
 * answered from the tip.
 *
 * It is worse than an error because it is PLAUSIBLE. A refusal is a thing a
 * caller handles; a tip value served as "the state at block N" is a number
 * nothing downstream can tell apart from a true one, and it is exactly what a
 * caller would get today from a light store that has no concept of history.
 *
 * So the assertions come in two kinds. The behavioural ones ask for history at
 * every depth there is and require a typed refusal each time. The structural one
 * reads the source of the two as-of methods and requires that they touch no
 * state at all, because "it refuses today" is a property a later edit can
 * remove by accident and "it cannot read" is not.
 */

const ENTITIES: readonly EntityDeclaration[] = [
	{name: 'token', id: ['id'], fields: {owner: 'text'}},
	{name: 'placement', id: ['epoch', 'position'], fields: {player: 'text'}},
];

describe('every historical read is refused', () => {
	let store: PatchStateStore;

	beforeEach(async () => {
		store = new PatchStateStore(ENTITIES, {retention: 'revert-only', finalityDepth: 64});
		await store.migrate();
		await store.applyBlock({number: 100, hash: '0xaa', timestamp: 1_700_000_000}, [
			{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xalice'}},
			{type: 'upsert', entity: 'placement', id: {epoch: 7, position: 1}, values: {player: '0xalice'}},
		]);
		await store.applyBlock({number: 101, hash: '0xbb', timestamp: 1_700_000_012}, [
			{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xbob'}},
		]);
	});

	it('refuses `getAsOf` at every depth, including the tip and the block just applied', async () => {
		for (const at of [101, 100, 99, 0, 1_000_000]) {
			const error = await store.getAsOf('token', {id: '1'}, at).catch((e: unknown) => e);

			expect(error, `as of ${at}`).toBeInstanceOf(BlockNotRetainedError);
			expect((error as BlockNotRetainedError).reason, `as of ${at}`).toBe('no-historical-reads');
			// `undefined` rather than an empty range: nothing is retained for
			// READING, and an empty range would invite arithmetic on a boundary that
			// does not exist.
			expect((error as BlockNotRetainedError).retained, `as of ${at}`).toBeUndefined();
			expect((error as BlockNotRetainedError).requested, `as of ${at}`).toBe(at);
		}
	});

	it('refuses `listAsOf` the same way, so a derived collection cannot be read from the tip either', async () => {
		const error = await store.listAsOf('placement', {epoch: 7}, 100, 10).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(BlockNotRetainedError);
		expect((error as BlockNotRetainedError).reason).toBe('no-historical-reads');
	});

	it('refuses with the seam\'s own error family, so one `catch` covers "my historical read did not happen"', async () => {
		await expect(store.getAsOf('token', {id: '1'}, 100)).rejects.toBeInstanceOf(BlockUnavailableError);
	});

	it('refuses even for an entity that never existed, because the CAPABILITY is missing, not the row', async () => {
		await expect(store.getAsOf('token', {id: 'never'}, 100)).rejects.toBeInstanceOf(BlockNotRetainedError);
	});

	it('still answers the reads that are honestly about the tip', async () => {
		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
		expect((await store.listCurrent<Record<string, unknown>>('placement', {epoch: 7}, 10)).rows).toHaveLength(1);
	});

	it('reverts to the value an as-of read is refused for, which is the whole point of keeping the patches', async () => {
		await store.revertTo(100);
		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
	});
});

describe('the as-of methods cannot read state, by construction', () => {
	const source = readFileSync(new URL('../src/store.ts', import.meta.url).pathname, 'utf-8');

	/**
	 * The CODE of one method, from its signature to the closing brace at class indent.
	 *
	 * Comments are stripped (see `codeOnly`), because this slice is matched for the
	 * ABSENCE of things -- `this.state`, `getCurrent`, `return` -- and a doc comment
	 * explaining that the method deliberately does not reach for stored state names
	 * every one of them. Without this, documenting the property fails the test that
	 * asserts the property, and the cheapest fix is to stop documenting it.
	 *
	 * The slice is still taken from the RAW source, so the `\n\t}` terminator keeps
	 * meaning "closing brace at class indent"; only the matched text is stripped.
	 */
	function bodyOf(method: string): string {
		const start = source.indexOf(`async ${method}<`);
		expect(start, `${method} is declared in src/store.ts`).toBeGreaterThan(-1);
		const end = source.indexOf('\n\t}', start);
		expect(end, `${method} closes`).toBeGreaterThan(start);
		return codeOnly(source.slice(start, end));
	}

	for (const method of ['getAsOf', 'listAsOf']) {
		it(`${method} throws and touches no state`, () => {
			const body = bodyOf(method);

			// A behavioural test proves it refuses TODAY. This is what makes it
			// impossible to break tomorrow by "falling back" to the current value:
			// the method reads nothing, so there is no tip value in scope to return.
			expect(body, `${method} must not reach for stored state`).not.toMatch(
				/this\.state|getCurrent|listCurrent|this\.blocks|this\.reversals/,
			);
			expect(body, `${method} must throw rather than return`).toMatch(/throw new BlockNotRetainedError/);
			expect(body, `${method} must not return a value`).not.toMatch(/\breturn\b/);
		});
	}
});
