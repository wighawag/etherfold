import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createClient} from '@libsql/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {describe, expect, it} from 'vitest';
import {decodeFeedCursor} from '../src/feed/cursor.js';
import {EMISSION_STREAM_TABLE} from '../src/index.js';
import {
	ALICE,
	BOB,
	IDENTICAL_SOURCE,
	PROCESSOR_IDENTITY,
	RECONFIGURED_SOURCE,
	SOURCE,
	STREAM_DIGEST,
	batchOf,
	deploy,
	indexedThroughBlock105,
	post,
	readCanonical as read,
	readFeed,
	reorgAt103,
	transfer,
	type Deployment,
} from './utils/feedHarness.js';

// ---------------------------------------------------------------------------
// THE GENERATION A RESPONSE WAS ANSWERED FROM
// ---------------------------------------------------------------------------
// Both views advertise `generation`: WHICH FOLD answered, as a plain field
// beside the entries. It exists for the one change no cursor check can detect.
//
//  - A promotion to a generation over the SAME stream leaves every cursor valid,
//    because a `seq` is a position in a STREAM and the stream did not move.
//  - A promotion to a generation on a DIFFERENT stream is already refused, by
//    the cursor's stream component.
//  - SAME logs, DIFFERENT fold is the case in between, and NOTHING in the
//    cursor can see it. A consumer reading state alongside the feed has to be
//    told, because its own actions may not be undoable.
//
// So this file asserts the pairing rather than the field: the value MOVES on a
// processor change while every cursor stays valid and the delivered logs stay
// byte-identical. That pairing is the whole point -- it is what makes a
// processor change FREE for a feed consumer, and it is why no generation column
// is ever added to the log table.
//
// The platform ADVERTISES and does not DICTATE. Nothing here asserts what a
// consumer should DO when the value moves: pausing, re-scanning and carrying on
// are all legitimate, and only the consumer knows whether its actions can be
// taken back.
//
// And the value is OPAQUE (the last describe below): compared, never parsed, so
// what it is composed of can change without a consumer noticing. Note that not
// one assertion in this file computes an expected value -- they are all
// relations between two answers, which is what a consumer can do too.
// ---------------------------------------------------------------------------

const pkgRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Either view's response, at what this suite reads out of it. */
type AdvertisingBody = {
	success: boolean;
	stream: string;
	generation: string;
	entries: {blockHash: string; logIndex: number; data: string}[];
	cursor: string;
	hasMore: boolean;
	error?: string;
	forkBlock?: number;
	rewindCursor?: string;
};

const feed = (deployment: Deployment, name: string, query: {cursor?: string; limit?: number | string} = {}) =>
	readFeed<AdvertisingBody>(deployment, name, query);

const canonical = (
	deployment: Deployment,
	name: string,
	query: {gate?: number | string; cursor?: string; limit?: number | string} = {},
) => read<AdvertisingBody>(deployment, name, query);

/**
 * The value a response advertised, asserted to BE one before it is compared.
 *
 * Every assertion here is a RELATION between two answers, and two absent fields
 * relate perfectly: without this guard a suite that dropped the field entirely
 * would go green on "the same value" and on "a different one" alike.
 */
function advertisedBy(page: {body: AdvertisingBody; text: string}): string {
	expect(typeof page.body.generation, page.text).toBe('string');
	expect(page.body.generation.length).toBeGreaterThan(0);
	return page.body.generation;
}

/** Two blocks under one name, on a database the caller can hand to a REDEPLOY. */
async function indexed(db?: RemoteSQL): Promise<Deployment> {
	const deployment = await deploy({alpha: SOURCE}, db);
	await post(
		deployment,
		'alpha',
		batchOf(deployment, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n), transfer(102, '0xa102', BOB, 2n)]),
	);
	return deployment;
}

// ---------------------------------------------------------------------------

