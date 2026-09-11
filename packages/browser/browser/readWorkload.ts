import {
	declareEntities,
	openForWriting,
	type ReadSurface,
	type StateStore,
	type WritableStateStore,
} from '@etherfold/state-store';
import type {EntityProcessor} from '@etherfold/processor-entities';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {createBrowserStateStore, type BrowserStateStoreConfig} from '../src/index.js';
import {
	BRANCH_A,
	BRANCH_A_TIP,
	FINALITY,
	SOURCE,
	indexerForProcessor,
	indexToTip,
	type RawLog,
	type TestABI,
} from './workload.js';

/**
 * THE SUBJECT THE READ-SURFACE CASES ARE ASKED OF, and the cases themselves.
 *
 * It lives beside `workload.ts` and for the same reason: the browser specs
 * BUNDLE this module into a real page while the node tests import the very same
 * object, so an equality between a tab reading across a port and a tab reading a
 * store on its own thread is only worth something if neither side got its own
 * copy of the processor, of the chain, or of the questions.
 *
 * ## Why a second processor rather than `workload.ts`'s
 *
 * That one declares `token` and `counter`, both keyed on ONE column, and the
 * seam's listing takes a PREFIX -- a leading run of the declared id columns -- so
 * a single-column id has exactly one prefix (the whole id) and a listing over it
 * can never return two rows, never truncate, and never exercise the read this
 * surface exists to offer (ADR-0021). `transfer` below is keyed on
 * `(blockNumber, logIndex)`, which is what makes `listCurrent({blockNumber}, n)`
 * a real question with a real answer.
 *
 * It folds the SAME captured logs (`BRANCH_A`), so "the same workload" is the
 * same bytes rather than a second fixture that happens to look similar.
 */

/**
 * The declarations, NOT annotated, which is the whole mechanism: an annotation
 * (`const E: EntityDeclaration[] = ...`) widens `'owner'` to `string` and
 * nothing can be derived from it afterwards. `declareEntities` pins the literals
 * while leaving the value the ordinary array the store and the processor take.
 */
export const readEntities = declareEntities([
	// `memo` is declared and NEVER written, which is how "an unlisted declared
	// field reads as `null`" is asked of both surfaces: a version is a WHOLE row.
	{name: 'token', id: 'id', fields: {owner: 'text', transferCount: 'integer', memo: 'text'}},
	{name: 'transfer', id: ['blockNumber', 'logIndex'], fields: {token: 'text', to: 'text'}},
]);

/** The read surface of those declarations, however it is obtained. */
export type ReadFixtureSurface = ReadSurface<StateStore, typeof readEntities>;

/**
 * The processor that produces them: one row per token and one row per log.
 *
 * `transfer` is keyed on the coordinates the log already has, so the rows a
 * listing walks are in a known order and a prefix (`{blockNumber}`) selects the
 * logs of one block.
 */
export const readProcessor: EntityProcessor<TestABI> = {
	version: '1.0.0',
	entities: readEntities,
	async onTransfer(state, event) {
		const id = event.args.id.toString();
		const held = await state.get<{transferCount: number}>('token', {id});
		state.set('token', {id}, {owner: event.args.to, transferCount: (held?.transferCount ?? 0) + 1});
		state.set('transfer', {blockNumber: event.blockNumber, logIndex: event.logIndex}, {token: id, to: event.args.to});
	},
};

/** A store declaring the fixture's entities, CLAIMED, as every folding path needs one. */
export async function readWritableStore(config: BrowserStateStoreConfig = {}): Promise<WritableStateStore> {
	return openForWriting(await createBrowserStateStore(readEntities, config));
}

/** What a fixture node is, as a caller names one. */
export type FixtureChain = {readonly provider: EIP1193ProviderWithoutEvents};

