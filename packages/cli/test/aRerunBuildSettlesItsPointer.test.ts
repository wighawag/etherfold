import {createClient} from '@libsql/client';
import {declareEntities} from '@etherfold/state-store';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {generationDigestOf} from '@etherfold/core';
import {build, canonicalGenerationIn, heldGenerationsIn, prepareIndexing} from '../src/index.js';
import type {IndexingDependencies} from '../src/index.js';
import type {Options} from '../src/types.js';
import {ALICE, BOB, CONTRACT, fakeChain, START_BLOCK, transfer, ZERO} from './utils/chain.js';
import {canonicalStoreIn} from './utils/reads.js';

// ---------------------------------------------------------------------------------------------------
// A RE-RUN `build` EXITS WITH ITS POINTER ON THE GENERATION IT JUST FOLDED
// ---------------------------------------------------------------------------------------------------
// `build`'s docstring used to claim a one-shot "opens the container with one fold
// and exits, so it never adds a second and never promotes". The first half is
// FALSE and was measured so: re-run a `build` over a database it already wrote
// with CHANGED processor bytes and it is a different identity, so the container
// registers a SUCCESSOR beside the existing canonical generation, exactly as a
// restarted `run` does. The second half then bit -- `driveCycles` skipped its
// whole rebuild-and-settle block under `stopAtTip` -- so that build folded the
// successor to the tip and exited with the pointer still naming the OLD
// generation. The artifact it published served the old fold, with a fully
// caught-up newer one sitting in the database beside it.
//
// The SEAM is deliberately the whole command, and the same one
// `aRestartFinishesTheUpgrade.test.ts` uses for `run`: a deployment stood up over
// a REAL libSQL handle, exited, and re-run over the SAME handle with an EDITED
// bundle. That is a redeploy in every way that matters -- a fresh container with
// an empty memory over the same rows -- and the end of it is read back through
// the CANONICAL POINTER after the process has exited, because "the artifact
// serves the fold it just built" is a claim about the artifact rather than about
// the container that wrote it.
//
// What `build` promises here is deliberately less than what `run` does, and the
// difference is the whole reason the settle is ONE call rather than a loop: it
// advances every follower it holds by one bounded chunk and settles ONCE. A
// settle that WAITED for a successor to catch up would make the one-shot
// unbounded, which is the one thing a command whose exit is the point may never
// be.
// ---------------------------------------------------------------------------------------------------

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
];
const TIP = START_BLOCK + 50;

/** The single entity the bundles below declare, as a reader of the artifact has to name it. */
const NFT = declareEntities([{name: 'nft', id: ['tokenID'], fields: {owner: 'text'}}]);

/** The token both handlers write, padded exactly as they pad it. */
const TOKEN = {tokenID: '1'.padStart(78, '0')};

/**
 * THE BUNDLE A DEPLOYMENT SHIPS, as text: an upgrade is an EDIT to these bytes.
 *
 * Self-contained, so the arrival hashes the octets and the generation is named by
 * them (ADR-0086) -- which is what makes "the developer changed a handler and
 * re-ran the build" a different generation with no author action. The two arms
 * credit DIFFERENT addresses, so which fold answered is readable off one row
 * rather than inferred from a digest.
 */
function processorBundleSource(options: {credit: 'to' | 'from'}): string {
	return `const abi = [
	{
		anonymous: false,
		inputs: [
			{indexed: true, internalType: 'address', name: 'from', type: 'address'},
			{indexed: true, internalType: 'address', name: 'to', type: 'address'},
			{indexed: true, internalType: 'uint256', name: 'id', type: 'uint256'},
		],
		name: 'Transfer',
		type: 'event',
	},
];

export const contractsDataPerChain = {
	'1': [
		{
			abi,
			address: '${CONTRACT}',
			startBlock: ${START_BLOCK},
		},
	],
};

export function createProcessor() {
	return {
		entities: [{name: 'nft', id: ['tokenID'], fields: {owner: 'text'}}],
		async onTransfer(state, event) {
			const tokenID = event.args.id.toString().padStart(78, '0');
			state.set('nft', {tokenID}, {owner: event.args.${options.credit}.toLowerCase()});
		},
	};
}
`;
}

/** The scratch directories these cases write processor bundles into, outside the repository. */
const scratch: string[] = [];

afterEach(async () => {
	for (const dir of scratch.splice(0)) {
		await rm(dir, {recursive: true, force: true}).catch(() => undefined);
	}
});

/** ONE path a deployment is pointed at, whose BYTES the cases below rewrite. */
async function aProcessorBundleOnDisk(source: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-rerun-build-'));
	scratch.push(dir);
	const path = join(dir, 'processor.bundle.js');
	await writeFile(path, source, 'utf-8');
	return path;
}

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

function optionsFor(processor: string): Options {
	return {processor, nodeUrl: 'http://localhost:0', store: 'sqlite', db: ':memory:'};
}

function depsFor(db: RemoteSQL, extra: IndexingDependencies = {}): IndexingDependencies {
	return {
		provider: fakeChain().serve(LOGS, TIP).provider,
		createDB: () => db,
		sleep: async () => {},
		env: {MAX_BLOCKS_PER_FETCH: '20'},
		...extra,
	};
}

