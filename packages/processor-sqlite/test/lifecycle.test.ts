import {describe, expect, it} from 'vitest';
import {VersionedStateEventProcessor, type SQLProcessor} from '../src/index.js';
import {createTestDB, rows} from './utils/db.js';
import {
	finality,
	freshProcessor,
	lastSync,
	ownerOf,
	processor,
	SOURCE,
	timestampOf,
	transfer,
	type TestABI,
} from './utils/fixtures.js';
import {identityOf} from './utils/processorIdentity.js';

// Every processor VARIANT below is annotated `SQLProcessor<TestABI>`. The handler
// map MAPS over the ABI's event names, so `ABI` is not inferrable from an object
// LITERAL: a bare spread of `processor` widens to the `Abi` constraint and the
// handlers it just copied stop matching the resulting index signature.

describe('the sync cursor', () => {
	it('is absent before the first sync, so the core starts fresh', async () => {
		const p = new VersionedStateEventProcessor(createTestDB(), processor);
		expect(await p.load(SOURCE, {finality})).toBeUndefined();
	});

	it('survives a restart against the same database, with the state it points at', async () => {
		const db = createTestDB();
		const {p} = await freshProcessor(db);
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100, lastFromBlock: 88}),
		);

		const restarted = new VersionedStateEventProcessor(db, processor);
		const loaded = await restarted.load(SOURCE, {finality});
		expect(loaded?.lastSync.lastToBlock).toBe(100);
		expect(loaded?.lastSync.lastFromBlock).toBe(88);
		expect(loaded?.lastSync.context).toEqual(lastSync().context);
		expect((await loaded?.state.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xalice');
	});

	it('is returned even when the stored context does not match, so the core can clear', async () => {
		// This is the reason the cursor is ONE key rather than one key per context.
		// The core's discard-and-clear branch lives inside `if (loaded)`; a
		// context-keyed table would answer "no row" after a processor upgrade,
		// `load` would return undefined, and the previous processor's entity rows
		// would silently survive into the new run. See `SYNC_CURSOR_KEY`.
		const db = createTestDB();
		const {p} = await freshProcessor(db);
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);

		// The upgrade is a DIFFERENT ARRIVAL and not a bumped `version` (ADR-0086): the
		// same authored object, folded under the identity a host derived from other
		// bytes. What the case is about is a stored context that does not match the fold
		// now running, and where that mismatch came from is exactly what the engine never
		// asks.
		const upgraded = new VersionedStateEventProcessor(db, processor, {identity: identityOf('v2')});
		const loaded = await upgraded.load(SOURCE, {finality});
		expect(loaded).toBeDefined();
		expect(loaded!.lastSync.context.processor).not.toBe(upgraded.getVersionHash());

		// ...and the core's response to that mismatch leaves nothing behind
		await upgraded.clear();
		expect(await rows(db, `SELECT * FROM token`)).toEqual([]);
		expect(await upgraded.load(SOURCE, {finality})).toBeUndefined();
	});

	it('survives the BigInt args a real decoded event carries', async () => {
		// Found end-to-end against a real anvil, not by any hand-built stream:
		// `unconfirmedBlocks` holds the actual LogEvents of the reorg window, and a
		// decoded `uint256` arg is a BigInt, which plain JSON.stringify REFUSES to
		// serialize. Every cursor in these tests had an empty unconfirmed window, so
		// the first real Transfer was the first thing to hit it.
		const db = createTestDB();
		const {p} = await freshProcessor(db);
		const unconfirmed = transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 7n});
		await p.process(
			[unconfirmed],
			lastSync({
				latestBlock: 100,
				lastToBlock: 100,
				unconfirmedBlocks: [{number: 100, hash: '0xAAA', events: [unconfirmed]}],
			}),
		);

		const restarted = new VersionedStateEventProcessor(db, processor);
		const loaded = await restarted.load(SOURCE, {finality});
		const arg = (loaded!.lastSync.unconfirmedBlocks[0].events[0] as any).args.id;
		// and it comes back a BigInt, not the string it was stored as: a cursor that
		// round-trips into a different TYPE would silently change what a replayed
		// handler computes.
		expect(arg).toBe(7n);
		expect(typeof arg).toBe('bigint');
	});

	it('is only overwritten, never duplicated', async () => {
		const {db, p} = await freshProcessor();
		await p.process([], lastSync({latestBlock: 100, lastToBlock: 100}));
		await p.process([], lastSync({latestBlock: 101, lastToBlock: 101}));
		// `_cursor` is the STORE's table (an opaque string under a key), not this
		// package's old `_sync`: the cursor moved behind the seam so it could be
		// written in the same transaction as the block it describes. See `src/sync.ts`.
		const stored = await rows<{key: string}>(db, `SELECT "key" FROM _cursor`);
		expect(stored).toHaveLength(1);
	});
});

