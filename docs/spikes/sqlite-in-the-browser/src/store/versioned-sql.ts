/**
 * The candidate under test: the REAL `@etherfold/state-store-sqlite` store,
 * behind the same seam as every other candidate.
 *
 * Nothing about the store is reimplemented here. That is the point of the
 * comparison: if wasm SQLite is ever going to win, it wins by running the SQL
 * this project already has, verbatim, which is exactly what the `remote-sql`
 * seam lets it do. The only new code is the adapter below.
 */
import {VersionedStateStore} from '../../../../../packages/state-store-sqlite/dist/index.js';
import type {EntityDeclaration} from '../../../../../packages/state-store-sqlite/dist/index.js';
import {stratagemsEntities} from '../port/entities.js';
import {
	RetentionUnavailableError,
	type BlockStore,
	type BlockUpdate,
	type EntityId,
	type Retention,
} from './types.js';

/** The `remote-sql` shape, restated so this file needs no dependency on it. */
export interface SqlStatement {
	bind(...values: unknown[]): SqlStatement;
	all<T = any>(): Promise<{results: T[]}>;
}
export interface SqlDatabase {
	prepare(sql: string): SqlStatement;
	batch<T = any>(list: SqlStatement[]): Promise<{results: T[]}[]>;
}

export class VersionedSqlBlockStore implements BlockStore {
	private store: VersionedStateStore;
	private tip = 0;

	constructor(
		readonly name: string,
		private db: SqlDatabase,
		readonly retention: Retention = {kind: 'unbounded'},
		entities: readonly EntityDeclaration[] = stratagemsEntities,
	) {
		this.store = new VersionedStateStore(db as any, entities);
	}

	async open(): Promise<void> {
		await this.store.migrate();
	}

	async close(): Promise<void> {}

	async applyBlock(update: BlockUpdate): Promise<void> {
		await this.store.applyBlock(update.block, update.mutations as any);
		this.tip = update.block.number;
	}

	async get(entity: string, id: EntityId): Promise<Record<string, unknown> | undefined> {
		return this.store.getCurrent(entity, id);
	}

	async getAsOf(entity: string, id: EntityId, blockNumber: number): Promise<Record<string, unknown> | undefined> {
		if (this.retention.kind === 'revert-only' && blockNumber < this.tip) {
			throw new RetentionUnavailableError(this.name, blockNumber, this.retention);
		}
		if (this.retention.kind === 'window' && blockNumber < this.tip - this.retention.blocks) {
			throw new RetentionUnavailableError(this.name, blockNumber, this.retention);
		}
		return this.store.getAsOf(entity, id, blockNumber);
	}

	async revertTo(blockNumber: number): Promise<void> {
		await this.store.revertTo(blockNumber);
		this.tip = blockNumber;
	}

	/**
	 * Drop versions that closed below a retention floor.
	 *
	 * SPIKE CODE: the spec says "pruning drops versions whose upper bound is older
	 * than the window", and this is what that statement cost when it was measured,
	 * not what the package does.
	 *
	 * AMENDED 2026-09-10 (`the-prune-claims-in-the-docs-match-the-code`): as written on 2026-08-22 this docstring added that its absence upstream is itself a result, because `@etherfold/state-store-sqlite` "has no pruning at all today, so every backend it ships is effectively `unbounded`". True then, FALSE now. Both shipped backends implement `prune` (`packages/state-store-sqlite/src/store.ts`, `packages/state-store-indexeddb/src/store.ts`): budgeted, keyed off the retention floor, never reaching a live version or a block record, reporting whether the pass finished. What is narrower than "retention is enforced everywhere" is now the HOST and not the backend: the browser loop and the CLI's `run`/`build` schedule a pass, `etherfold index` and any bespoke host do not. The one thing this spike prune does that the shipped one does not is `VACUUM`, which is why the footprint saving measured here is a FILE-SIZE saving. Nothing here changes: this is the exhibit those numbers were taken with. See the amendment in `work/notes/findings/sqlite-in-the-browser.md`.
	 */
	async prune(floor: number): Promise<void> {
		const statements = [...this.store.declarations.keys()].map((entity) =>
			this.db.prepare(`DELETE FROM ${entity} WHERE _upper IS NOT NULL AND _upper <= ?`).bind(floor),
		);
		await this.db.batch(statements);
		// Without VACUUM the file keeps the freed pages, so a footprint number
		// taken straight after a prune would show no saving at all.
		await this.db.prepare('VACUUM').bind().all();
	}

	/** Bytes SQLite reports for its own pages: the footprint measurement. */
	async byteSize(): Promise<number | undefined> {
		try {
			const result = await this.db.prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').bind().all<{bytes: number}>();
			return result.results[0]?.bytes;
		} catch {
			return undefined;
		}
	}
}
