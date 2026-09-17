/**
 * Builds the retained ARTIFACT the spike tries to instantiate, with the command
 * `a-generation-retains-the-code-that-folds-it` documents as the default:
 *
 *   esbuild <entry> --bundle --format=esm --minify
 *
 * A second build in `iife` format exists only so the `new Function` mechanism has
 * something it could plausibly evaluate: an ESM bundle cannot be passed to
 * `new Function` at all (top-level `export` is a syntax error there), so testing
 * `unsafe-eval` against the ESM artifact would measure the wrong refusal.
 */
import {build} from 'esbuild';
import {mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, 'fixture/processor.entry.js');
mkdirSync(join(here, 'fixture'), {recursive: true});

await build({
	entryPoints: [entry],
	bundle: true,
	format: 'esm',
	minify: true,
	outfile: join(here, 'fixture/processor.bundle.js'),
});

await build({
	entryPoints: [entry],
	bundle: true,
	format: 'iife',
	globalName: '__spikeProcessor',
	minify: true,
	outfile: join(here, 'fixture/processor.iife.js'),
});

console.log('built fixture/processor.bundle.js (esm) and fixture/processor.iife.js (iife)');
