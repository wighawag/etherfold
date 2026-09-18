import {processorArtifactIdentity} from '@etherfold/utils';
import {createClient} from '@libsql/client';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {canonicalGenerationIn, prepareIndexing, type IndexingDependencies} from '../src/index.js';
import type {Options} from '../src/types.js';
import {entityModule, fakeChain, START_BLOCK, transfer, ALICE, ZERO} from './utils/chain.js';
import {identityOf} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------------------------------
// AN INJECTED ARRIVAL SUPPLIES ITS OWN IDENTITY, WHICH IS WHAT KEEPS THIS PACKAGE'S
// SUITES OFF THE DECLARED FALLBACK
// ---------------------------------------------------------------------------------------------------
// ADR-0086's invariant is that an author cannot STATE a processor's identity and
// that the engine is HANDED one and never asks where it came from. `deps` is
// "what a test may substitute for the real world", and `importModule` is how a
// suite states WHAT comes back for a `--processor` path. What it could not state
// until now is WHAT THAT ARRIVAL IS CALLED, so every deployment stood up that way
// fell through to `getVersionHash()` -- the author-DECLARED identity that
// `the-declared-version-and-the-drift-report-are-deleted` removes.
//
// `deps.processorIdentity` is the other half of that one seam: a suite that
// injects an arrival names it too, exactly as a real arrival does when it reads
// bytes off a disk. This file is the guard on it, and it exists because the
// failure it prevents is SILENT: if the value stopped reaching the registry, the
// dozen suites in this package that now pass it would quietly go back to the
// declared identity and go on passing, which is precisely the remainder this
// batch was written to remove.
//
// What it is NOT is a way to DECLARE an identity. It is not a flag, it is not an
// environment variable and no configuration reaches it; and where the path names
// real BYTES, those bytes win, asserted below -- so it can never overrule a
// derivation, only supply one where the injected arrival made none.
// ---------------------------------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL('./fixtures/processor-bundle/', import.meta.url));
const BUNDLE = join(FIXTURES, 'nfts.bundle.js');

const LOGS = [transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n)];
const TIP = START_BLOCK + 100;

/** Bounded fetch ranges, read from the environment the way every fetcher host reads them. */
const SMALL_RANGES = {MAX_BLOCKS_PER_FETCH: '20'};

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

function optionsFor(processor: string): Options {
	return {processor, nodeUrl: 'http://localhost:0', store: 'sqlite', db: ':memory:'};
}

/** Fold `LOGS` to the tip through whatever the deps describe, and hand back the database. */
async function aDeploymentFolding(processor: string, extra: IndexingDependencies): Promise<RemoteSQL> {
	const db = oneDatabase();
	const chain = fakeChain().serve(LOGS, TIP);
	const prepared = await prepareIndexing('build', optionsFor(processor), {
		provider: chain.provider,
		createDB: () => db,
		sleep: async () => {},
		env: SMALL_RANGES,
		...extra,
	});
	await prepared.index();
	return db;
}

/** WHICH GENERATION ANSWERS READS here, read through the durable pointer (ADR-0053). */
async function registeredIdentityIn(db: RemoteSQL): Promise<string> {
	const canonical = await canonicalGenerationIn(db);
	if (canonical === undefined) throw new Error(`this database registered no generation at all`);
	return canonical.processor;
}

describe('a deployment whose arrival was INJECTED', () => {
	it('registers the identity that arrival supplied', async () => {
		const identity = identityOf('an-injected-arrival');

		const db = await aDeploymentFolding('./nfts.js', {
			importModule: async () => entityModule,
			processorIdentity: identity,
		});

		// EXACTLY that value, which is also what says it did not fall through: the
		// author-DECLARED identity is `${version}-${hash}` and can never be a bare
		// `sha256:` digest. Asserted as an equality rather than by computing the declared
		// hash to compare against, so that this file goes on passing when the contract
		// task deletes the function that computes one.
		expect(await registeredIdentityIn(db)).toBe(identity);
	});

	it('names two folds by their arrivals, where nothing about the processor differs at all', async () => {
		// the SAME declared object both times, which is what says the identity came
		// from the arrival rather than from anything the author wrote
		const first = await aDeploymentFolding('./nfts.js', {
			importModule: async () => entityModule,
			processorIdentity: identityOf('the-incumbent-fold'),
		});
		const second = await aDeploymentFolding('./nfts.js', {
			importModule: async () => entityModule,
			processorIdentity: identityOf('the-successor-fold'),
		});

		expect(await registeredIdentityIn(first)).not.toBe(await registeredIdentityIn(second));
	});
});

describe('BYTES on a disk still win, so an injected value can never overrule a derivation', () => {
	it('names a real bundle by its hash, whatever the injected identity says', async () => {
		const db = await aDeploymentFolding(BUNDLE, {processorIdentity: identityOf('not-what-is-on-disk')});

		expect(await registeredIdentityIn(db)).toBe(processorArtifactIdentity(readFileSync(BUNDLE)));
	});
});