describe('both views advertise the generation that answered', () => {
	it('carries it on a page of the seq feed', async () => {
		const deployment = await indexed();

		const page = await feed(deployment, 'alpha');

		expect(page.status, page.text).toBe(200);
		expect(typeof page.body.generation).toBe('string');
		expect(page.body.generation.length).toBeGreaterThan(0);
	});

	it('carries it on a page of the canonical view', async () => {
		const deployment = await indexed();

		const page = await canonical(deployment, 'alpha', {gate: 110});

		expect(page.status, page.text).toBe(200);
		expect(typeof page.body.generation).toBe('string');
		expect(page.body.generation.length).toBeGreaterThan(0);
	});

	it('advertises ONE value on both views, because one fold answers both', async () => {
		const deployment = await indexed();

		const stream = await feed(deployment, 'alpha');
		const gated = await canonical(deployment, 'alpha', {gate: 110});

		expect(advertisedBy(gated)).toBe(advertisedBy(stream));
	});

	it('carries it on the REFUSALS too, so a consumer logging one has the whole context', async () => {
		const deployment = await indexed();
		const answered = advertisedBy(await feed(deployment, 'alpha'));

		const badLimit = await feed(deployment, 'alpha', {limit: 0});
		const badCursor = await feed(deployment, 'alpha', {cursor: 'not-a-cursor'});
		const missingGate = await canonical(deployment, 'alpha');
		const badGate = await canonical(deployment, 'alpha', {gate: 'soon'});

		expect(badLimit.status).toBe(400);
		expect(badCursor.status).toBe(400);
		expect(missingGate.status).toBe(400);
		expect(badGate.status).toBe(400);
		for (const refusal of [badLimit, badCursor, missingGate, badGate]) {
			expect(advertisedBy(refusal)).toBe(answered);
		}
	});

	it('carries it on a REWIND, which is a refusal a consumer acts on', async () => {
		const deployment = await indexedThroughBlock105();
		const page = await canonical(deployment, 'alpha', {gate: 105});
		await reorgAt103(deployment);

		const rewind = await canonical(deployment, 'alpha', {gate: 106, cursor: page.body.cursor});

		expect(rewind.status, rewind.text).toBe(409);
		expect(rewind.body.error).toBe('rewind-required');
		expect(advertisedBy(rewind)).toBe(advertisedBy(page));
	});
});

describe('it is STABLE while the fold is, so a consumer comparing it sees no false positive', () => {
	it('is the same value across polls, pages, and an empty page at the tip', async () => {
		const deployment = await indexed();
		const first = await feed(deployment, 'alpha');

		const again = await feed(deployment, 'alpha');
		const paged = await feed(deployment, 'alpha', {limit: 1});
		const caughtUp = await feed(deployment, 'alpha', {cursor: first.body.cursor});
		const gated = await canonical(deployment, 'alpha', {gate: 110, limit: 1});

		expect(caughtUp.body.entries).toEqual([]);
		for (const poll of [again, paged, caughtUp, gated]) {
			expect(advertisedBy(poll)).toBe(advertisedBy(first));
		}
	});

	it('does not move when new logs arrive: more data is not a different fold', async () => {
		const deployment = await indexed();
		const before = advertisedBy(await feed(deployment, 'alpha'));

		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 107, 115, 115, [transfer(112, '0xa112', ALICE, 3n)]));

		expect(advertisedBy(await feed(deployment, 'alpha'))).toBe(before);
	});

	it('says WHICH FOLD and not which tenant: one stream and one fold under two names is one value', async () => {
		// the route segment already said the tenant, and a generation is a stream
		// plus a fold over it -- so two names holding byte-identical streams folded
		// by the same processor are answering from the same generation, and a
		// consumer polls one route anyway
		const deployment = await deploy({alpha: SOURCE, beta: IDENTICAL_SOURCE});

		const alpha = await feed(deployment, 'alpha');
		const beta = await feed(deployment, 'beta');

		expect(advertisedBy(beta)).toBe(advertisedBy(alpha));
	});

	it('MOVES when the stream does, so a re-subscribed consumer is not told nothing changed', async () => {
		const onOneStream = await deploy({alpha: SOURCE});
		const onAnother = await deploy({alpha: RECONFIGURED_SOURCE});

		const first = await feed(onOneStream, 'alpha');
		const second = await feed(onAnother, 'alpha');

		expect(second.body.stream).not.toBe(first.body.stream);
		expect(advertisedBy(second)).not.toBe(advertisedBy(first));
	});
});

describe('a PROCESSOR change moves it, and costs a consumer nothing else', () => {
	it('moves the value while every cursor stays valid and the logs stay identical', async () => {
		// asserted together, because the pairing IS the point: the fold changed and
		// the stream did not, so the consumer keeps its position and its history and
		// is merely TOLD that what reads state beside this feed now means something
		// else
		const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
		const before = await indexed(db);
		const seqPage = await feed(before, 'alpha');
		const gatedPage = await canonical(before, 'alpha', {gate: 110});
		const held = {seq: seqPage.body.cursor, gated: gatedPage.body.cursor};

		// the same host, restarted with a NEW FOLD over the stream it already stored
		const after = await deploy({alpha: SOURCE}, db, {processorMarker: 'the-rebuilt-fold'});

		const reread = await feed(after, 'alpha');
		const rereadGated = await canonical(after, 'alpha', {gate: 110});
		expect(advertisedBy(reread)).not.toBe(advertisedBy(seqPage));
		expect(advertisedBy(rereadGated)).toBe(advertisedBy(reread));

		// the STREAM is untouched: same digest, same logs, in the same order
		expect(reread.body.stream).toBe(seqPage.body.stream);
		expect(reread.body.entries).toEqual(seqPage.body.entries);
		expect(rereadGated.body.entries).toEqual(gatedPage.body.entries);

		// and the cursors minted by the old generation are still positions here:
		// honoured, not refused, and caught up rather than replaying
		const resumed = await feed(after, 'alpha', {cursor: held.seq});
		const resumedGated = await canonical(after, 'alpha', {gate: 110, cursor: held.gated});
		expect(resumed.status, resumed.text).toBe(200);
		expect(resumed.body.entries).toEqual([]);
		expect(resumedGated.status, resumedGated.text).toBe(200);
		expect(resumedGated.body.entries).toEqual([]);
	});

	it('delivers the logs the consumer had not reached across the change, unchanged', async () => {
		const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
		const before = await indexed(db);
		const firstPage = await feed(before, 'alpha', {limit: 1});

		const after = await deploy({alpha: SOURCE}, db, {processorMarker: 'the-rebuilt-fold'});
		const rest = await feed(after, 'alpha', {cursor: firstPage.body.cursor});

		expect(rest.status, rest.text).toBe(200);
		expect(rest.body.entries.map((entry) => entry.blockHash)).toEqual(['0xa102']);
		expect(advertisedBy(rest)).not.toBe(advertisedBy(firstPage));
	});
});

