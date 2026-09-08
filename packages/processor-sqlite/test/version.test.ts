import {describe, expect, it} from 'vitest';
import {IndexerGeneration, simple_hash, type ProcessorDriftReport} from '@etherfold/core';
import {VersionedStateEventProcessor, type SQLProcessor} from '../src/index.js';
import {deserializeLastSync, serializeLastSync} from '../src/sync.js';
import {createTestDB, rows} from './utils/db.js';
import {finality, freshProcessor, lastSync, processor, SOURCE, transfer, type TestABI} from './utils/fixtures.js';

// ---------------------------------------------------------------------------
// A PROCESSOR'S VERSION HASH CANNOT SILENTLY LIE: the SQL path
// ---------------------------------------------------------------------------
// Ported from the retired in-memory path's `version.test.ts`. This
// implementation reproduced that path's `unknown` fallback on the day it was
// written, which is why the task that removed it covered both.
//
// What differs here is where the cursor lives. `lastSync` is ALWAYS persisted (a
// single `_sync` row, not a keeper the author may or may not configure), and it
// goes through a BigInt-tagging codec rather than plain JSON, so "the
// fingerprint rides along in the context" is a claim that has to be tested
// rather than assumed.
// ---------------------------------------------------------------------------

/** The same processor with an edited handler and a DELIBERATELY unchanged version. */
const editedSameVersion: SQLProcessor<TestABI> = {
	...processor,
	async onTransfer(state, event) {
		state.set('token', {id: event.args.id.toString()}, {owner: event.args.from});
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
};

describe('a version is mandatory', () => {
	it('refuses to construct a processor with no version', () => {
		const {version, ...noVersion} = processor;
		expect(() => new VersionedStateEventProcessor(createTestDB(), noVersion as SQLProcessor<TestABI>)).toThrow(
			/has no `version`/,
		);
	});

	it('refuses an empty or whitespace-only version', () => {
		// Every VARIANT below is annotated `SQLProcessor<TestABI>`. The handler map
		// MAPS over the ABI's event names, so `ABI` is not inferrable from an object
		// LITERAL: a bare spread of `processor` widens to the `Abi` constraint and the
		// handlers it just copied stop matching the resulting index signature.
		const empty: SQLProcessor<TestABI> = {...processor, version: ''};
		const whitespace: SQLProcessor<TestABI> = {...processor, version: '  '};
		expect(() => new VersionedStateEventProcessor(createTestDB(), empty)).toThrow(/has no `version`/);
		expect(() => new VersionedStateEventProcessor(createTestDB(), whitespace)).toThrow(/has no `version`/);
	});

	it('names the processor and says why the version is required', () => {
		const {version, ...noVersion} = processor;
		let message = '';
		try {
			new VersionedStateEventProcessor(createTestDB(), noVersion as SQLProcessor<TestABI>);
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain('VersionedStateEventProcessor');
		expect(message).toContain('onTransfer');
		expect(message).toMatch(/reused forever/);
	});
});

describe('getVersionHash', () => {
	it('cannot contain the `unknown` fallback, because there is no fallback left', () => {
		const p = new VersionedStateEventProcessor(createTestDB(), processor);
		expect(p.getVersionHash()).not.toContain('unknown');
		expect(p.getVersionHash()).toContain('1.0.0');
	});

	it('has no `unknown` branch left even with the constructor guard defeated', () => {
		// The criterion is that the fallback is REMOVED, not merely unreachable. A
		// constructor guard makes it unobservable through the front door, so this goes
		// through the back one: an unreachable `|| 'unknown'` would still be sitting in
		// the expression, one refactor away from being reachable again, and it is the
		// SHARED constant that is the bug (every version-less processor hashing alike).
		const p = new VersionedStateEventProcessor(createTestDB(), processor);
		(p as unknown as {version: string | undefined}).version = undefined;
		expect(p.getVersionHash()).not.toContain('unknown');
	});

	it('carries no fallback constant at all, configured or not', () => {
		// Not just `unknown`: `not-configured` is gone too. The digest is recomputed
		// the way the class does it, so this pins the FORMAT rather than one value.
		const p = new VersionedStateEventProcessor(createTestDB(), processor);
		expect(p.getVersionHash()).toBe(`1.0.0-${simple_hash({entities: processor.entities, config: undefined})}`);
		expect(p.getVersionHash()).not.toContain('not-configured');
	});

	it('still changes when the entity SCHEMA changes at a fixed version', () => {
		// The schema is part of what the stored rows MEAN, and folding it into one
		// digest with the config must not lose that.
		const renamedField: SQLProcessor<TestABI> = {
			...processor,
			entities: [{name: 'token', id: ['id'], fields: {holder: 'text'}}, processor.entities[1]],
		};
		const a = new VersionedStateEventProcessor(createTestDB(), processor);
		const b = new VersionedStateEventProcessor(createTestDB(), renamedField);
		expect(a.getVersionHash()).not.toBe(b.getVersionHash());
	});

	it('gives an unconfigured processor and one configured with undefined the SAME hash', () => {
		const never = new VersionedStateEventProcessor(createTestDB(), processor);
		const configured = new VersionedStateEventProcessor(createTestDB(), processor);
		configured.configure(undefined as never);
		expect(configured.getVersionHash()).toBe(never.getVersionHash());
	});
});

describe('the code fingerprint', () => {
	it('changes when a handler changes at an unchanged version', () => {
		const original = new VersionedStateEventProcessor(createTestDB(), processor);
		const edited = new VersionedStateEventProcessor(createTestDB(), editedSameVersion);

		expect(original.getVersionHash()).toBe(edited.getVersionHash());
		expect(original.getCodeFingerprint()).toBeDefined();
		expect(original.getCodeFingerprint()).not.toBe(edited.getCodeFingerprint());
	});

	it('is identical for two instances of the same processor', () => {
		const a = new VersionedStateEventProcessor(createTestDB(), processor);
		const b = new VersionedStateEventProcessor(createTestDB(), processor);
		expect(a.getCodeFingerprint()).toBe(b.getCodeFingerprint());
	});

	it('does not move when only the version changes', () => {
		const bumped: SQLProcessor<TestABI> = {...processor, version: '9.9.9'};
		const a = new VersionedStateEventProcessor(createTestDB(), processor);
		const b = new VersionedStateEventProcessor(createTestDB(), bumped);
		expect(a.getCodeFingerprint()).toBe(b.getCodeFingerprint());
	});
});

describe('the fingerprint survives the cursor codec', () => {
	it('round-trips through serialize/deserialize unchanged', () => {
		// The cursor is NOT plain JSON: BigInts are tagged on the way out and rebuilt
		// on the way in. A fingerprint is a plain string and should be untouched by
		// that, which is a claim worth an assertion rather than a shrug.
		const fingerprint = 'fp-abc123';
		const cursor = lastSync({latestBlock: 100, lastToBlock: 100});
		cursor.context = {...cursor.context, processorFingerprint: fingerprint};

		const restored = deserializeLastSync<TestABI>(serializeLastSync(cursor));

		expect(restored.context.processorFingerprint).toBe(fingerprint);
	});

	it('survives alongside the BigInt args of a real decoded event', () => {
		const unconfirmed = transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 7n});
		const cursor = lastSync({
			latestBlock: 100,
			lastToBlock: 100,
			unconfirmedBlocks: [{number: 100, hash: '0xAAA', events: [unconfirmed]}],
		});
		cursor.context = {...cursor.context, processorFingerprint: 'fp-abc123'};

		const restored = deserializeLastSync<TestABI>(serializeLastSync(cursor));

		expect(restored.context.processorFingerprint).toBe('fp-abc123');
		expect((restored.unconfirmedBlocks[0].events[0] as any).args.id).toBe(7n);
	});

	it('comes back through a real database write and read', async () => {
		const {db, p} = await freshProcessor();
		const cursor = lastSync({latestBlock: 100, lastToBlock: 100});
		cursor.context = {...cursor.context, processorFingerprint: p.getCodeFingerprint()};

		await p.process([transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})], cursor);

		const restarted = new VersionedStateEventProcessor(db, processor);
		const loaded = await restarted.load(SOURCE, {finality});
		expect(loaded!.lastSync.context.processorFingerprint).toBe(p.getCodeFingerprint());
		// and it really is in the row, not only in some in-memory copy. The cursor is
		// the store's `_cursor` table now (an opaque string under a key), not this
		// package's `_sync`, because it has to be written in the same transaction as
		// the block it describes; see `src/sync.ts`.
		const [row] = await rows<{value: string}>(db, `SELECT "value" FROM _cursor`);
		expect(row.value).toContain(p.getCodeFingerprint()!);
	});

	it('reads a cursor written BEFORE fingerprints existed as absent, not as empty', async () => {
		const {db, p} = await freshProcessor();
		// exactly what an upgraded deployment finds: the field was never written
		await p.process([transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})], lastSync({lastToBlock: 100}));

		const restarted = new VersionedStateEventProcessor(db, processor);
		const loaded = await restarted.load(SOURCE, {finality});
		expect(loaded!.lastSync.context.processorFingerprint).toBeUndefined();
	});
});