/**
 * A node that serves `BRANCH_A` and can be HELD at a block.
 *
 * The gate is what makes "an app is usable WHILE it is still indexing" a fact
 * rather than a race: a test releases the chain when it is ready and reads in
 * between, instead of hoping a read lands inside a window that closes in
 * milliseconds.
 *
 * `holdAbove` caps what the node will admit to knowing: `eth_blockNumber`
 * answers the cap, and `eth_getLogs` serves only the logs at or below it. So the
 * fold stops there with a cursor of its own, exactly as it does at a real tip,
 * and nothing about the engine has to be paused.
 */
export function heldChain(holdAbove: number): FixtureChain & {
	readonly ranges: {from: number; to: number}[];
	release(newTip?: number): void;
} {
	let tip = holdAbove;
	const ranges: {from: number; to: number}[] = [];
	return {
		ranges,
		/** Let the chain grow: the fold advances on its next cycle. */
		release(newTip: number = BRANCH_A_TIP) {
			tip = newTip;
		},
		provider: {
			async request(args: {method: string; params?: any}): Promise<any> {
				switch (args.method) {
					case 'eth_chainId':
						return `0x${Number(SOURCE.chainId).toString(16)}`;
					case 'eth_blockNumber':
						return `0x${tip.toString(16)}`;
					case 'eth_getLogs': {
						const from = parseInt(args.params[0].fromBlock.slice(2), 16);
						const to = parseInt(args.params[0].toBlock.slice(2), 16);
						ranges.push({from, to});
						return BRANCH_A.filter((log: RawLog) => {
							const blockNumber = parseInt(log.blockNumber.slice(2), 16);
							return blockNumber >= from && blockNumber <= to && blockNumber <= tip;
						});
					}
				}
				throw new Error(`unexpected method ${args.method}`);
			},
		} as any,
	};
}

/**
 * Fold the fixture into `store` on THIS thread, through the hook an application
 * uses.
 *
 * The same-thread half of the comparison: a store written by the main-thread
 * path, read by `createReadSurface`, asked the same questions as a store written
 * in a host and read across a port.
 */
export async function foldOnThisThread(store: WritableStateStore, chain: FixtureChain): Promise<void> {
	const indexer = indexerForProcessor(store, readProcessor);
	await indexer.init({
		provider: chain.provider,
		source: SOURCE,
		config: {stream: {finality: FINALITY}},
	});
	await indexToTip(indexer);
	indexer.dispose();
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

/**
 * ONE case: a group, a name, and a function that THROWS if the surface is
 * wrong.
 *
 * Cases as DATA, which is `@etherfold/state-store-conformance`'s shape and is
 * here for the same reason: one list, several implementations, and the vitest
 * registration as a thin adapter, so a failure is reported as the behaviour that
 * broke rather than as one opaque red suite -- and so the same list can be RUN in
 * a browser page, where there is no test runner at all.
 *
 * The assertions are hand-written rather than vitest's `expect` for exactly that
 * reason: this module is bundled into a page by the Playwright harness, and a
 * matcher library is not.
 *
 * A case is handed the surface instead of a factory, which is the one departure
 * from that package's shape and is a consequence of these cases being READS: a
 * read cannot poison the next case, so one fold serves the whole list. Building
 * a store per case there is what keeps a MUTATING case honest.
 */
export type ReadSurfaceCase = {
	readonly group: string;
	readonly name: string;
	run(surface: ReadFixtureSurface): Promise<void>;
};

/** A case that did not hold, with what it said. */
export type ReadSurfaceFailure = {readonly group: string; readonly name: string; readonly error: string};

/** What a whole run came to. `failures` empty is what "the same surface" means. */
export type ReadSurfaceRun = {readonly passed: number; readonly failures: readonly ReadSurfaceFailure[]};

function equals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((element, index) => equals(element, b[index]));
	}
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) {
		if (!equals(left[key], right[key])) return false;
	}
	return true;
}

function show(value: unknown): string {
	return JSON.stringify(value ?? null);
}

function same(what: string, actual: unknown, expected: unknown): void {
	if (!equals(actual, expected)) {
		throw new Error(`${what}: expected ${show(expected)}, got ${show(actual)}`);
	}
}