describe('the log table knows NOTHING about the fold', () => {
	async function columnsOf(db: RemoteSQL): Promise<string[]> {
		const info = (await db.prepare(`PRAGMA table_info('${EMISSION_STREAM_TABLE}')`).all<{name: string}>()).results;
		return [...info].map((column) => column.name);
	}

	it('has no generation column, and no processor column either', async () => {
		const deployment = await indexed();

		const columns = await columnsOf(deployment.db);

		expect(columns.length).toBeGreaterThan(5);
		expect(columns.filter((column) => /generation|processor|version|fold/i.test(column))).toEqual([]);
	});

	it('stores byte-identical rows across a processor change', async () => {
		// this is what keeps a processor change FREE for a feed consumer: were the
		// generation a column, the same logs under a new fold would be new rows, and
		// every cursor into them would be worthless
		const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
		const before = await indexed(db);
		const rowsBefore = (await before.db.prepare(`SELECT * FROM ${EMISSION_STREAM_TABLE} ORDER BY seq`).all()).results;

		const after = await deploy({alpha: SOURCE}, db, {processorMarker: 'the-rebuilt-fold'});
		await feed(after, 'alpha');

		const rowsAfter = (await after.db.prepare(`SELECT * FROM ${EMISSION_STREAM_TABLE} ORDER BY seq`).all()).results;
		expect([...rowsAfter]).toEqual([...rowsBefore]);
	});
});

describe('the value is OPAQUE: compared, never parsed', () => {
	function sourceFiles(dir: string): string[] {
		return readdirSync(dir).flatMap((entry) => {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) return sourceFiles(full);
			return full.endsWith('.ts') ? [full] : [];
		});
	}

	const files = sourceFiles(join(pkgRoot, 'src'));

	it('has source files to check (guards against this test silently passing on an empty scan)', () => {
		expect(files.length).toBeGreaterThan(4);
	});

	it('is never taken apart, and never read back IN, anywhere in this package', () => {
		const offending = (pattern: RegExp) =>
			files.filter((file) => pattern.test(readFileSync(file, 'utf-8'))).map((file) => file.slice(pkgRoot.length + 1));

		// nothing decomposes it: a server that split it would be the first client to
		// depend on its composition, and the composition is meant to be replaceable
		expect(offending(/generation\w*\s*\.\s*(split|slice|substring|startsWith|indexOf|match|replace)\b/i)).toEqual([]);
		// and nothing takes one IN: it is ADVERTISED, so it is never a parameter, a
		// cursor component or a thing to validate a caller against
		expect(offending(/query\(\s*['"]generation/i)).toEqual([]);
		expect(offending(/generation/i).filter((file) => file.startsWith('src/feed/cursor.ts'))).toEqual([]);
	});

	it('does not hand back its own parts: not the stream digest, not the processor identity', async () => {
		const deployment = await indexed();

		const generation = advertisedBy(await feed(deployment, 'alpha'));

		expect(generation).not.toBe(STREAM_DIGEST);
		expect(generation).not.toContain(STREAM_DIGEST);
		expect(generation).not.toBe(PROCESSOR_IDENTITY);
		expect(generation).not.toContain(PROCESSOR_IDENTITY);
		expect(() => JSON.parse(generation)).toThrow();
	});

	it('is not in the cursor, which is why a change of generation cannot invalidate one', async () => {
		const deployment = await indexed();

		const page = await feed(deployment, 'alpha');
		const opened = decodeFeedCursor(page.body.cursor);

		expect(opened).toBeDefined();
		expect(JSON.stringify(opened)).not.toContain(advertisedBy(page));
	});
});
