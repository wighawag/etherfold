/**
 * The conformance WORKLOAD: a real launched processor, its real captured event
 * stream, and the state the ORIGINAL processor computed from it, run against
 * whichever backend a factory hands over.
 *
 * A workload is a SUBJECT fed to the conformance suite's question, not a second
 * suite (ADR-0020). `@etherfold/state-store-conformance` asks a backend small,
 * hand-written questions whose failures are readable; this asks the one question
 * a hand-written case cannot ask, which is whether 31,332 real events out of a
 * launched game still land on the state that game's own processor computed.
 *
 * Three properties make it worth the fixture's weight:
 *
 * - **The expected state is not ours.** It was computed by the stratagems
 *   `JSProcessor` (commit `3d5a0b3f`), which is the code that has actually been
 *   running on Base. An expected value we wrote ourselves would prove nothing.
 *   It is FROZEN rather than recomputable: the driver that could re-run that
 *   processor went with the free-form authoring path (ADR-0037), so what is
 *   compared against is the committed file.
 * - **The input is fixed.** No node is in the loop: the stream is a committed
 *   capture with its provenance, so two backends cannot be compared on different
 *   bytes and a rerun a year from now sees the same events.
 * - **It is big enough to be surprising.** Ten of thirteen handlers fire, the
 *   placement window takes 100 arrivals and keeps 7, so the eviction cascade runs
 *   93 times; 16,046 of the events write nothing but u256 fields; and the revert
 *   case is a real accumulated counter going back DOWN.
 */
import {expect} from 'vitest';
import {openForWriting, type StateStoreBackend, type WritableStateStore} from '@etherfold/processor-entities';
import type {EntityDeclaration} from '@etherfold/state-store';
import * as fs from 'node:fs';
import {canonical, firstDifferences, loadStream, type WorkloadFixture} from './fixtures.js';
import {stratagemsProcessor} from './processor.js';
import {projectToData} from './project.js';
import {replayIntoStore, type ReplayReport} from './replay.js';

/**
 * How the workload gets a store, matching `StateStoreFactory` in the conformance
 * suite so that a backend that already runs the suite runs this by reusing the
 * factory it wrote.
 */
export type WorkloadStoreFactory = (
	declarations: readonly EntityDeclaration[],
) => StateStoreBackend | Promise<StateStoreBackend>;

export type WorkloadRun = {
	readonly store: WritableStateStore;
	readonly report: ReplayReport;
	/** The projected state, canonicalised, ready to compare against the golden text. */
	readonly state: string;
	/** The committed golden state's text, as it is on disk. */
	readonly golden: string;
};

/**
 * Replay a fixture into a fresh store and project the result back.
 *
 * The store is left OPEN and at its tip so a caller can go on asking it things:
 * the reorg case reverts it, and an as-of case would read from it.
 */
export async function runWorkload(factory: WorkloadStoreFactory, fixture: WorkloadFixture): Promise<WorkloadRun> {
	// CLAIMED: the workload FOLDS, and the ability to mutate is obtained by claiming
	// (ADR-0077). `openForWriting` migrates on the way, which is the whole of the open.
	const store = await openForWriting(await factory(stratagemsProcessor.entities));

	const stream = loadStream(fixture);
	const report = await replayIntoStore(store, stratagemsProcessor, stream.eventStream);
	const state = canonical(await projectToData(store, report.touched));
	const golden = fs.readFileSync(fixture.goldenStatePath, 'utf-8');

	return {store, report, state, golden};
}

/**
 * Assert the run landed on the golden state, with a failure a human can read.
 *
 * A raw `expect(state).toBe(golden)` on 620 KB of JSON is a wall of text that
 * says nothing, so what is compared is the golden text against EITHER itself or
 * a short report of where the two first diverge. A diff on the GOLDEN file,
 * meanwhile, is not a fixture to update but a finding: it means the processor
 * changed meaning.
 */
export function expectGoldenState(run: WorkloadRun, fixture: WorkloadFixture): void {
	const summary =
		run.state === run.golden
			? run.golden
			: `${fixture.name}: this backend computed a state the original JSProcessor did not.\n` +
				firstDifferences(run.golden, run.state).join('\n');

	expect(summary).toBe(run.golden);
}

/** The events and blocks the fixture claims, so a silently-truncated capture fails here. */
export function expectFixtureShape(run: WorkloadRun, fixture: WorkloadFixture): void {
	expect({events: run.report.events, blocks: run.report.blocks}).toEqual({
		events: fixture.events,
		blocks: fixture.blocks,
	});
}
