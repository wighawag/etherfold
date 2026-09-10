import {retentionFloor, type StateStoreBackend, type StateStoreCapabilities} from '@etherfold/state-store';
import {expect} from 'vitest';
import {CONFORMANCE_ENTITIES, LADDER_BASE, block, cases, opened, owns} from '../fixtures.js';
import type {ConformanceCase, StateStoreConformanceOptions, StateStoreFactory} from '../types.js';

const GROUP = 'whether the retention is actually enforced';

/**
 * The chapter that asks a store whether its own retention is being ENFORCED.
 *
 * Retention has two halves. `assertRetained` bounds what a read may ask about
 * from the moment a floor exists, and it runs on every read whatever the host
 * does; `prune` drops the versions below that floor, and ADR-0022 makes it a
 * call the HOST schedules. So a host that rolled its own loop and never
 * schedules one gets the refusals of a bounded store and the footprint of an
 * unbounded one, and until this read existed nothing anywhere could tell.
 *
 * The cases are here, in the shared suite, for the reason every chapter is: a
 * new backend must INHERIT the obligation rather than rediscover the hazard.
 * Getting it wrong is invisible in exactly the way that matters -- a backend
 * that implements the read and never records a pass reports `never-pruned` for
 * ever on a perfectly healthy deployment, and one that records unconditionally
 * reports `pruned` on an `unbounded` store that by contract deleted nothing.
 *
 * ## The universal case is a CROSS-CHECK, not a fixed expectation
 *
 * A backend's retention is its own (three claims run through this suite, plus
 * the `revert-only`-with-a-depth case whose floor the capability report does not
 * carry), so the suite cannot know what the answer should be. It does know that
 * the two reports must AGREE: `prune` already returns the floor it ran at, so a
 * pass that had a floor must leave the store reporting `pruned` AT that floor,
 * and a pass that had none must leave it reporting `no-floor`. That holds on
 * every backend under every setting, and it is exactly what a backend
 * implementing one half and not the other fails.
 */