describe('the identity this fold answers with', () => {
	// DECLARED-PATH WITNESS (two of the three cases below). They are about the
	// ARRIVAL's identity, and they establish it by CONTRASTING it with the declared
	// one -- a second fold built with no identity, asked for `getVersionHash()`. That
	// contrast is deliberate and is why they are not migrated: ADR-0086 says an author
	// cannot STATE an identity, and "the arrival's is not the declared one" is a claim
	// that needs both values. So these exist to prove the DECLARED path still works,
	// and `the-declared-version-and-the-drift-report-are-deleted` is what retires
	// them: when the fallback goes, the `declared` half of each case goes with it and
	// what is left is the arrival assertion above it, which stands on its own.
	it('is the one the ARRIVAL handed it, where a host had one', () => {
		// ADR-0086: an author cannot STATE their processor's identity, and where a host
		// read a self-contained BUNDLE off disk it hands over the hash of those bytes.
		// The DECLARED hash is then not consulted at all rather than compared with it,
		// which is what lets an edited handler be a different fold with no author action.
		const identity = identityOf('the-bundle-this-deployment-runs');
		const handed = new VersionedStateEventProcessor(createTestDB(), processor, {identity});
		expect(handed.getVersionHash()).toBe(identity);

		const declared = new VersionedStateEventProcessor(createTestDB(), processor);
		expect(handed.getVersionHash()).not.toBe(declared.getVersionHash());
	});

	it('is not moved by a later `configure`, because a bundle carries the config it was built with', () => {
		// The declared hash covers the config, so `configure` MOVES it -- asserted below,
		// so this case is about the arrival's identity rather than about `configure`
		// happening to do nothing. An arrival's does not move, and that is correct rather
		// than a limitation: the config a bundle was built with is IN the bundle, so there
		// is nothing left for a caller to add.
		const configurable = processor as unknown as SQLProcessor<TestABI, {fee: number}>;
		const identity = identityOf('configured-in-the-bundle');

		const handed = new VersionedStateEventProcessor(createTestDB(), configurable, {identity});
		handed.configure({fee: 1});
		expect(handed.getVersionHash()).toBe(identity);

		const declared = new VersionedStateEventProcessor(createTestDB(), configurable);
		const unconfigured = declared.getVersionHash();
		declared.configure({fee: 1});
		expect(declared.getVersionHash()).not.toBe(unconfigured);
	});

	it('reaches the fold underneath, so there is one answer and never two', async () => {
		// The wrapper is what the core asks, but the fold it builds computes an identity
		// of its own unless it is handed this one -- and two live answers to "which fold
		// is this" is the whole hazard `EntityEventProcessorOptions.identity` exists to
		// close. Reached through `load`, which is what builds the inner fold.
		const identity = identityOf('forwarded-to-the-inner-fold');
		const p = new VersionedStateEventProcessor(createTestDB(), processor, {identity});
		await p.load(SOURCE, {finality});
		expect((await innerFoldOf(p)).getVersionHash()).toBe(identity);
	});
});

/**
 * The neutral fold the wrapper built, reached the only way a test can.
 *
 * It is private, memoised and deliberately absent from the public surface,
 * because a deployment holds the WRAPPER and asks it; so the one thing worth
 * asserting about the fold underneath is that it was told the same thing, and
 * that has to be read off the field. Built on first use, so `load` or `process`
 * must have run.
 */
async function innerFoldOf(p: VersionedStateEventProcessor<TestABI, any>): Promise<{getVersionHash(): string}> {
	const folding = (p as unknown as {folding?: Promise<{getVersionHash(): string}>}).folding;
	if (!folding) throw new Error(`no fold was built: call load() or process() first`);
	return folding;
}

