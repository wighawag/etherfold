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

/**
 * WHAT A TAB THAT ONLY READS PULLS IN, measured rather than asserted in prose.
 *
 * The reason the store proxy exists beside the query executor that arrives on
 * this same port later is a PAYLOAD claim: an app whose reads are `getCurrent`
 * should not pay for a query language on its first-paint path (ADR-0082, and the
 * spec prices a GraphQL runtime at 47.3 to 86.3 KB gzip). A claim like that is
 * worth nothing stated -- the whole point is that it stays true after somebody
 * else's import -- so it is a build, over the entry an app actually writes, with
 * assertions on what came out.
 *
 * The entry is INLINE rather than a committed fixture file: the three imports
 * ARE the claim, and a reader should not have to open another file to see which
 * ones were measured.
 */
describe('a tab that only reads across the port', () => {
	/** The tab half of an app: connect to the host, and generate the typed reads. */
	const TAB_ONLY = `
		import {connectToIndexerHost, createPortReadSurface, dedicatedWorkerHost} from './src/index.js';
		export const open = (worker: Worker, entities: never) =>
			createPortReadSurface(connectToIndexerHost(dedicatedWorkerHost(worker)), entities);
	`;

	/** The whole package, as an app that imports everything would get it. */
	const EVERYTHING = `export * from './src/index.js';`;

	async function bundled(contents: string): Promise<{text: string; modules: string[]; errors: unknown[]}> {
		const result = await build({
			stdin: {
				contents,
				// resolved from the package root, which is what `./src/index.js` above is
				// relative to
				resolveDir: new URL('..', import.meta.url).pathname,
				loader: 'ts',
				sourcefile: 'tab-only.ts',
			},
			bundle: true,
			platform: 'browser',
			format: 'esm',
			// minified, because the question is what a user DOWNLOADS
			minify: true,
			metafile: true,
			write: false,
			logLevel: 'silent',
		});
		return {
			text: result.outputFiles[0].text,
			modules: Object.keys(result.metafile.inputs),
			errors: result.errors,
		};
	}

	it('pulls in NO query runtime, and no store implementation either', async () => {
		const tab = await bundled(TAB_ONLY);

		expect(tab.errors).toEqual([]);

		// No query language, which is the claim this surface exists to make. There is
		// none in this repository to import yet, so this is a CANARY: the day the
		// executor `the-same-query-runs-against-a-worker-and-a-server` defines is
		// wired into a tab's import path, this is what says so.
		expect(tab.modules.filter((path) => /graphql/i.test(path))).toEqual([]);
		// ...including the richer tier this repo DOES have: `createQuerySurface`'s two
		// caller-supplied-SQL reads sit above the seam, on the server, and a tab that
		// reads across the port must not carry them.
		for (const absent of ['queryCurrent', 'queryAsOf']) {
			expect(tab.text).not.toContain(absent);
		}

		// And the same question one layer down, which is the honest form of "costs
		// the tab no runtime": the rows come from the HOST, so nothing that stores,
		// folds or fetches them belongs on this side.
		for (const absent of [
			'IndexedDBStateStore',
			'MemoryStateStore',
			'openIndexer',
			'createIndexerState',
			'serveIndexerHost',
		]) {
			expect(tab.text).not.toContain(absent);
		}
	});

	it('costs a fraction of what importing the whole package costs', async () => {
		const tab = await bundled(TAB_ONLY);
		const everything = await bundled(EVERYTHING);

		// Measured at 8.2 KB against 152.4 KB minified when this landed. The bound is
		// deliberately loose -- a size assertion that tracks reality to the byte is a
		// test that fails on every honest change -- and it is here to catch the
		// failure that matters: a tab-only import that silently starts dragging the
		// engine, a store or a query runtime behind it.
		expect(tab.text.length * 4).toBeLessThan(everything.text.length);
	});
});
