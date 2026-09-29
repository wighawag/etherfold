/**
 * Measure the stratagems replay on `fake-indexeddb` over a bounded PREFIX of the
 * fixture's blocks, so the full replay's time can be extrapolated rather than run.
 *
 * Run from the repository root (one replay at a time, under a timeout):
 *
 *   timeout 900 packages/conformance-workload-stratagems/node_modules/.bin/tsx \
 *     docs/spikes/the-full-stratagems-replay-on-fake-indexeddb/measure.ts <mode> [options]
 *
 * Modes:
 *
 * - `replay`: the workload's own replay (`replayIntoStore`'s loop: one
 *   `runBlockHandlers`, one `applyBlock` per block) on the `indexeddb` backend
 *   the test uses, timing the handlers (the processor's READS through the store)
 *   and the `applyBlock` (the WRITE) separately for every block. It then reverts
 *   to the block in the middle of the prefix and times that, because the test's
 *   second case is a revert of half the stream. `--profile` adds a CPU profile
 *   whose self time is split by module: the shim (`fake-indexeddb`), the store
 *   (`@etherfold/state-store-indexeddb`), and the rest, plus the hottest functions.
 * - `writes`: the prefix's mutations are computed first on `MemoryStateStore`
 *   (untimed), then written into a fresh `indexeddb` store with NO handler reads,
 *   either one `applyBlock` per block (`--pack 1`, the default) or K blocks per
 *   IndexedDB transaction (`--pack K`) through `packedApply` below, a spike-only
 *   copy of `applyBlock`'s body looped over several blocks in one transaction.
 *   That is what an `applyBlocks` verb on this backend would buy, measured before
 *   anyone adds one.
 * - `model --from FILE`: fits the cost model (see the README) on the per-block
 *   samples a `replay` run wrote, replays the WHOLE stream on `MemoryStateStore`
 *   (seconds) to get every block's predictors, and extrapolates the full replay
 *   and the test's revert on `indexeddb`.
 *
 * Options: `--blocks N` (prefix length, default 300), `--window W` (blocks per
 * reported window, default 50), `--backend NAME` (default `indexeddb`; `memory`
 * gives the processor-only baseline), `--out FILE` (write the JSON result there).
 */
import {Session} from 'node:inspector/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
	blockPointer,
	forkPoint,
	groupByBlock,
	openForWriting,
	runBlockHandlers,
	type WritableStateStore,
} from '../../../packages/conformance-workload-stratagems/node_modules/@etherfold/processor-entities/dist/index.js';
import {
	encodeFieldValues,
	idValues,
	mustGet,
	type Mutation,
} from '../../../packages/conformance-workload-stratagems/node_modules/@etherfold/state-store/dist/index.js';
import {ALPHA1, loadStream} from '../../../packages/conformance-workload-stratagems/src/fixtures.js';
import {stratagemsProcessor} from '../../../packages/conformance-workload-stratagems/src/processor.js';
import {BACKENDS} from '../../../packages/conformance-workload-stratagems/test/utils/backends.js';
import {committed, request} from '../../../packages/state-store-indexeddb/dist/idb.js';
import {BLOCKS, CURRENT, rowKey, SEAM, versionKey, VERSIONS, WRITER_KEY} from '../../../packages/state-store-indexeddb/dist/keys.js';

/** The test's revert target (`FORK_BLOCK` in `test/alpha1.test.ts`). */
const TEST_FORK_BLOCK = 13_364_821;

type Args = {mode: string; blocks: number; window: number; backend: string; pack: number; profile: boolean; out?: string; from?: string};