// -- end to end, through a real indexer and a real database ------------------

function makeProvider() {
	return {
		async request({method}: {method: string}) {
			if (method === 'eth_chainId') return '0x1';
			if (method === 'eth_blockNumber') return '0x0';
			if (method === 'eth_getLogs') return [];
			throw new Error(`unexpected ${method}`);
		},
	} as any;
}

async function loadWith(p: VersionedStateEventProcessor<TestABI>, config: {strictProcessorDrift?: boolean} = {}) {
	const reports: ProcessorDriftReport[] = [];
	const indexer = new IndexerGeneration<TestABI, any>(makeProvider(), p, SOURCE, {stream: {finality}, ...config});
	indexer.onProcessorDrift = (report) => reports.push(report);
	return {indexer, reports, load: () => indexer.load()};
}

/** Index one block with `p` through a real indexer, leaving a real cursor in `db`. */
async function indexOneBlock(p: VersionedStateEventProcessor<TestABI>) {
	const indexer = new IndexerGeneration<TestABI, any>(makeProvider(), p, SOURCE, {stream: {finality}});
	await indexer.load();
	await indexer.feed([transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})], lastSync({lastToBlock: 100}));
}

describe('drift, end to end', () => {
	it('reports when a handler changed but the version did not', async () => {
		const db = createTestDB();
		await indexOneBlock(new VersionedStateEventProcessor(db, processor));

		const {reports, load} = await loadWith(new VersionedStateEventProcessor(db, editedSameVersion));
		await load();

		expect(reports).toHaveLength(1);
		expect(reports[0].processorHash).toBe(new VersionedStateEventProcessor(db, processor).getVersionHash());
		expect(reports[0].currentFingerprint).toBe(
			new VersionedStateEventProcessor(db, editedSameVersion).getCodeFingerprint(),
		);
	});

	it('does not report when the version WAS bumped', async () => {
		const db = createTestDB();
		await indexOneBlock(new VersionedStateEventProcessor(db, processor));

		const {reports, load} = await loadWith(
			new VersionedStateEventProcessor(db, {...editedSameVersion, version: '2.0.0'}),
		);
		await load();

		expect(reports).toEqual([]);
	});

	it('does not report for a byte-identical processor across a restart', async () => {
		const db = createTestDB();
		await indexOneBlock(new VersionedStateEventProcessor(db, processor));

		const {reports, load} = await loadWith(new VersionedStateEventProcessor(db, processor));
		await load();

		expect(reports).toEqual([]);
	});

	it('does not report against a cursor written before fingerprints existed', async () => {
		const db = createTestDB();
		await indexOneBlock(new VersionedStateEventProcessor(db, processor));
		// strip the field from the stored row, as an upgraded deployment's would be
		const [row] = await rows<{value: string}>(db, `SELECT "value" FROM _cursor`);
		const stripped = JSON.parse(row.value);
		delete stripped.context.processorFingerprint;
		await db.prepare(`UPDATE _cursor SET "value" = ?`).bind(JSON.stringify(stripped)).all();

		const {reports, load} = await loadWith(new VersionedStateEventProcessor(db, editedSameVersion));
		await load();

		expect(reports).toEqual([]);
	});

	it('refuses to start under strict mode, and starts without it', async () => {
		const db = createTestDB();
		await indexOneBlock(new VersionedStateEventProcessor(db, processor));

		const strict = await loadWith(new VersionedStateEventProcessor(db, editedSameVersion), {
			strictProcessorDrift: true,
		});
		await expect(strict.load()).rejects.toThrow(/PROCESSOR DRIFT/);

		const lenient = await loadWith(new VersionedStateEventProcessor(db, editedSameVersion));
		await expect(lenient.load()).resolves.toBeTruthy();
	});
});
