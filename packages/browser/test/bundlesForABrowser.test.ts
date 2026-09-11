import {build} from 'esbuild';
import {describe, expect, it} from 'vitest';

/**
 * This package must BUNDLE for a browser, which is not the same claim as "it
 * compiles".
 *
 * `tsc` resolves `node:path` happily and vitest runs in node, so a runtime
 * built-in reaching this package from a transitive dependency is invisible to
 * every other check here -- and fatal at the only place it matters, which is an
 * application's bundler. That is exactly what happened: `@etherfold/utils`'
 * barrel re-exports the CLI's processor loader (`node:module`, `node:path`) and
 * the deployment reader (`node:fs`), so `import '@etherfold/browser'` could not
 * be built for a browser at all, by esbuild or by vite. That dependency is gone
 * entirely now (it was there for the published blob snapshot's file naming, which
 * went with the free-form path, ADR-0037); this is what stops the class of
 * failure coming back through any other one.
 *
 * `platform: 'browser'` with no `external` is the whole assertion: esbuild
 * refuses to resolve a node built-in in that mode, so a leak is a failed build
 * naming the specifier and the file it came from.
 */
describe('@etherfold/browser', () => {
	it('bundles for a browser with no runtime built-ins', async () => {
		const result = await build({
			entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
			bundle: true,
			platform: 'browser',
			format: 'esm',
			// not written anywhere: the question is whether it RESOLVES, and the bytes
			// are of no interest.
			write: false,
			logLevel: 'silent',
		});

		expect(result.errors).toEqual([]);
	});

	/**
	 * The WORKER ENTRY POINT an application writes is a second thing that has to
	 * build, and it builds differently: it is its own bundle, with its own entry,
	 * produced by whatever the app's bundler is.
	 *
	 * `browser/indexer.worker.ts` is that file in the shape an app writes it --
	 * import the processor, import the entry helper, call it -- and the Playwright
	 * run bundles it through the harness. This says the same thing on every commit,
	 * where the browser binaries that run does not exist: a worker entry resolves
	 * for a browser target with nothing external, so the processor really does
	 * cross as an IMPORT and pulls no runtime built-in behind it.
	 */
	it('bundles an application worker entry point for a browser', async () => {
		const result = await build({
			entryPoints: [new URL('../browser/indexer.worker.ts', import.meta.url).pathname],
			bundle: true,
			platform: 'browser',
			format: 'esm',
			write: false,
			logLevel: 'silent',
		});

		expect(result.errors).toEqual([]);
	});
});
