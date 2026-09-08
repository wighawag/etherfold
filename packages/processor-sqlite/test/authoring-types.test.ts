import {describe, expect, it} from 'vitest';
import {fromSQLProcessor, VersionedStateEventProcessor, type SQLProcessor} from '../src/index.js';
import {createTestDB} from './utils/db.js';
import {finality, ownerOf, processor, SOURCE, transfer, lastSync, type TestABI} from './utils/fixtures.js';

// The authoring types moved to `@etherfold/processor-entities` and this package
// re-exports them, `SQLProcessor` under its old name. Re-exporting a type is not
// the same as aliasing it, and the difference is invisible at runtime, so it is
// pinned here at COMPILE time: `pnpm typecheck` is what runs these assertions,
// and vitest only proves the same object still indexes.
//
// The mechanism, because the failure is otherwise unreadable: `EntityProcessor`
// is an intersection whose handler half is a mapped type with REMAPPED keys
// (`on${EventName}`), which offers no site to infer `ABI` from. TypeScript
// infers it anyway, but only through its shortcut for a source and a target that
// share an alias SYMBOL. `export type {EntityProcessor as SQLProcessor}` resolves
// to that same symbol; `export type SQLProcessor<ABI, C> = EntityProcessor<ABI, C>`
// declares a new one, the shortcut misses, `ABI` falls back to its `Abi`
// constraint, and every call below fails with an error about handler variance
// that names no cause. See the note on the export in `src/types.ts`.

describe('the deprecated SQLProcessor name still infers its ABI', () => {
	it('is accepted by the constructor, which is generic over the ABI', async () => {
		const annotated: SQLProcessor<TestABI> = processor;
		const p = new VersionedStateEventProcessor(createTestDB(), annotated);
		await p.load(SOURCE, {finality});

		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		expect(await ownerOf(p, '1')).toBe('0xalice');
	});

	it('is accepted by the factory, and the factory keeps the ABI in its result', async () => {
		const annotated: SQLProcessor<TestABI> = processor;
		const make = fromSQLProcessor(annotated);
		const p: VersionedStateEventProcessor<TestABI> = make(createTestDB());
		await p.load(SOURCE, {finality});

		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xbob', id: 7n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		expect(await ownerOf(p, '7')).toBe('0xbob');
	});
});