/** WHICH generation answers reads in this artifact, as a reader of it resolves that. */
async function canonicalDigestOf(db: RemoteSQL): Promise<string | undefined> {
	const canonical = await canonicalGenerationIn(db);
	return canonical && `${canonical.stream}/${canonical.processor}`;
}

/** Every generation the artifact carries, so a retained one is told apart from a missing one. */
async function registeredIn(db: RemoteSQL): Promise<string[]> {
	const held = await heldGenerationsIn(db);
	return (held[0]?.generations ?? []).map((record) => `${record.stream}/${record.processor}`).sort();
}

/** WHAT THE ARTIFACT ANSWERS, resolved through the canonical pointer the way `serve` resolves it. */
async function ownerIn(db: RemoteSQL): Promise<string | undefined> {
	const store = await canonicalStoreIn(db, NFT);
	return (await store.getCurrent<{owner: string}>('nft', TOKEN))?.owner;
}

// ---------------------------------------------------------------------------------------------------

describe('a re-run `build` with CHANGED processor bytes', () => {
	it('exits with the canonical pointer on the generation it just folded', async () => {
		const db = oneDatabase();
		const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
		await build(optionsFor(path), depsFor(db));
		const incumbent = (await canonicalDigestOf(db)) as string;
		expect(incumbent).toBeDefined();

		// THE REDEPLOY: one edited handler at the same path, so the bytes moved and the
		// identity with them, with no author action (ADR-0086)
		await writeFile(path, processorBundleSource({credit: 'from'}), 'utf-8');
		const summary = await build(optionsFor(path), depsFor(db));

		// it still STOPPED, which is the property the settle must not cost: a settle
		// that waited for anything would have turned the one-shot into a loop
		expect(summary.stoppedBecause).toBe('stopped');

		const settled = await canonicalDigestOf(db);
		expect(settled).not.toBe(incumbent);
		// ...and the generation it superseded is RETAINED, exactly as a `run`'s
		// promotion retains it: the way back is a pointer move and never a re-index
		expect(await registeredIn(db)).toEqual([incumbent, settled as string].sort());
	});

	it('emits an artifact that SERVES the fold it just built, read back after the process exited', async () => {
		const db = oneDatabase();
		const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
		await build(optionsFor(path), depsFor(db));

		// the first build credited the RECEIVER of the last transfer
		expect(await ownerIn(db)).toBe(BOB.toLowerCase());

		await writeFile(path, processorBundleSource({credit: 'from'}), 'utf-8');
		await build(optionsFor(path), depsFor(db));

		// ...and the re-run credits the SENDER. Read through the canonical pointer,
		// which is the whole claim: before the settle this database held a fully
		// caught-up newer fold beside the pointer and served the OLD one anyway.
		expect(await ownerIn(db)).toBe(ALICE.toLowerCase());
	});
});

describe('a re-run `build` with UNCHANGED bytes', () => {
	it('resolves the same generation rather than registering another, and leaves the pointer alone', async () => {
		const db = oneDatabase();
		const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
		await build(optionsFor(path), depsFor(db));
		const first = await canonicalDigestOf(db);
		const registered = await registeredIn(db);

		await build(optionsFor(path), depsFor(db));

		// the half of the old docstring that WAS true, kept true: the registry's own
		// resolve-rather-than-duplicate rule, and a settle with nothing to settle
		expect(await registeredIn(db)).toEqual(registered);
		expect(await canonicalDigestOf(db)).toBe(first);
	});
});

describe('a `build` STOPPED from outside', () => {
	it('skips the settle, exactly as it skips the retention pass an exit was the argument for', async () => {
		const db = oneDatabase();
		const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
		await build(optionsFor(path), depsFor(db));
		const incumbent = (await canonicalDigestOf(db)) as string;

		await writeFile(path, processorBundleSource({credit: 'from'}), 'utf-8');
		// the kill lands on the very report that would otherwise have ended the run at
		// the tip, so the successor IS level and the settle would move the pointer.
		// What stops it is the guard and nothing else.
		const killer = new AbortController();
		const stopped = await prepareIndexing(
			'build',
			optionsFor(path),
			depsFor(db, {
				signal: killer.signal,
				onReport: (report) => {
					if (report.kind === 'progress' && report.caughtUp) killer.abort();
				},
			}),
		);
		await stopped.index();

		const successor = stopped.container.held()[0].record;
		// RE-SCOPED. This used to assert the successor was LEVEL, on the premise that a
		// re-run `build` folds its successor through the WIRE: the kill landed on the
		// caught-up report, so the fold was finished and only the settle was left. Under
		// ADR-0087 no generation fetches -- the deployment appends to the stream and each
		// generation re-folds it -- so what the EXIT work drives is the catch-up itself,
		// and a build stopped from outside skips ALL of it. The successor is registered
		// and has got wherever it got, which is the honest state of an interrupted run.
		expect(await stopped.container.generations()).toContainEqual(successor);
		// ...and the pointer stayed where the previous build left it, which is the claim
		// this case exists for: a caller asking a process to stop is not asking it to
		// publish a generation first.
		expect(await canonicalDigestOf(db)).toBe(incumbent);
		expect(generationDigestOf(successor)).not.toBe(incumbent);
	});
});
