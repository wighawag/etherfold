import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {codeOnly} from './utils/codeOnly.js';

/**
 * The claim in this package's name, asserted rather than reviewed.
 *
 * "Light" is a property of what it drags in, and it is the kind of property that
 * erodes one convenient import at a time. This store exists for the deployment
 * that ships to a browser tab, so a dependency on the indexer core (and
 * therefore on viem), on a SQL interface, or on a runtime built-in would take
 * away the reason to choose it. It is also the direction ADR-0016 pins: a
 * processor package may depend on a store package, and never the reverse.
 *
 * `@etherfold/state-store-sqlite` asserts the same thing about itself, in
 * `test/no-platform-leakage.test.ts`, and for the same reason.
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

describe('the patch store stays light', () => {
	const files = sourceFiles(SRC);

	it('has source files to check', () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it('imports nothing but immer and the seam it implements', () => {
		const allowed = new Set(['immer', '@etherfold/state-store']);
		for (const file of files) {
			const source = readFileSync(file, 'utf-8');
			for (const match of source.matchAll(/^\s*import\s+(?:type\s+)?.*?from\s+'([^']+)'/gm)) {
				const specifier = match[1];
				if (specifier.startsWith('.')) continue;
				expect(allowed.has(specifier), `${file} imports ${specifier}`).toBe(true);
			}
		}
	});

	it('declares only immer and the seam as runtime dependencies', () => {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf-8'));
		expect(Object.keys(pkg.dependencies).sort()).toEqual(['@etherfold/state-store', 'immer']);
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
});
