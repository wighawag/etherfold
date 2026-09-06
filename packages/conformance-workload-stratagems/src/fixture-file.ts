/**
 * Reading and writing the fixture FILES this package commits.
 *
 * This used to live in `@etherfold/fs`, a STORAGE package whose every other
 * export (`keepStateOnFile`, `keepStreamOnFile`, the `storage` helper) had no
 * consumer: a filesystem keeper serves no supported runtime -- IndexedDB is the
 * browser backend, SQLite the server one -- so that package was deleted and its
 * one real consumer moved here. A fixture loader is test material reading test
 * material; it needs `node:fs` and `node:zlib`, which is exactly why it does NOT
 * belong in `@etherfold/core` (a package that names no runtime) and why no
 * storage package needs to exist for it to have a home.
 *
 * The parse and the serialize are `@etherfold/core`'s (`parseStreamFixture` /
 * `serializeStreamFixture`, one format number for the shape); what lives here is
 * only the FILE convention around them, which is why the gzip choice belongs to
 * the filename and not to a caller's second argument.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {parseStreamFixture, serializeStreamFixture, type StreamFixture} from '@etherfold/core';
import type {Abi} from '@etherfold/core';

/**
 * A fixture of a real chain is LARGE, and it is meant to be committed.
 *
 * A `.gz` path is therefore gzipped on write and gunzipped on read, chosen by
 * the extension so a caller states its intent in the filename and nothing else
 * has to know. It matters more than it looks: a real capture here is 33.8 MB of
 * JSON and 1.05 MB gzipped, so the compressed form saves 33 MB in every working
 * tree.
 * The uncompressed form stays the default because a small fixture should be
 * readable and diffable.
 *
 * The numbers moved on 2026-09-06, when the alpha1 capture was re-taken with its
 * `data` and `topics`: 33.8 MB of JSON against 1.05 MB gzipped, where the
 * decode-only form it replaced was 22.2 MB against 0.65 MB.
 */
function isGzipped(filePath: string): boolean {
	return filePath.endsWith('.gz');
}

/**
 * Write a captured stream to a file a replay can read anywhere.
 *
 * Indented by default, because a fixture is a committed artifact: it is read by
 * humans deciding whether to trust it, and diffed when it is re-captured, and
 * both of those are worthless on one long line. Indentation costs nothing in a
 * `.gz` fixture, since it compresses away.
 */
export function saveStreamFixture<ABI extends Abi>(filePath: string, fixture: StreamFixture<ABI>, indent = 2): void {
	const folder = path.dirname(filePath);
	if (folder && !fs.existsSync(folder)) {
		fs.mkdirSync(folder, {recursive: true});
	}
	const text = serializeStreamFixture(fixture, indent);
	fs.writeFileSync(filePath, isGzipped(filePath) ? zlib.gzipSync(text) : text);
}

/** Read a fixture from a file, gunzipping it when the path says so. Throws, with the path named, if it is not one. */
export function loadStreamFixture<ABI extends Abi>(filePath: string): StreamFixture<ABI> {
	const text = isGzipped(filePath)
		? zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf-8')
		: fs.readFileSync(filePath, 'utf-8');
	try {
		return parseStreamFixture<ABI>(text);
	} catch (err) {
		throw new Error(`${filePath}: ${(err as Error).message}`);
	}
}
