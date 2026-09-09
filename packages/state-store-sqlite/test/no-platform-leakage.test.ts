import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {codeOnly} from './utils/codeOnly.js';

/**
 * The store targets the `remote-sql` interface, and one hosted SQLite backend is
 * one backend among several, never the target. This is a review criterion that
 * is easy to state and easy to erode, so it is asserted instead.
 *
 * The allowed set gained `@etherfold/state-store`, the seam this package
 * implements, and the meaning is unchanged: that package is the backend-neutral
 * contract, it declares NO dependencies of its own (asserted below), and it
 * knows nothing about any platform or any hosted backend. What the list still
 * refuses is the thing it was written to refuse -- this store growing a
 * dependency on a runtime, a provider, or on `@etherfold/core`, which would
 * invert ADR-0016's direction and drag the whole indexer (viem included) into a
 * storage primitive.
 *
 * (This test reads the filesystem; the *published* source it inspects does not.)
 */

const SRC = new URL('../src/', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith('.ts') ? [path] : [];
	});
}

describe('the package stays platform agnostic', () => {
	const files = sourceFiles(SRC);

	it('has source files to check', () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it('imports nothing but remote-sql, named-logs and the seam it implements', () => {
		const allowed = new Set(['remote-sql', 'named-logs', '@etherfold/state-store']);
		for (const file of files) {
			const source = readFileSync(file, 'utf-8');
			for (const match of source.matchAll(/^\s*import\s+(?:type\s+)?.*?from\s+'([^']+)'/gm)) {
				const specifier = match[1];
				if (specifier.startsWith('.')) continue;
				expect(allowed.has(specifier), `${file} imports ${specifier}`).toBe(true);
			}
		}
	});

	it('names no specific hosted backend and uses no runtime built-in', () => {
		for (const file of files) {
			const source = readFileSync(file, 'utf-8');
			// comments stripped: the sentence explaining why this store must not name D1
			// is not the store naming D1 (see `codeOnly`)
			const code = codeOnly(source);
			expect(code, file).not.toMatch(/\bD1\b/);
			expect(code, file).not.toMatch(/cloudflare/i);
			expect(code, file).not.toMatch(/from '(node|bun|cloudflare):/);
			expect(code, file).not.toMatch(/\bconsole\./);
		}
	});

	it('declares only remote-sql, named-logs and the seam as runtime dependencies', () => {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf-8'));
		expect(Object.keys(pkg.dependencies).sort()).toEqual(['@etherfold/state-store', 'named-logs', 'remote-sql']);
	});

	it('and the seam brings nothing with it, so the primitive stays a primitive', () => {
		// The one dependency added above is only harmless as long as it stays empty:
		// the moment the seam takes a dependency, this store inherits it.
		const seam = JSON.parse(readFileSync(new URL('../../state-store/package.json', import.meta.url).pathname, 'utf-8'));
		expect(Object.keys(seam.dependencies ?? {})).toEqual([]);
	});
});
