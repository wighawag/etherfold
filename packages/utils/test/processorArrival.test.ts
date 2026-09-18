import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {openProcessorArrival, readProcessorPath} from '../src/processorArrival.js';
import {processorArtifactIdentity} from '../src/processorArtifact.js';

// ---------------------------------------------------------------------------------------------------
// ONE PATH, TWO ARRIVALS
// ---------------------------------------------------------------------------------------------------
// A PATH is still how a deployment names its processor (ADR-0086); what changes
// is what the path points AT. These cases pin WHICH ARRIVAL a given path lands
// on, because that is the one thing about this unit a caller cannot see from its
// return type: an identity that is present means the bytes named the fold, and an
// identity that is absent means the author's declaration still does.
//
// Both arms must work at once and that is the subject rather than a caveat: four
// migrate batches and a contract task follow, and every one of them depends on
// the module arm being untouched while they land.
// ---------------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_BUNDLE = join(here, 'fixtures/processor-artifact/processor.bundle.js');

const scratch: string[] = [];

afterEach(async () => {
	for (const dir of scratch.splice(0)) {
		await rm(dir, {recursive: true, force: true}).catch(() => undefined);
	}
});

/** A file with these bytes, outside the repository, and its path. */
async function aFileHolding(name: string, source: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-arrival-'));
	scratch.push(dir);
	const path = join(dir, name);
	await writeFile(path, source, 'utf-8');
	return path;
}

/** A module object standing in for whatever `import()` would have produced. */
const A_DECLARED_MODULE = {createProcessor: () => ({version: '1.0.0', entities: []})};

describe('a path naming a BUNDLE', () => {
	it('is read, hashed and instantiated, and the identity is the hash of its octets', async () => {
		const arrival = await openProcessorArrival(FIXTURE_BUNDLE);

		expect(arrival.identity).toBe(processorArtifactIdentity(readFileSync(FIXTURE_BUNDLE)));
		expect(arrival.processor).toMatchObject({version: '1.0.0'});
		// the MODULE rides along, because `contractsData` lives on it and resolving a
		// source is the caller's step
		expect(Object.keys(arrival.processorModule)).toContain('createProcessor');
	});

	it('is the bytes and never the path, so the same artifact at two paths is one identity', async () => {
		const elsewhere = await aFileHolding('shipped.js', readFileSync(FIXTURE_BUNDLE, 'utf-8'));
		expect((await openProcessorArrival(elsewhere)).identity).toBe(
			(await openProcessorArrival(FIXTURE_BUNDLE)).identity,
		);
	});

	it('takes the bytes on DISK rather than an injected importer, which governs the module arm alone', async () => {
		const arrival = await openProcessorArrival(FIXTURE_BUNDLE, {importModule: async () => A_DECLARED_MODULE});
		expect(arrival.identity).toBe(processorArtifactIdentity(readFileSync(FIXTURE_BUNDLE)));
	});
});

describe('a path naming something that is NOT a bundle', () => {
	it('resolves an entry point that still imports a sibling through the module system', async () => {
		const path = await aFileHolding(
			'entry.mjs',
			`import {entities} from './entities.js';\nexport const createProcessor = () => ({version: '2.0.0', entities});\n`,
		);
		const seen: string[] = [];

		const arrival = await openProcessorArrival(path, {
			importModule: async (specifier) => {
				seen.push(specifier);
				return A_DECLARED_MODULE;
			},
		});

		// NO identity: there are no bytes that describe this processor, so the author's
		// declaration still names the fold
		expect(arrival.identity).toBeUndefined();
		expect(seen).toEqual([path]);
	});

	it('resolves a specifier that is not a readable file at all, exactly as it always did', async () => {
		const arrival = await openProcessorArrival('a-package-nobody-installed', {
			importModule: async () => A_DECLARED_MODULE,
			cwd: here,
		});
		expect(arrival.identity).toBeUndefined();
		expect(arrival.processor).toMatchObject({version: '1.0.0'});
	});

	it('resolves a RELATIVE path against the same cwd the module arm resolves it against', async () => {
		const bundle = await aFileHolding('nested.js', readFileSync(FIXTURE_BUNDLE, 'utf-8'));
		const arrival = await openProcessorArrival('./nested.js', {cwd: dirname(bundle)});
		expect(arrival.identity).toBe(processorArtifactIdentity(readFileSync(FIXTURE_BUNDLE)));
	});
});

// ---------------------------------------------------------------------------------------------------
// WHAT IS AT A PATH, WITHOUT LOADING IT
// ---------------------------------------------------------------------------------------------------
// The half of the arrival a CONFIGURATION layer needs on its own: a caller that
// refuses an unbundled `--processor` path (`refuseUnbundledProcessor`,
// `etherfold`) must say WHICH of the two it met and WHAT is still unresolved,
// where the arrival itself needs only "bundle or not". One function answers both,
// so the check that refuses a path and the arrival that opens it cannot mean two
// different files or two different verdicts about one.
// ---------------------------------------------------------------------------------------------------

describe('reading a path without loading it', () => {
	it('hands back the BYTES where they are self-contained', async () => {
		const contents = await readProcessorPath(FIXTURE_BUNDLE);
		expect(contents.kind).toBe('bundle');
		expect(contents.kind === 'bundle' && processorArtifactIdentity(contents.bundle)).toBe(
			processorArtifactIdentity(readFileSync(FIXTURE_BUNDLE)),
		);
	});

	it('names what an ENTRY POINT still expects somebody else to resolve', async () => {
		const path = await aFileHolding(
			'entry.mjs',
			`import {entities} from './entities.js';\nimport 'viem';\nexport const createProcessor = () => ({entities});\n`,
		);

		const contents = await readProcessorPath(path);
		expect(contents.kind).toBe('entry-point');
		expect(contents.kind === 'entry-point' && contents.unresolvedImports).toEqual(['./entities.js', 'viem']);
	});

	it('says a path it cannot read is unreadable, with the reason, rather than guessing at why', async () => {
		// a bare package specifier, a directory and a build that has not run are all the
		// same no: the question asked is "can I have these bytes"
		const contents = await readProcessorPath('a-package-nobody-installed', {cwd: here});
		expect(contents.kind).toBe('unreadable');
		expect(contents.kind === 'unreadable' && contents.why).toMatch(/ENOENT/);
	});
});

describe('a bundle that cannot become a processor', () => {
	it('raises with the path, the identity of the bytes and the artifact unit\u2019s own reason', async () => {
		const path = await aFileHolding('half-built.js', `throw new Error('the build has not run yet');\n`);

		await expect(openProcessorArrival(path)).rejects.toThrow(
			new RegExp(
				`${path}.*${processorArtifactIdentity(readFileSync(path))}.*unreadable-module.*the build has not run yet`,
			),
		);
	});

	it('raises rather than handing back something half-made, so a caller has nothing to unwind', async () => {
		const path = await aFileHolding('not-a-processor.js', `export const version = '1.0.0';\n`);
		await expect(openProcessorArrival(path)).rejects.toThrow(/not-a-processor/);
	});
});
