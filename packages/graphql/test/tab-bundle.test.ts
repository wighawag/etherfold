import {build} from 'esbuild';
import {describe, expect, it} from 'vitest';

/**
 * GRAPHQL IS OFF THE TAB (ADR-0099): the schema and the `graphql` runtime live
 * in the worker, and the tab holds only `workerExecutor(port)`, so a tab entry
 * that imports `workerExecutor` bundles no `graphql` module and no Pothos.
 *
 * The entry imports `@etherfold/graphql/worker` BY NAME, so it resolves the way
 * an app resolves it: through the package's `./worker` export to the built
 * `dist/`, where the package's `"sideEffects": false` lets the bundler drop the
 * modules the entry does not use. Built with esbuild for a browser and checked
 * by what the bundle's metafile says went in: the inputs of the OUTPUT that
 * contributed bytes to it, since esbuild still reads (and lists among the
 * build's inputs) a module it then drops; the entry that imports something
 * that needs the runtime (`graphqlQueryHandler`) is the positive control, so the
 * check is known to see GraphQL when it is there.
 *
 * The size is measured on `examples/browser-reference` (`vite build`) and
 * stated in the README and the guide.
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
	const outputs = Object.values(result.metafile.outputs);
	expect(outputs).toHaveLength(1);
	return Object.entries(outputs[0]!.inputs)
		.filter(([, input]) => input.bytesInOutput > 0)
		.map(([path]) => path);
}

const graphqlModules = (inputs: string[]) =>
	inputs.filter((input) => /node_modules\/(graphql|@pothos\/core)\//.test(input));

describe('a tab bundle', () => {
	it('that imports only workerExecutor contains no graphql module', async () => {
		const inputs = await inputsOf(
			`import {workerExecutor} from '@etherfold/graphql/worker';\n` +
				`export const execute = workerExecutor({query: async () => ({data: {}})});`,
		);
		// resolved through the package's `./worker` export, not its source
		expect(inputs.some((input) => /dist\/worker\/executor\.js$/.test(input))).toBe(true);
		expect(graphqlModules(inputs)).toEqual([]);
	});

	it('that imports the query handler contains it (the control)', async () => {
		const inputs = await inputsOf(
			`import {graphqlQueryHandler} from '@etherfold/graphql/worker';\n` +
				`export const handler = graphqlQueryHandler();`,
		);
		expect(graphqlModules(inputs).length).toBeGreaterThan(0);
	});
});
