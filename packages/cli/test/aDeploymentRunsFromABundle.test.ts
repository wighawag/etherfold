import {createClient} from '@libsql/client';
import {processorArtifactIdentity} from '@etherfold/utils';
import {copyFile, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {
	canonicalGenerationIn,
	prepareIndexing,
	run,
	type IndexingDependencies,
	type RunningIndexer,
} from '../src/index.js';
import type {Options} from '../src/types.js';
import {
	abi,
	ALICE,
	BOB,
	CONTRACT,
	entityModule,
	fakeChain,
	nftProcessor,
	START_BLOCK,
	transfer,
	ZERO,
} from './utils/chain.js';
import {canonicalStoreIn} from './utils/reads.js';

// ---------------------------------------------------------------------------------------------------
// A DEPLOYMENT RUNS FROM A BUNDLE, AND THE BUNDLE'S HASH NAMES WHAT IT REGISTERED
// ---------------------------------------------------------------------------------------------------
// The tracer bullet of ADR-0086: one path from a bundle on disk to a folded
// block, with the generation's `processor` identity coming from the ARTIFACT
// rather than from a field the author declared. It is driven the way every other
// CLI test drives a deployment -- `prepareIndexing` with a fake chain and one
// libSQL handle -- with ONE difference, which is the whole subject: the
// `--processor` path names a REAL BUNDLE ON DISK and `importModule` is
// deliberately NOT injected, because the bytes are what is under test.
//
// ## And a path that names no bundle is REFUSED, because nothing else can name it
//
// The author-declared identity an unbundled entry point used to fall back on is
// gone (`the-declared-version-and-the-drift-report-are-deleted`), so such a
// configuration has no name for its fold. It is refused at CONFIGURATION
// RESOLUTION, with the build command in it (`refuseUnbundledProcessor`,
// `src/config.ts`, asserted in `configuration.test.ts`); what is asserted here is
// the end-to-end consequence a deployment cares about -- that the refusal lands
// before the module is EVALUATED and before this database is so much as migrated.
//
// ## What "a BUNDLE" means here, which is one definition and not a new one
//
// A bundle is a module that expects nobody else to resolve anything:
// `unresolvedImportsOf` (`@etherfold/utils`) is the repo's only definition of
// self-contained, and it is the same judgement the artifact unit refuses on and
// the one `a-path-naming-an-unbundled-entry-point-is-refused` will refuse on.
// Reusing it is deliberate: a second heuristic for "is this a bundle" would be
// two answers to one question, and they would disagree at exactly the moment a
// migration is half done.
// ---------------------------------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL('./fixtures/processor-bundle/', import.meta.url));
const BUNDLE = join(FIXTURES, 'nfts.bundle.js');
const EDITED_BUNDLE = join(FIXTURES, 'nfts-edited.bundle.js');

/** The identity those bytes carry, computed the one way it is ever computed. */
const IDENTITY_OF = (path: string): string => processorArtifactIdentity(readFileSync(path));

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
];
const TIP = START_BLOCK + 100;

/** Bounded fetch ranges, read from the environment the way every fetcher host reads them. */
const SMALL_RANGES = {MAX_BLOCKS_PER_FETCH: '20'};

const scratch: string[] = [];
let running: RunningIndexer | undefined;

afterEach(async () => {
	await running?.stop().catch(() => undefined);
	running = undefined;
	for (const dir of scratch.splice(0)) {
		await rm(dir, {recursive: true, force: true}).catch(() => undefined);
	}
	delete process.env.ADMIN_TOKEN;
});

async function aScratchDirectory(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-bundle-'));
	scratch.push(dir);
	return dir;
}

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

function optionsFor(processor: string): Options {
	return {processor, nodeUrl: 'http://localhost:0', store: 'sqlite', db: ':memory:'};
}

/**
 * Everything but the processor, exactly as the one-shot's own tests inject it.
 *
 * `importModule` is ABSENT on purpose: an injected importer governs the MODULE
 * arrival, and a test that supplied one here would be asserting about a double
 * rather than about bytes on a disk.
 */
function depsFor(chain: ReturnType<typeof fakeChain>, db: RemoteSQL): IndexingDependencies {
	return {
		provider: chain.provider,
		createDB: () => db,
		sleep: async () => {},
		env: SMALL_RANGES,
	};
}

/** Fold `LOGS` to the tip through whatever `--processor` names, and hand back the database. */
async function aDeploymentFolding(processor: string, db: RemoteSQL = oneDatabase()): Promise<RemoteSQL> {
	const chain = fakeChain().serve(LOGS, TIP);
	const prepared = await prepareIndexing('build', optionsFor(processor), depsFor(chain, db));
	const summary = await prepared.index();
	expect(summary.stoppedBecause).toBe('stopped');
	return db;
}

