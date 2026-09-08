import {BlockNotRetainedError} from '@etherfold/state-store-sqlite';
import {describe, expect, it} from 'vitest';
import {VersionedStateEventProcessor} from '../src/index.js';
import {createTestDB} from './utils/db.js';
import {SOURCE, finality, lastSync, ownerOf, processor, transfer, type TestABI} from './utils/fixtures.js';

/**
 * Retention, from where a deployment actually sits: it configures a processor,
 * and it reads the state back through the view `load` and `process` hand it.
 *
 * The two things that must be true there are the two the spec asks for: a
 * consumer can DISCOVER what history is available before it asks, and asking for
 * what is not available is an error naming what was asked and what is kept.
 */

async function loaded(options: ConstructorParameters<typeof VersionedStateEventProcessor>[2] = {}) {
	const p = new VersionedStateEventProcessor<TestABI>(createTestDB(), processor, options);
	await p.load(SOURCE, {finality});
	return p;
}

describe('what a consumer can discover at startup', () => {
	it('reads the retention off the view, before any read', async () => {
		const p = await loaded();
		expect(p.state.capabilities).toEqual({retention: {kind: 'unbounded'}, asOf: true});
	});

	it('reports `revert-only` when the deployment asked for it', async () => {
		const p = await loaded({retention: 'revert-only'});
		expect(p.state.capabilities).toEqual({retention: {kind: 'revert-only'}, asOf: false});
	});
});

describe('a revert-only deployment', () => {
	it('refuses a historical read through the view, and never answers it from the tip', async () => {
		const p = await loaded({retention: 'revert-only'});
		await p.process(
			[
				transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
				transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n}),
			],
			lastSync({latestBlock: 101, lastToBlock: 101}),
		);

		const error = await p.state.getAsOf('token', {id: '1'}, 100).catch((e) => e);
		expect(error).toBeInstanceOf(BlockNotRetainedError);
		expect(error.requested).toBe(100);
		expect(error.message).toMatch(/revert-only/);
		expect(await ownerOf(p, '1')).toBe('0xbob');
	});

	it('still reverts a reorg, which is the capability it declares', async () => {
		const p = await loaded({retention: 'revert-only'});
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		await p.process(
			[
				transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}, {removed: true}),
				transfer(100, '0xBBB', {from: '0x0', to: '0xcarol', id: 1n}),
			],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		expect(await ownerOf(p, '1')).toBe('0xcarol');
	});
});

describe('the retention floor and the stream that reorgs against it', () => {
	it('refuses a window below the finality depth, at construction', () => {
		expect(
			() =>
				new VersionedStateEventProcessor<TestABI>(createTestDB(), processor, {
					retention: {blocks: 8},
					finalityDepth: 64,
				}),
		).toThrow(/finality/i);
	});

	it('refuses at load when the stream reorgs deeper than the floor retention was set against', async () => {
		// The two numbers are configured in different places (the store's floor, the
		// stream's finality), so they can disagree; the disagreement means a reorg
		// can reach past what retention promised to keep, which is silent corruption
		// waiting for a deep reorg.
		const p = new VersionedStateEventProcessor<TestABI>(createTestDB(), processor, {
			retention: {blocks: 4},
			finalityDepth: 4,
		});
		await expect(p.load(SOURCE, {finality: 12})).rejects.toThrow(/4[\s\S]*12|12[\s\S]*4/);
	});

	it('accepts a floor at or above the stream finality', async () => {
		const p = new VersionedStateEventProcessor<TestABI>(createTestDB(), processor, {
			retention: {blocks: 128},
			finalityDepth: 64,
		});
		await expect(p.load(SOURCE, {finality: 12})).resolves.toBeUndefined();
		// and the window IS claimed, because the store enforces it: refused on read,
		// and dropped from storage by `prune`.
		expect(p.state.capabilities.retention).toEqual({kind: 'window', blocks: 128});
	});
});

/**
 * Enforcing retention against the STORAGE, from where a deployment sits.
 *
 * The window bounds what the state answers from the moment it is configured;
 * this is the other half, and it is a call the deployment makes rather than
 * something `process` does behind its back, because it costs time proportional
 * to what it drops. It sits on the processor and not on `state` because it is a
 * WRITE, and the view is read-only on purpose.
 */
describe('a deployment enforcing its window against the storage', () => {
	it('drops the versions the window no longer covers, and keeps answering inside it', async () => {
		const p = new VersionedStateEventProcessor<TestABI>(createTestDB(), processor, {
			retention: {blocks: 64},
			finalityDepth: 64,
		});
		await p.load(SOURCE, {finality: 64});
		await p.process(
			[
				transfer(1_000, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
				transfer(1_010, '0xB', {from: '0xalice', to: '0xbob', id: 1n}),
				transfer(1_100, '0xC', {from: '0xbob', to: '0xcarol', id: 1n}),
			],
			lastSync({latestBlock: 1_100, lastToBlock: 1_100}),
		);

		// tip 1_100, window 64, floor 1_036: Alice's version closed at 1_010 and is
		// unreachable by any legal read.
		const report = await p.prune();

		expect(report).toMatchObject({tip: 1_100, floor: 1_036, complete: true});
		expect(report.versionsDeleted).toBeGreaterThan(0);
		expect(await p.state.getAsOf('token', {id: '1'}, 1_036)).toMatchObject({owner: '0xbob'});
		expect(await ownerOf(p, '1')).toBe('0xcarol');
	});

	it('is a no-op on the default retention, so a host may schedule it unconditionally', async () => {
		const p = await loaded();
		await p.process(
			[transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);

		expect(await p.prune()).toMatchObject({floor: undefined, versionsDeleted: 0, complete: true});
	});
});