/**
 * The REFUSAL, by NAME.
 *
 * An error's class does not cross a `postMessage`: structured clone drops the
 * prototype, so what a port can carry is the `name` the class pins as a readonly
 * field, rebuilt on the other side (`errorFromPort`). So the name is what a case
 * asked of BOTH surfaces can assert on -- and what an app acts on across the
 * boundary, which is why the port carries it at all.
 */
async function refuses(what: string, call: Promise<unknown>, name: string, says?: RegExp): Promise<void> {
	const outcome = await call.then(
		(value) => ({answered: value}),
		(error: unknown) => ({error}),
	);
	if (!('error' in outcome)) {
		throw new Error(`${what}: expected a refusal (${name}), and it ANSWERED with ${show(outcome.answered)}`);
	}
	const error = outcome.error as {name?: string; message?: string};
	if (error?.name !== name) {
		throw new Error(`${what}: expected a ${name}, got ${error?.name}: ${error?.message}`);
	}
	if (says && !says.test(error.message ?? '')) {
		throw new Error(`${what}: a ${name} was raised, but it does not say ${says}: ${error.message}`);
	}
}

/**
 * THE FOUR READS, ASKED OF WHATEVER ANSWERS THEM.
 *
 * Every case here is written against `BRANCH_A` folded by `readProcessor`:
 * blocks 100 (`id 1` to Alice, `id 2` to Bob), 102 (`id 1` to Bob) and 104
 * (`id 3` to Dan, `id 2` to Erin).
 */