/** WHICH GENERATION ANSWERS READS here, read through the durable pointer (ADR-0053). */
async function registeredIdentityIn(db: RemoteSQL): Promise<string> {
	const canonical = await canonicalGenerationIn(db);
	if (canonical === undefined) throw new Error(`this database registered no generation at all`);
	return canonical.processor;
}

describe('a deployment configured with a BUNDLE', () => {
	it('reads it, hashes it, instantiates it and folds blocks through it', async () => {
		const db = await aDeploymentFolding(BUNDLE);

		// it FOLDED: the canonical generation's own tables carry what the handler wrote
		const store = await canonicalStoreIn(db, nftProcessor.entities);
		expect((await store.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value).toBe(LOGS.length);
		expect((await store.getCurrent<{owner: string}>('nft', {tokenID: '1'.padStart(78, '0')}))?.owner).toBe(
			BOB.toLowerCase(),
		);
	});

	it('registers a generation whose processor identity IS the bundle hash and nothing else', async () => {
		const db = await aDeploymentFolding(BUNDLE);
		expect(await registeredIdentityIn(db)).toBe(IDENTITY_OF(BUNDLE));
	});
});

describe('the identity follows the BYTES, with no author action either way', () => {
	it('gives two deployments handed byte-identical bundles the SAME generation', async () => {
		// the same bytes at a DIFFERENT path, which is what a second machine running
		// the same build has: an identity that moved with the directory would be the
		// thing ADR-0086 says must not happen (user story 3)
		const elsewhere = join(await aScratchDirectory(), 'shipped.js');
		await copyFile(BUNDLE, elsewhere);

		expect(await registeredIdentityIn(await aDeploymentFolding(BUNDLE))).toBe(
			await registeredIdentityIn(await aDeploymentFolding(elsewhere)),
		);
	});

	it('gives a deployment handed a bundle with ONE EDITED HANDLER a DIFFERENT generation', async () => {
		expect(await registeredIdentityIn(await aDeploymentFolding(EDITED_BUNDLE))).not.toBe(
			await registeredIdentityIn(await aDeploymentFolding(BUNDLE)),
		);
	});

	it('does so where NOTHING THE AUTHOR WROTE differs, which is the whole point', async () => {
		// the pair differ in one handler line and in nothing an author DECLARES -- the
		// entity declarations are identical, and there is no version field left to bump --
		// so this is the silent wrong-state condition ADR-0008 could only report, made
		// impossible
		const {createProcessor: base} = await import(
			`data:text/javascript;base64,${readFileSync(BUNDLE).toString('base64')}`
		);
		const {createProcessor: edited} = await import(
			`data:text/javascript;base64,${readFileSync(EDITED_BUNDLE).toString('base64')}`
		);
		expect(edited().entities).toEqual(base().entities);
	});
});

describe('a path that names no bundle is refused, because nothing can name its fold', () => {
	it('refuses a module that expects somebody else to resolve an import, BEFORE evaluating it', async () => {
		const dir = await aScratchDirectory();
		// the sibling THROWS the moment it is evaluated, which is how this case tells the
		// two refusals apart: a configuration refusal never imports the entry point at
		// all, and one made from inside a loader would hand the author this instead
		await writeFile(join(dir, 'entities.js'), `throw new Error('the entry point was EVALUATED');\n`);
		const entry = join(dir, 'processor.mjs');
		await writeFile(
			entry,
			`import {entities} from './entities.js';
export const contractsDataPerChain = ${JSON.stringify({
				'1': [{abi, address: CONTRACT, startBlock: START_BLOCK}],
			})};
export const createProcessor = () => ({entities, onTransfer() {}});
`,
		);

		const db = oneDatabase();
		const chain = fakeChain().serve([], TIP);
		const refused = prepareIndexing('build', optionsFor(entry), depsFor(chain, db));
		await expect(refused).rejects.toThrow(/names an ENTRY POINT rather than a bundle/);
		// ...and it is about the CONFIGURATION rather than about module syntax
		await expect(refused).rejects.not.toThrow(/EVALUATED/);
		// the refusal NAMES what the operator typed, which is the only thing they can
		// fix, and the command that fixes it
		await expect(refused).rejects.toThrow(entry);
		await expect(refused).rejects.toThrow(/esbuild .*--bundle --format=esm --minify/);
		// and NOTHING was registered -- the refusal lands so early that this database was
		// never even migrated, which is why there is no registry to read here at all
		await expect(canonicalGenerationIn(db)).rejects.toThrow(/_generations/);
	});

	it('refuses an INJECTED arrival that named itself nothing either', async () => {
		// `importModule` states what comes back for a path and
		// `IndexingDependencies.processorIdentity` states what that thing is CALLED; the
		// two are one seam, and half of it is a deployment with no name for its fold.
		const db = oneDatabase();
		const chain = fakeChain().serve(LOGS, TIP);
		await expect(
			prepareIndexing('build', optionsFor('./nfts.js'), {
				...depsFor(chain, db),
				importModule: async () => entityModule,
			}),
		).rejects.toThrow(/is not a self-contained bundle/);
	});
});

describe('a bundle that fails to instantiate', () => {
	it('leaves the deployment exactly as it was, with nothing partially registered', async () => {
		const db = await aDeploymentFolding(BUNDLE);
		const before = await registeredIdentityIn(db);

		// the NORMAL state between the two halves of one change: the source landed and
		// the build has not, so the artifact throws the moment it is evaluated
		const broken = join(await aScratchDirectory(), 'half-built.js');
		await writeFile(broken, `throw new Error('the bundle is not built yet');\n`);

		const chain = fakeChain().serve(LOGS, TIP);
		await expect(prepareIndexing('build', optionsFor(broken), depsFor(chain, db))).rejects.toThrow(
			/the bundle is not built yet/,
		);

		// NOTHING PARTIAL: the same generation still answers, and it is the only one
		expect(await registeredIdentityIn(db)).toBe(before);
	});

	it('names the path it read and the identity of the bytes it refused', async () => {
		const carriesNoProcessor = join(await aScratchDirectory(), 'not-a-processor.js');
		await writeFile(carriesNoProcessor, `export const version = '1.0.0';\n`);

		const chain = fakeChain().serve(LOGS, TIP);
		await expect(
			prepareIndexing('build', optionsFor(carriesNoProcessor), depsFor(chain, oneDatabase())),
		).rejects.toThrow(new RegExp(`${IDENTITY_OF(carriesNoProcessor)}`));
	});
});

// ---------------------------------------------------------------------------------------------------
// ...AND A REBUILT BUNDLE REACHES A RUNNING DEPLOYMENT, ON THE ROUTE THAT ALREADY EXISTS
// ---------------------------------------------------------------------------------------------------
// `POST /{indexer}/admin/reconfigure` RE-READS this process's own configuration,
// and for a bundle that means re-reading the BYTES at the path and re-hashing
// them. Asserted because it is the one place the two arrivals could have drifted
// apart: a re-read that resolved the identity a different way from the start-up
// would register a spurious successor on every call, which is the opposite of
// what the endpoint is for.
// ---------------------------------------------------------------------------------------------------

const ADMIN_TOKEN = 'the-operators-own-secret';
const INDEXER = 'nfts';

describe('a rebuilt bundle reaches a running deployment', () => {
	it('is unchanged while the bytes are, and registers the new hash once they move', async () => {
		process.env.ADMIN_TOKEN = ADMIN_TOKEN;
		// a copy, because the case REPLACES it the way a rebuild does
		const shipped = join(await aScratchDirectory(), 'processor.bundle.js');
		await copyFile(BUNDLE, shipped);

		const chain = fakeChain().serve(LOGS, TIP);
		running = await run(
			{...optionsFor(shipped), port: '0', indexer: INDEXER},
			{
				provider: chain.provider,
				createDB: () => oneDatabase(),
				sleep: async () => {
					await new Promise((resolve) => setTimeout(resolve, 1));
				},
				handleSignals: false,
				log: () => {},
				env: SMALL_RANGES,
			},
		);

		const reconfigure = async () => {
			const res = await fetch(`${running?.url}/${INDEXER}/admin/reconfigure`, {
				method: 'POST',
				headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
			});
			return (await res.json()) as {outcome?: string; message?: string; generation?: {processor: string}};
		};

		// THE SAME BYTES: the identity cannot have moved, and the answer says why in
		// the vocabulary of the arrival this deployment actually has
		const unchanged = await reconfigure();
		expect(unchanged.outcome).toBe('unchanged');
		expect(unchanged.generation?.processor).toBe(IDENTITY_OF(BUNDLE));
		expect(unchanged.message).toContain('BUNDLE');
		// ...and it does NOT tell an author who cannot declare one to bump a `version`
		expect(unchanged.message).not.toContain('DECLARED version hash');

		// THE REBUILD a watcher notices: one edited handler, same everything else
		await copyFile(EDITED_BUNDLE, shipped);

		const registered = await reconfigure();
		expect(registered.outcome).toBe('registered');
		expect(registered.generation?.processor).toBe(IDENTITY_OF(EDITED_BUNDLE));
	});
});
