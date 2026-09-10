import {openForWriting, type StateStoreCapabilities} from '@etherfold/state-store';
import {blockAtomicityCases} from './cases/block-atomicity.js';
import {boundedListingCases} from './cases/bounded-listing.js';
import {declaredCapabilityCases} from './cases/declared-capabilities.js';
import {openingForWritingCases} from './cases/opening-for-writing.js';
import {portableDeclarationCases} from './cases/portable-declarations.js';
import {readYourWritesCases} from './cases/read-your-writes.js';
import {reorgRevertCases} from './cases/reorg-revert.js';
import {retentionEnforcementCases} from './cases/retention-enforcement.js';
import {retentionPruningCases} from './cases/retention-pruning.js';
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
 * caller cannot make atomic from outside), what a prune must never delete (the
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
 * ## Every factory-driven chapter is asked TWICE, once per SHAPE
 *
 * A consumer no longer holds one thing. It holds a `WritableStateStore` if it
 * CLAIMED the store (`openForWriting`) and a `ReadableStateStore` if it did not,
 * and the writable one is a handle over the backend rather than the backend
 * itself (ADR-0077). A handle that delegated one verb wrongly would be a store
 * that behaves differently depending on how its holder obtained it, which is
 * exactly the class of defect this suite exists to catch -- so the questions are
 * asked of both, and a backend earns its place behind the seam through either
 * door. When the migration completes and there is one shape again, this loop is
 * what goes.
 *
 * The CONTENTION questions are asked ONCE, and deliberately: `a second writer
 * writes nothing` and the second-handle half of the retention-enforcement
 * chapter are driven by `twoWriters` rather than by the factory, so they are
 * questions about a second HANDLE and not about a shape. Opening a second handle
 * FOR WRITING is its own question with its own chapter (`a writer claims by
 * opening`), likewise asked once.
 */
export async function stateStoreConformanceCases(
	factory: StateStoreFactory,
	options: StateStoreConformanceOptions = {},
): Promise<ConformanceCase[]> {
	const probe = await factory(CONFORMANCE_ENTITIES);
	const capabilities = probe.capabilities;

	return [
		...factoryDrivenCases(factory, capabilities, options),
		...throughAClaimedWriter(factory, capabilities),
		...singleWriterCases(factory, capabilities, options),
		...openingForWritingCases(factory, capabilities, options),
	];
}

/** Everything a fresh store from the factory can be asked, whatever shape it is held as. */
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
		...snapshotBootstrapCases(factory, capabilities),
		...portableDeclarationCases(factory),
	];
}

/**
 * The same questions, asked of the handle a CLAIM hands back.
 *
 * `twoWriters` is deliberately withheld here (see the note on the suite): the
 * contention questions are about a second handle on one storage, and asking them
 * again through a second shape would only run them twice.
 *
 * One case is slightly WEAKER through this door and it is the first pass's to
 * hold: `openForWriting` migrates, so a declaration probe that a backend accepts
 * and then dies on at `migrate()` looks here like a refusal at construction,
 * which the probe permits. The undecorated pass asks that question exactly.
 */
function throughAClaimedWriter(factory: StateStoreFactory, capabilities: StateStoreCapabilities): ConformanceCase[] {
	const claiming: StateStoreFactory = async (declarations) => openForWriting(await factory(declarations));
	return factoryDrivenCases(claiming, capabilities, {}).map((one) => ({
		...one,
		group: `${one.group} (through a claimed writer)`,
	}));
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