export const readSurfaceCases: readonly ReadSurfaceCase[] = [
	{
		group: 'current by id',
		name: 'reads one entity at the tip, naming no table and no column',
		async run(surface) {
			same('token 1 at the tip', await surface.token.getCurrent({id: '1'}), {
				id: '1',
				owner: '0x0000000000000000000000000000000000000022',
				transferCount: 2,
				memo: null,
			});
		},
	},
	{
		group: 'current by id',
		name: 'answers `undefined` for an entity the fold never wrote',
		async run(surface) {
			same('token 9', await surface.token.getCurrent({id: '9'}), undefined);
		},
	},
	{
		group: 'current by id',
		name: 'hands back the DECLARED columns and nothing else, so the row type is true',
		async run(surface) {
			// the version columns are STORAGE: a row carrying `_lower` and `_upper`
			// is a row the declaration does not describe, and one a caller can spread
			// straight back into a write.
			const row = (await surface.token.getCurrent({id: '1'}))!;
			same('the columns of token 1', Object.keys(row).sort(), ['id', 'memo', 'owner', 'transferCount']);
		},
	},
	{
		group: 'current by id',
		name: 'reads an unlisted declared field as null, exactly as the store wrote it',
		async run(surface) {
			// `set` writes a WHOLE row and no handler ever mentions `memo`, so it is
			// NULL rather than missing -- which is what the store holds, and therefore
			// what both surfaces must say.
			const row = (await surface.token.getCurrent({id: '2'}))!;
			same('the memo of token 2', row.memo, null);
		},
	},
	{
		group: 'as-of by id',
		name: 'reads the same entity as of an earlier block',
		async run(surface) {
			same('token 1 as of 100', await surface.token.getAsOf({id: '1'}, 100), {
				id: '1',
				owner: '0x0000000000000000000000000000000000000011',
				transferCount: 1,
				memo: null,
			});
		},
	},
	{
		group: 'as-of by id',
		name: 'answers `undefined` where the block is known and the entity was absent from it',
		async run(surface) {
			// token 3 is written at block 104. `undefined` is the ORDINARY answer
			// here, and it is the one thing a read that could not be served must
			// never give (ADR-0015).
			same('token 3 as of 100', await surface.token.getAsOf({id: '3'}, 100), undefined);
			same(
				'token 3 at the tip',
				(await surface.token.getCurrent({id: '3'}))?.owner,
				'0x0000000000000000000000000000000000000044',
			);
		},
	},
	{
		group: 'as-of by id',
		name: 'REFUSES an `at` that is not a block number rather than reporting an absence',
		async run(surface) {
			// A hash compared against block numbers matches no version, so answering
			// would report the token as absent at a block nobody named. The cast is
			// what a JavaScript caller (or a cast) walks into; the TYPE refuses it
			// first, which `pnpm typecheck` is what runs.
			await refuses(
				'token 1 as of a hash',
				surface.token.getAsOf({id: '1'}, {hash: '0x64'} as never),
				'InvalidBlockNumberError',
			);
		},
	},
	{
		group: 'current listing by prefix',
		name: 'lists the rows of a prefix, ascending, and says whether it stopped short',
		async run(surface) {
			same('the logs of block 100', await surface.transfer.listCurrent({blockNumber: 100}, 10), {
				rows: [
					{
						blockNumber: '100',
						logIndex: '0',
						token: '1',
						to: '0x0000000000000000000000000000000000000011',
					},
					{
						blockNumber: '100',
						logIndex: '1',
						token: '2',
						to: '0x0000000000000000000000000000000000000022',
					},
				],
				truncated: false,
			});
			same('the same listing, bounded at one', await surface.transfer.listCurrent({blockNumber: 100}, 1), {
				rows: [
					{
						blockNumber: '100',
						logIndex: '0',
						token: '1',
						to: '0x0000000000000000000000000000000000000011',
					},
				],
				truncated: true,
			});
		},
	},
	{
		group: 'current listing by prefix',
		name: 'answers an empty listing for a prefix with no rows, which is not a refusal',
		async run(surface) {
			same('the logs of block 101', await surface.transfer.listCurrent({blockNumber: 101}, 10), {
				rows: [],
				truncated: false,
			});
		},
	},
	{
		group: 'current listing by prefix',
		name: 'REFUSES a prefix that is not a leading run of the declared id',
		async run(surface) {
			await refuses(
				'a listing keyed on the second id column alone',
				surface.transfer.listCurrent({logIndex: 0} as never, 10),
				'Error',
				/transfer/,
			);
		},
	},
	{
		group: 'as-of listing by prefix',
		name: 'lists a prefix as of an earlier block',
		async run(surface) {
			same(
				'the logs of block 100, as of 100',
				(await surface.transfer.listAsOf({blockNumber: 100}, 100, 10)).rows.length,
				2,
			);
			// block 104's rows did not exist yet at 102: the block is known and the
			// prefix had no children then, which is an EMPTY listing and not an error.
			same('the logs of block 104, as of 102', await surface.transfer.listAsOf({blockNumber: 104}, 102, 10), {
				rows: [],
				truncated: false,
			});
			same(
				'the logs of block 104, at the tip',
				(await surface.transfer.listAsOf({blockNumber: 104}, 105, 10)).rows.length,
				2,
			);
		},
	},
	{
		group: 'as-of listing by prefix',
		name: 'bounds the historical listing too, and says whether it stopped short',
		async run(surface) {
			same(
				'the logs of block 100 as of 104, bounded at one',
				await surface.transfer.listAsOf({blockNumber: 100}, 104, 1),
				{
					rows: [
						{
							blockNumber: '100',
							logIndex: '0',
							token: '1',
							to: '0x0000000000000000000000000000000000000011',
						},
					],
					truncated: true,
				},
			);
		},
	},
];

/**
 * Run every case against one surface and REPORT, rather than throwing at the
 * first failure.
 *
 * The shape the conformance suite's own runner has, and for the same reason: a
 * caller that is not a test runner (a browser page) needs the whole verdict
 * carried back in one value, and "which cases failed" is the interesting part.
 */
export async function runReadSurfaceCases(surface: ReadFixtureSurface): Promise<ReadSurfaceRun> {
	const failures: ReadSurfaceFailure[] = [];
	let passed = 0;
	for (const one of readSurfaceCases) {
		try {
			await one.run(surface);
			passed++;
		} catch (error) {
			failures.push({group: one.group, name: one.name, error: `${(error as Error)?.message ?? error}`});
		}
	}
	return {passed, failures};
}
