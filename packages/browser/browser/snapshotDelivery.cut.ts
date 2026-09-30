import type {CodeUnderTest, RunContext, RunResult, Timing} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {
	encodeSnapshot,
	openSnapshotAware,
	readSnapshot,
	SnapshotFormatError,
	type EntityDeclaration,
	type Mutation,
} from '@etherfold/state-store';
import {createBrowserStateStore} from '../src/index.js';

/**
 * A state snapshot body, served the two ways a host serves a `.gz`, installed in
 * a real engine into real IndexedDB.
 *
 * OPAQUE is the `.gz` bytes; ALREADY INFLATED is what a runtime hands a script
 * after it undid `Content-Encoding: gzip` (the ndjson text). The reader decides
 * from the first two bytes, and it does so on a stream it PEEKS rather than
 * buffers, piping the gzipped form through the engine's own
 * `DecompressionStream`: the two things engines implement for themselves, which
 * is why this runs here and not only under node.
 */

const TOKEN: EntityDeclaration = {name: 'token', id: ['id'], fields: {owner: 'text', transferCount: 'integer'}};
const FLOOR = 1_000;

function pointer(number: number) {
	return {number, hash: `0x${number.toString(16).padStart(64, '0')}`, timestamp: number * 2};
}

function owns(id: string, owner: string, transferCount: number): Mutation {
	return {type: 'upsert', entity: 'token', id: {id}, values: {owner, transferCount}};
}

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function opaqueDocument(rows = 50): Promise<Uint8Array<ArrayBuffer>> {
	const floorRows = Array.from({length: rows}, (_, index) => owns(String(index), `0x${index.toString(16)}`, index));
	return bytesOf(
		encodeSnapshot(
			{
				processor: 'proc-v1',
				savedAt: '2026-09-30T00:00:00.000Z',
				takenAt: pointer(FLOOR + 1),
				floor: FLOOR,
				cursor: {key: 'lastSync', value: `synced-through-${FLOOR + 1}`},
			},
			[TOKEN],
			[
				{block: pointer(FLOOR), mutations: floorRows},
				{
					block: pointer(FLOOR + 1),
					mutations: [owns('0', '0xcarol', 99), {type: 'delete', entity: 'token', id: {id: '1'}}],
				},
			],
		),
	);
}

function transformed(bytes: Uint8Array<ArrayBuffer>, transform: CompressionStream | DecompressionStream) {
	return bytesOf(new Blob([bytes]).stream().pipeThrough(transform) as ReadableStream<Uint8Array>);
}

/** A body a few bytes per pull, as a slow network delivers it, recording whether it was cancelled. */
function trickled(bytes: Uint8Array, chunk: number) {
	let offset = 0;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (offset >= bytes.length) return controller.close();
				controller.enqueue(bytes.slice(offset, offset + chunk));
				offset += chunk;
			},
			cancel() {
				cancelled = true;
			},
		},
		{highWaterMark: 0},
	);
	return {stream, cancelled: () => cancelled};
}

async function installed(tag: string, document: ReadableStream<Uint8Array> | Uint8Array) {
	const store = await openSnapshotAware(await createBrowserStateStore([TOKEN], {databaseName: tag}));
	await store.bootstrap(document, {processor: 'proc-v1'});
	return {
		rows: [
			await store.getCurrent('token', {id: '0'}),
			await store.getCurrent('token', {id: '1'}),
			await store.getCurrent('token', {id: '49'}),
		],
		cursor: await store.readCursor('lastSync'),
		origin: store.snapshotOrigin,
	};
}

async function until(check: () => boolean, ms = 2_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	return check();
}

async function deliveryCase(tag: string): Promise<Record<string, unknown>> {
	const opaque = await opaqueDocument();
	const plain = await transformed(opaque, new DecompressionStream('gzip'));
	const twice = await transformed(opaque, new CompressionStream('gzip'));

	// the body as `fetch` hands it over: a `Response` stream, each way
	const results: Record<string, unknown> = {
		plainFirstByte: plain[0],
		opaque: await installed(`${tag}-opaque`, new Response(opaque).body!),
		inflated: await installed(`${tag}-inflated`, new Response(plain).body!),
		opaqueOneByte: await installed(`${tag}-opaque-1`, trickled(opaque, 1).stream),
		inflatedOneByte: await installed(`${tag}-inflated-1`, trickled(plain, 1).stream),
	};

	const refusal = await readSnapshot(twice).then(
		() => 'read',
		(error: unknown) => (error instanceof SnapshotFormatError ? 'SnapshotFormatError' : String(error)),
	);
	results.twice = refusal;

	const big = await opaqueDocument(20_000);
	for (const [form, bytes] of [
		['opaque', big],
		['inflated', await transformed(big, new DecompressionStream('gzip'))],
	] as const) {
		const source = trickled(bytes, 1024);
		const reader = await readSnapshot(source.stream);
		const before = source.cancelled();
		await reader.cancel();
		results[`${form}Cancel`] = {before, after: await until(source.cancelled)};
	}
	return results;
}

const cut: CodeUnderTest = {
	name: '@etherfold/browser snapshot delivery',
	async run(ctx: RunContext): Promise<RunResult> {
		const timings: Timing[] = [];
		const errors: string[] = [];
		let results: Record<string, unknown> = {};
		try {
			results = await deliveryCase(String(ctx.params.tag));
		} catch (error) {
			const raised = error as Error | undefined;
			const message = raised?.message ?? String(error);
			const stack = raised?.stack ?? '';
			errors.push(stack.includes(message) ? stack : `${raised?.name ?? 'Error'}: ${message}\n${stack}`);
		}
		return {results, timings, errors, env: captureEnv()};
	},
};

export default cut;