export function retentionEnforcementCases(
	factory: StateStoreFactory,
	capabilities: StateStoreCapabilities,
	options: StateStoreConformanceOptions,
): ConformanceCase[] {
	const retention = capabilities.retention;

	/** A store holding two versions of one token, with a tip well above them. */
	async function stocked(): Promise<StateStoreBackend> {
		const store = await opened(factory);
		await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);
		return store;
	}

	const universal = cases(GROUP, {
		'never reports a prune that has not happened': async () => {
			const store = await stocked();

			// whatever this store keeps: nothing has pruned it, so `pruned` would be a
			// claim about a pass nobody ran.
			expect((await store.readRetentionEnforcement()).kind).not.toBe('pruned');
		},

		'agrees with the pass it just ran, at the floor that pass ran at': async () => {
			const store = await stocked();

			const pass = await store.prune();
			const enforcement = await store.readRetentionEnforcement();

			// the cross-check, and the whole chapter in one assertion: a pass WITH a
			// floor must be recorded at that floor, and a pass with none must leave a
			// store that has nothing to enforce saying so.
			if (pass.floor === undefined) {
				expect(enforcement).toEqual({kind: 'no-floor'});
			} else {
				expect(enforcement).toMatchObject({kind: 'pruned', prunedTo: pass.floor});
			}
		},

		'records a pass that deleted nothing, because the pass still RAN': async () => {
			const store = await opened(factory);
			// one block, one version, nothing closed: there is nothing below any floor
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);

			const pass = await store.prune();
			expect(pass.versionsDeleted).toBe(0);

			// a host pruning on a schedule deletes nothing on most cycles. Treating
			// "deleted something" as the evidence would make the healthy case the
			// alarm, and the unhealthy one indistinguishable from a quiet chain.
			const enforcement = await store.readRetentionEnforcement();
			expect(enforcement.kind).toBe(pass.floor === undefined ? 'no-floor' : 'pruned');
		},

		'is a READ: asking does not delete, and asking twice says the same thing': async () => {
			const store = await stocked();

			const first = await store.readRetentionEnforcement();
			const second = await store.readRetentionEnforcement();

			expect(second).toEqual(first);
			// nothing was pruned by the asking, on any claim
			expect(first.kind).not.toBe('pruned');
			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
		},

		'keeps reporting the pass after a revert, because what went is gone': async () => {
			const store = await stocked();
			const pass = await store.prune();

			await store.revertTo(LADDER_BASE);

			// a revert undoes blocks, not deletions. A store that forgot its pass here
			// would report `never-pruned` for a host that prunes on every cycle, which
			// is the false alarm this read must not produce.
			const enforcement = await store.readRetentionEnforcement();
			expect(enforcement.kind).toBe(pass.floor === undefined ? 'no-floor' : 'pruned');
		},
	});

	const perClaim: ConformanceCase[] =
		retention.kind === 'unbounded'
			? cases(GROUP, {
					'reports `no-floor`, because keeping everything is not something to enforce': async () => {
						const store = await stocked();

						// `unbounded` is the default and probably most deployments. Reporting
						// it as "never pruned" would drown the one report that matters.
						expect(await store.readRetentionEnforcement()).toEqual({kind: 'no-floor'});
					},
				})
			: retention.kind === 'window'
				? cases(GROUP, {
						'reports a floor and `never-pruned` before any pass, which is the broken host': async () => {
							const store = await stocked();

							// the bespoke host with a hand-rolled loop: a window configured, a
							// floor in force, and nothing ever dropped. This is the report that
							// makes it discoverable.
							expect(await store.readRetentionEnforcement()).toEqual({
								kind: 'never-pruned',
								floor: retentionFloor(retention, LADDER_BASE + 1),
							});
						},

						'reports a floor even before the first block, since a floor is a fact about the SETTING': async () => {
							const store = await opened(factory);

							// the store a misconfigured host is MOST likely to be holding has
							// applied nothing yet; answering `no-floor` here would hide it.
							expect(await store.readRetentionEnforcement()).toEqual({kind: 'never-pruned', floor: undefined});
						},

						'keeps the floor as it stands apart from the floor the last pass ran to': async () => {
							const store = await stocked();
							await store.prune();
							const prunedTo = retentionFloor(retention, LADDER_BASE + 1);

							await store.applyBlock(block(LADDER_BASE + 1_000_000), []);

							// the distance between them is the diagnostic: a store pruned once,
							// long ago, reports `pruned` and only the gap says how far behind it
							// has fallen.
							expect(await store.readRetentionEnforcement()).toEqual({
								kind: 'pruned',
								floor: retentionFloor(retention, LADDER_BASE + 1_000_000),
								prunedTo,
							});
						},
					})
				: [];

	const twoWriters = options.twoWriters;
	if (!twoWriters) return [...universal, ...perClaim];

	return [
		...universal,
		...perClaim,
		...cases(GROUP, {
			'answers a SECOND handle on the same storage, so a reload is not a fresh start': async () => {
				const [writer, reader] = await twoWriters.sharingStorage(CONFORMANCE_ENTITIES);
				await writer.migrate();
				await reader.migrate();
				await writer.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
				await writer.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);

				const pass = await writer.prune();

				// the closest thing this suite has to a RESTART, and the property that
				// forced the answer into storage rather than onto the synchronous
				// capability getter: a store pruned before the process died must not
				// come back saying never.
				const enforcement = await reader.readRetentionEnforcement();
				if (pass.floor === undefined) {
					expect(enforcement).toEqual({kind: 'no-floor'});
				} else {
					expect(enforcement).toMatchObject({kind: 'pruned', prunedTo: pass.floor});
				}
			},

			'does not take the store from its writer, because reporting is not writing': async () => {
				const [writer, reader] = await twoWriters.sharingStorage(CONFORMANCE_ENTITIES);
				await writer.migrate();
				await reader.migrate();
				await writer.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);

				await reader.readRetentionEnforcement();

				// a monitoring tab asking whether retention is enforced must not stop
				// the indexing tab from enforcing it (ADR-0075: opening and reading are
				// not writing).
				await writer.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);
				expect(await writer.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
			},
		}),
	];
}
