// What the GraphQL runtime ADDS to a worker bundle (ADR-0099): the same worker
// entry built twice, minified for a browser as an app's bundler builds it,
// without and with `graphqlQueryHandler` from `@etherfold/graphql/worker`, and
// the gzipped difference reported.
//
// Run after `pnpm build` (it bundles `@etherfold/browser` from its `dist/`):
//
//   node docs/spikes/a-worker-host-answers-graphql-over-its-port/measure.mjs
//
// It resolves every package from `packages/graphql`, which depends on both.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

const graphqlPackage = fileURLToPath(new URL('../../../packages/graphql/', import.meta.url));
const {build} = createRequire(graphqlPackage)('esbuild');

const WITHOUT = `import {hostIndexerInThisWorker} from '@etherfold/browser';
hostIndexerInThisWorker({});`;
const WITH = `import {hostIndexerInThisWorker} from '@etherfold/browser';
import {graphqlQueryHandler} from './src/worker/index.ts';
hostIndexerInThisWorker({query: graphqlQueryHandler()});`;

async function sizeOf(contents) {
	const result = await build({
		stdin: {contents, resolveDir: graphqlPackage, loader: 'ts'},
		bundle: true,
		minify: true,
		platform: 'browser',
		format: 'esm',
		target: 'es2022',
		write: false,
		logLevel: 'silent',
	});
	const bytes = result.outputFiles[0].contents;
	return {raw: bytes.length, gzip: gzipSync(bytes, {level: 9}).length};
}

const without = await sizeOf(WITHOUT);
const withHandler = await sizeOf(WITH);
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
console.log(`worker entry without the query handler: ${kb(without.raw)} minified, ${kb(without.gzip)} gzipped`);
console.log(`worker entry with graphqlQueryHandler:  ${kb(withHandler.raw)} minified, ${kb(withHandler.gzip)} gzipped`);
console.log(
	`the GraphQL runtime adds:                ${kb(withHandler.raw - without.raw)} minified, ${kb(withHandler.gzip - without.gzip)} gzipped`,
);
