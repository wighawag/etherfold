import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {codeOnly} from './utils/codeOnly.js';

/**
 * A storage backend may be depended ON by a processor, and never the reverse
 * (ADR-0016, ADR-0018). It is a review criterion that is easy to state and easy
 * to erode -- one convenient import of `@etherfold/core` and installing a
 * browser store pulls in the whole indexer, viem included -- so it is asserted.
 *
 * The BROWSER TESTS legitimately use `@etherfold/processor-entities` and
 * `@etherfold/core`: running the same processor in a tab is the point of the
 * seam, and a devDependency is not a dependency. That is exactly why this test
 * looks at `src/` and at `dependencies`, and not at the test graph.
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

describe('the store stays a primitive', () => {
	const files = sourceFiles(SRC);

	it('has source files to check', () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it('imports nothing but the seam it implements', () => {
		const allowed = new Set(['@etherfold/state-store']);
		for (const file of files) {
			const source = readFileSync(file, 'utf-8');
			for (const match of source.matchAll(/^\s*import\s+(?:type\s+)?.*?from\s+'([^']+)'/gm)) {
				const specifier = match[1];
				if (specifier.startsWith('.')) continue;
				expect(allowed.has(specifier), `${file} imports ${specifier}`).toBe(true);
			}
		}
	});

	it('declares only the seam as a runtime dependency', () => {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf-8'));
		expect(Object.keys(pkg.dependencies)).toEqual(['@etherfold/state-store']);
	});

	it('uses no runtime built-in and no console', () => {
		for (const file of files) {
			const source = readFileSync(file, 'utf-8');
			// comments stripped: prose about a runtime is not a dependency on one (see `codeOnly`)
			const code = codeOnly(source);
			expect(code, file).not.toMatch(/from '(node|bun|cloudflare):/);
			expect(code, file).not.toMatch(/\bconsole\./);
		}
	});

	it('talks to IndexedDB through the global or an injected factory, never a shim', () => {
		// the point of this backend is the engine underneath it, so a bundled
		// polyfill would make every measurement and every capability claim a claim
		// about something else.
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf-8'));
		expect(Object.keys(pkg.dependencies)).not.toContain('fake-indexeddb');
		expect(Object.keys(pkg.devDependencies)).toContain('fake-indexeddb');
	});
});
