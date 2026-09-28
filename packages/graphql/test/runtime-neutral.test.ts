import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {build} from 'esbuild';
import {describe, expect, it} from 'vitest';

/**
 * ONE SCHEMA IS ONE SCHEMA only if both tiers can import the module that builds
 * it (ADR-0099): a server on Node and a browser worker. So it is BUILT for both,
 * with nothing external, which is the claim that matters (esbuild refuses a
 * runtime built-in on a browser target, and would name the file it came from),
 * and its imports are listed, so a runtime-specific dependency cannot arrive
 * quietly through a later edit. The worker transport is the `./worker` subpath
 * (`@etherfold/graphql/worker`), the ONLY source that names `@etherfold/browser`
 * (for its types), and the root entry never reaches it.
 *
 * The query conformance suite is the `./conformance` subpath and imports
 * vitest, as every suite in this repository does: it is a TEST's import and
 * never the root's, so it is held to its own list, and the root entry is held
 * to never reaching it.
 *
 * (This test reads the filesystem; the published source it inspects does not.)
 */

const SRC = new URL('../src/', import.meta.url).pathname;
const ENTRY = new URL('../src/index.ts', import.meta.url).pathname;
const CONFORMANCE = new URL('../src/conformance/', import.meta.url).pathname;
const WORKER = new URL('../src/worker/', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith('.ts') ? [path] : [];
	});
}

describe('@etherfold/graphql is runtime-neutral', () => {
	for (const platform of ['browser', 'node'] as const) {
		it(`builds for a ${platform} target with nothing external`, async () => {
			const result = await build({
				entryPoints: [ENTRY],
				bundle: true,
				platform,
				format: 'esm',
				write: false,
				logLevel: 'silent',
			});
			expect(result.errors).toEqual([]);
		});
	}

	it('bundles nothing of @etherfold/browser into the root entry', async () => {
		const result = await build({
			entryPoints: [ENTRY],
			bundle: true,
			platform: 'browser',
			format: 'esm',
			write: false,
			metafile: true,
			logLevel: 'silent',
		});
		const inputs = Object.keys(result.metafile.inputs);
		expect(inputs.some((input) => /(^|\/)src\/index\.ts$/.test(input))).toBe(true);
		expect(inputs.filter((input) => /packages\/browser\/|@etherfold\/browser|src\/worker\//.test(input))).toEqual([]);
	});

	it('imports nothing but graphql, Pothos and the two seams', () => {
		const allowed = new Set(['graphql', '@pothos/core', '@etherfold/accessor', '@etherfold/state-store']);
		// the suite reads the seams and runs under vitest; it never imports a backend
		const allowedInConformance = new Set([...allowed, 'vitest', '@etherfold/accessor/conformance']);
		// the worker subpath names the browser host's types, and nothing of it at run time
		const allowedInWorker = new Set([...allowed, '@etherfold/browser']);
		const files = sourceFiles(SRC);
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const inConformance = file.startsWith(CONFORMANCE);
			const inWorker = file.startsWith(WORKER);
			const source = readFileSync(file, 'utf-8');
			const allowedHere = inConformance ? allowedInConformance : inWorker ? allowedInWorker : allowed;
			for (const match of source.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?[^'";]*?from\s+'([^']+)'/gm)) {
				const specifier = match[1]!;
				if (specifier.startsWith('.')) {
					if (!inConformance) expect(specifier, `${file} reaches the conformance suite`).not.toMatch(/conformance/);
					if (!inWorker) expect(specifier, `${file} reaches the worker subpath`).not.toMatch(/worker/);
					continue;
				}
				expect(allowedHere.has(specifier), `${file} imports ${specifier}`).toBe(true);
				if (specifier === '@etherfold/browser') {
					expect(match[0], `${file} imports @etherfold/browser at run time`).toMatch(/^\s*import\s+type\s/);
				}
			}
			expect(source, file).not.toMatch(/from '(node|bun|cloudflare):/);
			expect(source, file).not.toMatch(/\bconsole\./);
		}
	});

	it('declares only those as runtime dependencies', () => {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf-8'));
		expect(Object.keys(pkg.dependencies).sort()).toEqual([
			'@etherfold/accessor',
			'@etherfold/state-store',
			'@pothos/core',
			'graphql',
		]);
	});
});