function parseArgs(argv: string[]): Args {
	const args: Args = {mode: argv[0] ?? 'replay', blocks: 300, window: 50, backend: 'indexeddb', pack: 1, profile: false};
	for (let i = 1; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[++i];
		if (flag === '--blocks') args.blocks = Number(value);
		else if (flag === '--window') args.window = Number(value);
		else if (flag === '--backend') args.backend = String(value);
		else if (flag === '--pack') args.pack = Number(value);
		else if (flag === '--out') args.out = String(value);
		else if (flag === '--from') args.from = String(value);
		else if (flag === '--profile') (args.profile = true), i--;
		else throw new Error(`unknown argument ${flag}`);
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
const stream = loadStream(ALPHA1).eventStream;
const allBlocks = groupByBlock(stream);
const prefix = allBlocks.slice(0, args.blocks);
const fork = forkPoint(stream);

/**
 * What one block asks of the store, in the terms the cost model uses.
 *
 * `closes` counts mutations of a key that already has a live version: that is
 * the `versions.put` which OVERWRITES an existing record, and in `fake-indexeddb`
 * an overwrite on an object store with indexes scans every record of every index
 * (`RecordStore.deleteByValue`). `versionsBefore` is how many records that scan
 * walks: every upsert adds one and a forward replay never removes any.
 */
type Predictors = {mutations: number; upserts: number; closes: number; versionsBefore: number};
type BlockSample = Predictors & {index: number; number: number; events: number; readMs: number; writeMs: number};

function keyOf(mutation: Mutation): string {
	return `${mutation.entity}:${Object.keys(mutation.id)
		.sort()
		.map((column) => `${column}=${String(mutation.id[column])}`)
		.join('|')}`;
}

/** Walks blocks in order, tracking live keys and the version count, and names each block's predictors. */
function predictorTracker(): (mutations: readonly Mutation[]) => Predictors {
	const live = new Set<string>();
	let versions = 0;
	return (mutations) => {
		const versionsBefore = versions;
		let closes = 0;
		let upserts = 0;
		for (const mutation of mutations) {
			const key = keyOf(mutation);
			if (live.has(key)) closes++;
			if (mutation.type === 'upsert') {
				upserts++;
				live.add(key);
			} else live.delete(key);
		}
		versions += upserts;
		return {mutations: mutations.length, upserts, closes, versionsBefore};
	};
}

async function freshStore(name: string): Promise<WritableStateStore> {
	const make = BACKENDS.find((candidate) => candidate.name === name)!.make;
	const store = await openForWriting(await make(stratagemsProcessor.entities));
	if (fork !== undefined) await store.revertTo(fork);
	return store;
}

const samples: BlockSample[] = [];
let revert: {toBlockIndex: number; seconds: number; versionsDeleted: number; versionsReopened: number; versionsBefore: number} | undefined;

/** The workload's replay loop, timed in two halves. Same pieces as `replayIntoStore`. */
async function replay(): Promise<void> {
	const store = await freshStore(args.backend);
	const track = predictorTracker();
	const history: Mutation[][] = [];
	for (const [index, block] of prefix.entries()) {
		const t0 = performance.now();
		const mutations = await runBlockHandlers(store, stratagemsProcessor, block.events, undefined);
		const t1 = performance.now();
		await store.applyBlock(blockPointer(block), mutations);
		const t2 = performance.now();
		history.push(mutations);
		samples.push({index, number: block.number, events: block.events.length, ...track(mutations), readMs: t1 - t0, writeMs: t2 - t1});
	}

	// the test's second case, scaled to the prefix: undo the top half
	const toBlockIndex = Math.floor(prefix.length / 2) - 1;
	const counts = revertCounts(history, toBlockIndex);
	const t = performance.now();
	await store.revertTo(prefix[toBlockIndex].number);
	revert = {toBlockIndex, seconds: +((performance.now() - t) / 1000).toFixed(1), ...counts};
}

/**
 * What `revertTo` touches: every version opened above the target is DELETED, and
 * every version closed above it (and opened at or below) is REOPENED by an
 * update. Both are writes to the indexed `versions` store, so both pay the scan.
 */
function revertCounts(history: readonly (readonly Mutation[])[], toBlockIndex: number) {
	const openedAt = new Map<string, number>();
	let versionsDeleted = 0;
	const reopened = new Set<string>();
	let versionsBefore = 0;
	history.forEach((mutations, index) => {
		for (const mutation of mutations) {
			const key = keyOf(mutation);
			const opened = openedAt.get(key);
			if (index > toBlockIndex && opened !== undefined && opened <= toBlockIndex) reopened.add(key);
			if (mutation.type === 'upsert') {
				openedAt.set(key, index);
				versionsBefore++;
				if (index > toBlockIndex) versionsDeleted++;
			} else openedAt.delete(key);
		}
	});
	return {versionsDeleted, versionsReopened: reopened.size, versionsBefore};
}

/**
 * `applyBlock`'s body, looped over several blocks inside ONE readwrite
 * transaction. Spike-only: it reaches the store's private `database()` and
 * `entities`, skips the height/hash refusals (the prefix is known to ascend), and
 * exists to answer one question: does packing change the SHAPE of the cost?
 */
async function packedApply(store: unknown, updates: readonly {block: ReturnType<typeof blockPointer>; mutations: readonly Mutation[]}[]): Promise<void> {
	const inner = store as {database(): Promise<IDBDatabase>; entities: ReadonlyMap<string, never>};
	const db = await inner.database();
	const tx = db.transaction([CURRENT, VERSIONS, BLOCKS, SEAM], 'readwrite');
	const current = tx.objectStore(CURRENT);
	const versions = tx.objectStore(VERSIONS);
	const blocks = tx.objectStore(BLOCKS);
	const settled = committed(tx);
	await request(tx.objectStore(SEAM).get(WRITER_KEY));
	for (const {block, mutations} of updates) {
		for (const mutation of mutations) {
			const entity = mustGet(inner.entities, mutation.entity) as never as Parameters<typeof rowKey>[0];
			const id = idValues(entity, mutation.id);
			const key = rowKey(entity, mutation.id);
			const previous = (await request(current.get(key))) as {lower: number; values: unknown} | undefined;
			if (previous) versions.put({lower: previous.lower, upper: block.number, values: previous.values}, versionKey(key, previous.lower));
			if (mutation.type === 'upsert') {
				const stored = encodeFieldValues(entity, mutation.values);
				const values: Record<string, unknown> = {};
				entity.id.forEach((column, i) => (values[column] = id[i]));
				for (const field of Object.keys(entity.fields)) values[field] = stored?.[field] ?? null;
				current.put({lower: block.number, values}, key);
				versions.put({lower: block.number, upper: null, values}, versionKey(key, block.number));
			} else if (previous) {
				current.delete(key);
			}
		}
		blocks.put({number: block.number, hash: block.hash.toLowerCase(), timestamp: block.timestamp});
	}
	await settled;
}

/** The processor's mutations for some blocks, computed on the memory store (seconds for the whole stream). */
async function plannedMutations(blocks: typeof allBlocks) {
	const memory = await freshStore('memory');
	const planned: {block: ReturnType<typeof blockPointer>; events: number; mutations: readonly Mutation[]}[] = [];
	for (const block of blocks) {
		const mutations = await runBlockHandlers(memory, stratagemsProcessor, block.events, undefined);
		await memory.applyBlock(blockPointer(block), mutations);
		planned.push({block: blockPointer(block), events: block.events.length, mutations});
	}
	return {memory, planned};
}

async function writes(): Promise<void> {
	const {memory, planned} = await plannedMutations(prefix);
	const track = predictorTracker();
	const store = await freshStore(args.backend);
	// one ordinary applyBlock first, so the writer claim is committed before packing
	for (let start = 0; start < planned.length; start += start === 0 ? 1 : args.pack) {
		const group = planned.slice(start, start === 0 ? 1 : start + args.pack);
		const t = performance.now();
		if (group.length === 1) await store.applyBlock(group[0].block, group[0].mutations);
		else await packedApply((store as unknown as {inner: unknown}).inner, group);
		const perBlock = (performance.now() - t) / group.length;
		for (const [offset, update] of group.entries()) {
			const index = start + offset;
			samples.push({index, number: update.block.number, events: update.events, ...track(update.mutations), readMs: 0, writeMs: perBlock});
		}
	}
	// the packed path must land on the same current state as the memory store did
	const probe = planned.flatMap((update) => update.mutations);
	const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
	for (const mutation of probe) {
		const a = json(await store.getCurrent(mutation.entity, mutation.id));
		const b = json(await memory.getCurrent(mutation.entity, mutation.id));
		if (a !== b) throw new Error(`the write path diverged on ${mutation.entity} ${json(mutation.id)}: ${a} vs ${b}`);
	}
}

/**
 * Least squares for `writeMs ~ a * mutations + b * closes * versionsBefore`:
 * a constant per mutation for the store and the shim's ordinary bookkeeping, and
 * the scan term the profile names. No intercept: a block with no mutations costs
 * one small transaction, which is noise at this scale.
 */
function fit(points: readonly BlockSample[]): {a: number; b: number} {
	let s11 = 0, s12 = 0, s22 = 0, y1 = 0, y2 = 0;
	for (const p of points) {
		const x1 = p.mutations;
		const x2 = p.closes * p.versionsBefore;
		s11 += x1 * x1;
		s12 += x1 * x2;
		s22 += x2 * x2;
		y1 += x1 * p.writeMs;
		y2 += x2 * p.writeMs;
	}
	const det = s11 * s22 - s12 * s12;
	return {a: (y1 * s22 - y2 * s12) / det, b: (s11 * y2 - s12 * y1) / det};
}

type ReplayResult = {samples: [number, number, number, number, number, number][]; revert: NonNullable<typeof revert>; readSeconds: number};

async function model(): Promise<Record<string, unknown>> {
	if (!args.from) throw new Error('model needs --from <a replay result>');
	const measured = JSON.parse(fs.readFileSync(args.from, 'utf-8')) as ReplayResult;
	const points = measured.samples.map(([mutations, upserts, closes, versionsBefore, writeMs]) => ({mutations, upserts, closes, versionsBefore, writeMs}) as BlockSample);
	const {a, b} = fit(points);

	// how well the model reproduces the prefix it was fitted on, per window
	const measuredWrite = points.reduce((acc, p) => acc + p.writeMs, 0) / 1000;
	const modelledWrite = points.reduce((acc, p) => acc + a * p.mutations + b * p.closes * p.versionsBefore, 0) / 1000;

	const {planned} = await plannedMutations(allBlocks);
	const track = predictorTracker();
	const full = planned.map((update) => track(update.mutations));
	const predictedWriteSeconds = full.reduce((acc, p) => acc + a * p.mutations + b * p.closes * p.versionsBefore, 0) / 1000;
	// reads grew with the prefix too, but stayed a few percent of the writes; scale them by events
	const readSecondsPerEvent = measured.readSeconds / points.reduce((acc, p) => acc + p.mutations, 0);
	const predictedReadSeconds = readSecondsPerEvent * full.reduce((acc, p) => acc + p.mutations, 0);

	// the revert: every deleted and every reopened version is a write to the indexed store,
	// so each pays one scan of what is stored at that moment. Calibrated on the prefix's revert.
	const r = measured.revert;
	const revertUnitsPrefix = (r.versionsDeleted + r.versionsReopened) * (r.versionsBefore - r.versionsDeleted / 2);
	const revertMsPerUnit = (r.seconds * 1000) / revertUnitsPrefix;
	const forkIndex = allBlocks.findIndex((block) => block.number === TEST_FORK_BLOCK);
	const fullRevert = revertCounts(
		planned.map((update) => update.mutations),
		forkIndex,
	);
	const predictedRevertSeconds =
		(revertMsPerUnit * (fullRevert.versionsDeleted + fullRevert.versionsReopened) * (fullRevert.versionsBefore - fullRevert.versionsDeleted / 2)) / 1000;

	return {
		fittedOn: `${points.length} blocks from ${args.from}`,
		msPerMutation: +a.toFixed(4),
		msPerCloseTimesStoredVersion: +b.toExponential(3),
		prefixWriteSecondsMeasured: +measuredWrite.toFixed(1),
		prefixWriteSecondsModelled: +modelledWrite.toFixed(1),
		fullStream: {
			blocks: full.length,
			mutations: full.reduce((acc, p) => acc + p.mutations, 0),
			closes: full.reduce((acc, p) => acc + p.closes, 0),
			versionsAtTip: full.at(-1)!.versionsBefore + full.at(-1)!.upserts,
		},
		predictedReplaySeconds: +(predictedWriteSeconds + predictedReadSeconds).toFixed(0),
		predictedWriteSeconds: +predictedWriteSeconds.toFixed(0),
		predictedReadSeconds: +predictedReadSeconds.toFixed(0),
		revertCalibration: {...r, msPerUnit: +revertMsPerUnit.toExponential(3)},
		fullRevert: {forkIndex, ...fullRevert},
		predictedRevertSeconds: +predictedRevertSeconds.toFixed(0),
	};
}

type ProfileNode = {id: number; callFrame: {url: string; functionName: string; lineNumber: number}};
/** The hottest functions by self time, so the README can name where the cost sits. */
const hottest = new Map<string, number>();
function attribute(profile: {nodes: ProfileNode[]; samples: number[]; timeDeltas: number[]}): Record<string, number> {
	const byId = new Map(profile.nodes.map((node) => [node.id, node]));
	const totals: Record<string, number> = {shim: 0, store: 0, processor: 0, other: 0};
	profile.samples.forEach((id, i) => {
		const frame = byId.get(id)?.callFrame;
		const url = frame?.url ?? '';
		const ms = (profile.timeDeltas[i] ?? 0) / 1000;
		const name = `${frame?.functionName || '(anonymous)'} ${url.replace(/.*node_modules\//, '')}:${(frame?.lineNumber ?? 0) + 1}`;
		hottest.set(name, (hottest.get(name) ?? 0) + ms);
		if (url.includes('fake-indexeddb')) totals.shim += ms;
		else if (url.includes('state-store-indexeddb')) totals.store += ms;
		else if (url.includes('processor') || url.includes('conformance-workload-stratagems') || url.includes('state-store/')) totals.processor += ms;
		else totals.other += ms;
	});
	return totals;
}

const machine = {cpu: os.cpus()[0]?.model, cores: os.cpus().length, node: process.version, platform: `${os.platform()} ${os.release()}`};
let result: Record<string, unknown>;

if (args.mode === 'model') {
	result = {mode: 'model', machine, ...(await model())};
} else {
	const session = new Session();
	if (args.profile) {
		session.connect();
		await session.post('Profiler.enable');
		await session.post('Profiler.start');
	}

	const started = performance.now();
	if (args.mode === 'replay') await replay();
	else if (args.mode === 'writes') await writes();
	else throw new Error(`unknown mode ${args.mode}`);
	const totalMs = performance.now() - started;

	let profileShare: Record<string, number> | undefined;
	if (args.profile) {
		const {profile} = await session.post('Profiler.stop');
		profileShare = attribute(profile as never);
	}

	const windows = [];
	for (let start = 0; start < samples.length; start += args.window) {
		const slice = samples.slice(start, start + args.window);
		const sum = (pick: (s: BlockSample) => number) => slice.reduce((acc, s) => acc + pick(s), 0);
		windows.push({
			blocks: `${start}-${start + slice.length - 1}`,
			events: sum((s) => s.events),
			mutations: sum((s) => s.mutations),
			closes: sum((s) => s.closes),
			versionsStoredAfter: slice.at(-1)!.versionsBefore + slice.at(-1)!.upserts,
			readMsPerBlock: +(sum((s) => s.readMs) / slice.length).toFixed(1),
			writeMsPerBlock: +(sum((s) => s.writeMs) / slice.length).toFixed(1),
			writeMsPerMutation: +(sum((s) => s.writeMs) / Math.max(1, sum((s) => s.mutations))).toFixed(2),
		});
	}

	result = {
		mode: args.mode,
		backend: args.backend,
		pack: args.pack,
		blocks: prefix.length,
		ofBlocks: allBlocks.length,
		events: samples.reduce((acc, s) => acc + s.events, 0),
		ofEvents: stream.length,
		totalSeconds: +(totalMs / 1000).toFixed(1),
		readSeconds: +(samples.reduce((acc, s) => acc + s.readMs, 0) / 1000).toFixed(1),
		writeSeconds: +(samples.reduce((acc, s) => acc + s.writeMs, 0) / 1000).toFixed(1),
		revert,
		profileShareMs: profileShare && Object.fromEntries(Object.entries(profileShare).map(([k, v]) => [k, Math.round(v)])),
		hottestSelfMs:
			profileShare &&
			Object.fromEntries(
				[...hottest.entries()]
					.sort((x, y) => y[1] - x[1])
					.slice(0, 8)
					.map(([k, v]) => [k, Math.round(v)]),
			),
		machine,
		windows,
		/** Per block: mutations, upserts, closes, versionsBefore, writeMs, readMs. */
		samples: samples.map((s) => [s.mutations, s.upserts, s.closes, s.versionsBefore, +s.writeMs.toFixed(2), +s.readMs.toFixed(2)]),
	};
}

const text = JSON.stringify(result, null, '\t');
console.log(text.replace(/\n\t"samples": \[[\s\S]*$/, '\n\t"samples": "(omitted here, in --out)"\n}'));
if (args.out) fs.writeFileSync(args.out, text + '\n');
process.exit(0);
