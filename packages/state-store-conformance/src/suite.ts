import type {StateStoreCapabilities} from '@etherfold/state-store';
import {blockAtomicityCases} from './cases/block-atomicity.js';
import {boundedListingCases} from './cases/bounded-listing.js';
import {declaredCapabilityCases} from './cases/declared-capabilities.js';
import {openingForWritingCases} from './cases/opening-for-writing.js';
import {portableDeclarationCases} from './cases/portable-declarations.js';
import {readYourWritesCases} from './cases/read-your-writes.js';
import {reorgRevertCases} from './cases/reorg-revert.js';
import {retentionEnforcementCases} from './cases/retention-enforcement.js';
import {retentionPruningCases} from './cases/retention-pruning.js';
import {seamRecordCases} from './cases/seam-records.js';
import {singleWriterCases} from './cases/single-writer.js';
import {snapshotBootstrapCases} from './cases/snapshot-bootstrap.js';
import {syncCursorCases} from './cases/sync-cursor.js';
import {versionedReadCases} from './cases/versioned-reads.js';
import {CONFORMANCE_ENTITIES} from './fixtures.js';
import type {
	ConformanceCase,
	ConformanceFailure,
	ConformanceResult,
	StateStoreConformanceOptions,
	StateStoreFactory,
} from './types.js';

/**
 * Every case a backend must pass, chosen against what that backend CLAIMS.
 *
 * The selection is the interesting part. A store is built once as a probe and
 * its `capabilities` are read -- before `migrate`, before any write, exactly as
 * a caller would read them at startup -- and the case list is assembled from
 * them: a store claiming `unbounded` gets asked a read at any depth, a store
 * claiming a WINDOW gets asked at both of its edges, and a store claiming no
 * historical read gets asked to refuse every one of them. Testing a backend
 * against a capability it never claimed would fail honest backends; testing it
 * against LESS than it claimed is what lets a claim become fiction.
 *
 * Everything else is asked of everyone: versioned reads, the reorg revert with
 * its counter that must go back DOWN, read-your-writes inside a block, the
 * bounded id-prefix listing a one-to-many is derived through, a block applying
 * as one unit (with the sync cursor that describes it, which is the half a
 * caller cannot make atomic from outside), that the seam's OWN three records
 * live in a keyspace no caller can reach (which is what makes the cursor port
 * entirely the caller's, so a cursor named `snapshotOrigin` collides with
 * nothing), what a prune must never delete (the
 * same claim-driven selection: what a store may drop is what it stopped
 * promising to answer), whether the retention a store reports is actually being
 * ENFORCED against its storage (cross-checked against the pass's own report,
 * because only the store knows whether it has a floor at all), what a store
 * bootstrapped from a snapshot may claim
 * about history it never received (claim-driven again, and the one trap a new
 * backend would otherwise rediscover in a browser tab), that a SECOND WRITER
 * writes nothing on a backend that claims it can enforce one (the same
 * claim-driven selection again, and the one chapter that needs a second handle
 * the factory cannot give -- see `StateStoreConformanceOptions`), and that a
 * DECLARATION means the same thing here as it does on every other backend.
 *
 * ## ONE shape, asked once
 *
 * A backend hands over a `StateStoreBackend` and that is what every chapter here
 * is asked of. There was briefly a second pass, over the handle `openForWriting`
 * returns, while the seam carried both halves and consumers migrated one package
 * at a time; it is gone with the migration, because there is one shape again
 * (ADR-0077). What the CLAIMED handle owes is asked where it belongs: `a writer
 * claims by opening` below, and `writable-seam.test.ts` in `@etherfold/state-store`
 * for the delegation itself.
 *
 * The CONTENTION questions are driven by `twoWriters` rather than by the factory
 * (`a second writer writes nothing`, and the second-handle half of the
 * retention-enforcement chapter), because they are questions about a second
 * HANDLE on one storage, which a factory promising a fresh database per call
 * cannot express.
 */
export async function stateStoreConformanceCases(
	factory: StateStoreFactory,
	options: StateStoreConformanceOptions = {},
): Promise<ConformanceCase[]> {
	const probe = await factory(CONFORMANCE_ENTITIES);
	const capabilities = probe.capabilities;

	return [
		...factoryDrivenCases(factory, capabilities, options),
		...singleWriterCases(factory, capabilities, options),
		...openingForWritingCases(factory, capabilities, options),
	];
}

/** Everything a fresh store from the factory can be asked. */
function factoryDrivenCases(
	factory: StateStoreFactory,
	capabilities: StateStoreCapabilities,
	options: StateStoreConformanceOptions,
): ConformanceCase[] {
	return [
		...versionedReadCases(factory, capabilities),
		...declaredCapabilityCases(factory, capabilities),
		...retentionPruningCases(factory, capabilities),
		...retentionEnforcementCases(factory, capabilities, options),
		...reorgRevertCases(factory, capabilities),
		...readYourWritesCases(factory, capabilities),
		...boundedListingCases(factory, capabilities),
		...blockAtomicityCases(factory),
		...syncCursorCases(factory),
		...seamRecordCases(factory, options),
		...snapshotBootstrapCases(factory, capabilities),
		...portableDeclarationCases(factory),
	];
}

/**
 * Run every case and report what failed, without a test runner.
 *
 * This exists so the suite can be asserted ON rather than merely run: the tests
 * that prove the capability cases are real feed deliberately-broken backends to
 * this function and check WHICH cases went red. It is equally the way a backend
 * outside this repo, or outside vitest, can check itself.
 *
 * It does not stop at the first failure, because "which of the twelve did I
 * break" is the question a backend author actually has.
 */
export async function runStateStoreConformance(
	factory: StateStoreFactory,
	options: StateStoreConformanceOptions = {},
): Promise<ConformanceResult> {
	const cases = await stateStoreConformanceCases(factory, options);
	const failures: ConformanceFailure[] = [];

	for (const one of cases) {
		try {
			await one.run();
		} catch (error) {
			failures.push({group: one.group, name: one.name, error});
		}
	}

	return {passed: cases.length - failures.length, failures};
}