describe('getVersionHash, the DECLARED fallback', () => {
	// DECLARED-PATH WITNESS, retained on purpose. ADR-0086 moves identity off the
	// author's declaration and onto the ARRIVAL, and every other identity in this
	// package now comes from one -- but the declared `version` must still EXIST AND
	// WORK until `the-declared-version-and-the-drift-report-are-deleted` removes it,
	// and a batch that left no assertion of that inside this package would be trusting
	// a sibling package to notice. These three exist to prove the declared path still
	// works, and they go with the field they describe, in that task.
	it('changes when the processor version changes', () => {
		const v2: SQLProcessor<TestABI> = {...processor, version: '2.0.0'};
		const a = new VersionedStateEventProcessor(createTestDB(), processor);
		const b = new VersionedStateEventProcessor(createTestDB(), v2);
		expect(a.getVersionHash()).not.toBe(b.getVersionHash());
	});

	it('changes when the entity SCHEMA changes, even at the same version', () => {
		// The schema is part of what the stored rows MEAN. A renamed field at an
		// unchanged version would otherwise let the core adopt rows whose columns
		// no longer say what the handlers now assume.
		const renamedField: SQLProcessor<TestABI> = {
			...processor,
			entities: [{name: 'token', id: ['id'], fields: {holder: 'text'}}, processor.entities[1]],
		};
		const a = new VersionedStateEventProcessor(createTestDB(), processor);
		const b = new VersionedStateEventProcessor(createTestDB(), renamedField);
		expect(a.getVersionHash()).not.toBe(b.getVersionHash());
	});

	it('is stable across instances of the same processor', () => {
		const a = new VersionedStateEventProcessor(createTestDB(), processor);
		const b = new VersionedStateEventProcessor(createTestDB(), processor);
		expect(a.getVersionHash()).toBe(b.getVersionHash());
	});
});

describe('reset and clear', () => {
	it('wipe state, history and the cursor together', async () => {
		const {db, p} = await freshProcessor();
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		await p.reset();

		expect(await ownerOf(p, '1')).toBeUndefined();
		expect(await rows(db, `SELECT * FROM token`)).toEqual([]);
		expect(await rows(db, `SELECT * FROM counter`)).toEqual([]);
		expect(await rows(db, `SELECT * FROM _blocks`)).toEqual([]);
		expect(await rows(db, `SELECT * FROM _cursor`)).toEqual([]);
		// no history is left behind either: a wiped store cannot time-travel
		expect(await p.state.getAsOf('token', {id: '1'}, 100)).toBeUndefined();
	});

	it('leave the database usable, so indexing can start again from scratch', async () => {
		const {p} = await freshProcessor();
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		await p.clear();
		// the SAME block may be applied again: the revert removed its block row
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xzoe', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		expect(await ownerOf(p, '1')).toBe('0xzoe');
	});
});

describe('the blockTimestamp requirement', () => {
	it('loads on a stream config of nothing but `finality`, because the log carries the time', async () => {
		// Nodes implementing execution-apis#639 put `blockTimestamp` on the log, and
		// there is no longer any flag that could buy one otherwise: the fallback that
		// fetched the block is deleted (ADR-0073). So the time axis is never something
		// a deployment has to opt into here.
		const p = new VersionedStateEventProcessor(createTestDB(), processor);
		await expect(p.load(SOURCE, {finality})).resolves.toBeUndefined();
	});

	it('records the timestamp straight off the log, with no extra fetch', async () => {
		const {db, p} = await freshProcessor();
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		const [block] = await rows<{timestamp: number}>(db, `SELECT timestamp FROM _blocks`);
		expect(block.timestamp).toBe(timestampOf(100));
	});

	it('refuses a block whose events carry no timestamp, rather than guessing', async () => {
		// The one guarantee that survives everywhere: a block is never recorded on a
		// guess. A zero would not fail, it would answer confidently about the wrong
		// block forever, and the read side has no way to tell a caller it was lied to.
		const p = new VersionedStateEventProcessor(createTestDB(), processor);
		await p.load(SOURCE, {finality});
		await expect(
			p.process(
				[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}, {blockTimestamp: undefined} as any)],
				lastSync({latestBlock: 100, lastToBlock: 100}),
			),
		).rejects.toThrow(/no blockTimestamp/);
	});
});
