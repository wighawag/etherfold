import {applySchema} from '@etherfold/server';
import type {EntityProcessor} from '@etherfold/processor-entities';
import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {openFolding} from '../src/folding.js';
import type {StoreTarget} from '../src/types.js';
import {abi, nftProcessor, SOURCE} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// AN ENTITY CANNOT BE NAMED AFTER A FIXED TABLE, BECAUSE THEY SHARE ONE DATABASE
// ---------------------------------------------------------------------------------------------------
// This is the shape the collision lived in. `buildProcessor` opens ONE handle and
// hands it to both the versioned-row store and (through `--serve`) the server, so
// the server's fixed tables and the processor's entity tables are rows in the same
// SQLite file. Entity DDL is `CREATE TABLE IF NOT EXISTS "<entity.name>"`, which
// means a processor declaring an entity named after a fixed table used to SUCCEED
// -- `IF NOT EXISTS` swallowed it -- and then die much later on a write, with a
// column error pointing nowhere near the declaration.
//
// It is closed by NAMING rather than by a new refusal: the fixed tables moved into
// the `_` namespace `@etherfold/state-store` already reserves (`_meta`,
// `_emissions`, beside the store's own `_blocks` and `_cursor`), so the refusal
// that already existed is the one that fires. Nothing here was told the server's
// names, and `@etherfold/state-store` still knows nothing about `@etherfold/server`.
//
// The store's own tables now live under a GENERATION's table namespace (ADR-0053)
// and the server's fixed ones deliberately do not, which does NOT weaken the
// refusal and is why it is still asserted here: the reserved-namespace rule is a
// fact about the DECLARATION, refused where the store is constructed, so it fires
// whether or not a prefix would in fact have kept the two apart.
// ---------------------------------------------------------------------------------------------------

const RETENTION = 'unbounded' as const;
const FINALITY = 12;

function target(): StoreTarget {
	return {kind: 'store', store: 'sqlite', db: ':memory:', retention: RETENTION};
}

/** The processor a deployment ships, with its entity list replaced by the one under test. */
function declaring(name: string): EntityProcessor<typeof abi, any> {
	return {
		...nftProcessor,
		entities: [{name, id: ['key'], fields: {value: 'text'}}],
	} as unknown as EntityProcessor<typeof abi, any>;
}

/** The combined shape: one handle, the server's fixed schema on it, a generation folding into it. */
async function foldInto(handle: RemoteSQL, declared: EntityProcessor<typeof abi, any>) {
	await applySchema(handle);
	return openFolding<typeof abi, unknown>(declared, target(), handle, {
		source: SOURCE,
		stream: {},
		finalityDepth: FINALITY,
		// the name the stored emission stream and the generation records are keyed on,
		// which every folding command resolves before it gets here (ADR-0052): required,
		// so that no shape can fold into a database without saying under which name it
		// stores what it folded
		indexer: 'alpha',
	});
}

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/** Every table and index the database actually holds, as SQLite itself describes them. */
async function namesIn(db: RemoteSQL): Promise<string[]> {
	const rows = await db
		.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name`)
		.all<{name: string}>();
	return rows.results.map((row) => row.name);
}

describe('an entity named after one of the server fixed tables', () => {
	for (const name of ['_meta', '_emissions']) {
		it(`is refused with the reserved-identifier error: ${name}`, async () => {
			const handle = oneDatabase();

			await expect(foldInto(handle, declaring(name))).rejects.toThrow(
				new RegExp(`reserved identifier for entity name.*${name}`, 's'),
			);
		});
	}

	it('is refused at DECLARATION time, so nothing was created before it failed', async () => {
		const handle = oneDatabase();
		await applySchema(handle);
		const before = await namesIn(handle);

		await expect(foldInto(handle, declaring('_emissions'))).rejects.toThrow(/reserved identifier/);

		// the whole defect was that the DDL RAN and succeeded against somebody else's
		// table; the refusal has to come before anything is issued
		expect(await namesIn(handle)).toEqual(before);
	});
});

describe('the database those two things share', () => {
	it('holds the fixed tables and the generation`s tables together, which is why the namespace matters', async () => {
		const handle = oneDatabase();
		const {store, container} = await foldInto(handle, nftProcessor as EntityProcessor<typeof abi, any>);
		await store.migrate();

		const names = await namesIn(handle);
		const {generationDigestOf} = await import('@etherfold/core');
		const namespace = generationDigestOf(container.generation);

		// the server's fixed tables, the store's own and the processor's entities -- one
		// file, with the second and third under this GENERATION's namespace (ADR-0053)
		// and the first deliberately not, because they are per NAMED INDEXER and shared
		// across its generations
		expect(names).toEqual(
			expect.arrayContaining([
				'_meta',
				'_emissions',
				'_generations',
				'_generation_pointer',
				`_${namespace}_blocks`,
				`_${namespace}_cursor`,
				`${namespace}_nft`,
				`${namespace}_counter`,
			]),
		);
		// and every one that is NOT a declared entity of this generation is inside the
		// reserved namespace, which is what makes a collision unreachable rather than
		// merely unlikely
		const declared = new Set([`${namespace}_nft`, `${namespace}_counter`]);
		const fixed = names.filter((name) => !declared.has(name) && !name.startsWith('sqlite_'));
		expect(fixed.filter((name) => !name.startsWith('_'))).toEqual([]);
	});
});
