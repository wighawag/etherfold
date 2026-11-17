import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClient, type Client} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';

/** A fresh in-memory database. */
export function memoryDB(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/**
 * A database on DISK that can be closed and opened again, which is what a
 * restart of the consumer process is: nothing survives but what was committed.
 */
export function diskDB(): {open(): RemoteSQL; close(): void; remove(): void} {
	const dir = mkdtempSync(join(tmpdir(), 'etherfold-triggers-'));
	const url = `file:${join(dir, 'triggers.db')}`;
	let client: Client | undefined;
	return {
		open() {
			client = createClient({url});
			return new RemoteLibSQL(client);
		},
		close() {
			client?.close();
			client = undefined;
		},
		remove() {
			client?.close();
			rmSync(dir, {recursive: true, force: true});
		},
	};
}

/** A database whose NEXT `batch` fails, as one does that loses its connection mid-commit. */
export function failingNextBatch(db: RemoteSQL): {db: RemoteSQL; failNext(): void} {
	let fail = false;
	return {
		failNext() {
			fail = true;
		},
		db: {
			prepare: (sql) => db.prepare(sql),
			batch: async (list) => {
				if (fail) {
					fail = false;
					throw new Error('the database went away mid-commit');
				}
				return db.batch(list);
			},
		},
	};
}
