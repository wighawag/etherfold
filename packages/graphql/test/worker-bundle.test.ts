import {build} from 'esbuild';
import {describe, expect, it} from 'vitest';

/**
 * GRAPHQL IS OPT-IN IN THE WORKER BUNDLE (ADR-0099): `@etherfold/browser`
 * carries a generic query case and never imports GraphQL, so an app whose
 * worker entry passes no query handler bundles no `graphql` module and no
 * Pothos. Built with esbuild for a browser, as an app's bundler builds a worker
 * entry, and checked by what the bundle's metafile says went in; the entry that
 * DOES pass `graphqlQueryHandler` is the positive control, so the check is known
 * to see GraphQL when it is there.
 *
 * The size the runtime adds is measured by
 * `docs/spikes/a-worker-host-answers-graphql-over-its-port/measure.mjs` and
 * stated in the README.
 */

const PACKAGE = new URL('..', import.meta.url).pathname;

async function inputsOf(entry: string): Promise<string[]> {
	const result = await build({
		stdin: {contents: entry, resolveDir: PACKAGE, loader: 'ts'},
		bundle: true,
		platform: 'browser',
		format: 'esm',
		write: false,
		metafile: true,
		logLevel: 'silent',
	});
	return Object.keys(result.metafile.inputs);
}

const graphqlModules = (inputs: string[]) =>
	inputs.filter((input) => /node_modules\/(graphql|@pothos\/core)\//.test(input));

describe('a worker bundle', () => {
	it('built without the query handler contains no graphql module', async () => {
		const inputs = await inputsOf(
			`import {hostIndexerInThisWorker} from '@etherfold/browser';\nhostIndexerInThisWorker({} as never);`,
		);
		expect(inputs.some((input) => /browser\/dist\/host\/serve\.js$/.test(input))).toBe(true);
		expect(graphqlModules(inputs)).toEqual([]);
	});

	it('built with the query handler contains it (the control)', async () => {
		const inputs = await inputsOf(
			`import {hostIndexerInThisWorker} from '@etherfold/browser';\n` +
				`import {graphqlQueryHandler} from './src/worker/index.ts';\n` +
				`hostIndexerInThisWorker({query: graphqlQueryHandler()} as never);`,
		);
		expect(graphqlModules(inputs).length).toBeGreaterThan(0);
	});
});
