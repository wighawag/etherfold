import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';

/**
 * Four tabs, one database, all of them writing.
 *
 * This is a load-bearing part of why IndexedDB is the browser default rather
 * than wasm SQLite, and it is observed rather than quoted. In
 * `work/notes/findings/sqlite-in-the-browser.md`, three of four tabs FAILED AT
 * OPEN on both SQLite VFSs (`createSyncAccessHandle` on `opfs-sahpool`,
 * `SQLITE_BUSY` on `opfs`), while IndexedDB ran four of four with zero
 * mismatches. A single-tab app is a constraint an app either has or does not,
 * and most do not: a user with the app open twice is not an exotic deployment.
 *
 * Each tab owns its own block heights (a block is applied once, by definition),
 * writes its own rows, reads them back, and a fifth connection afterwards audits
 * that the one database holds exactly the rows the tabs were told they wrote.
 *
 * **What this case does and does not show, now that the store carries a writer
 * token (ADR-0075).** It still shows the thing it exists for: four tabs OPEN
 * one database and use it, where three of four SQLite tabs never got that far.
 * What it no longer shows is four tabs writing at once, because that is exactly
 * what the guard forbids -- only the tab that claimed last may write, and the
 * others are refused having written nothing. So a refusal is counted as an
 * outcome here, and what is asserted is that no tab failed for any OTHER reason
 * and that the store is coherent afterwards.
 *
 * Two refusals count as one outcome: a tab whose CLAIM was taken
 * (`StoreWriterChangedError`) and a tab offering a height the tip has already
 * passed, which is what the interleaved heights below produce as the store
 * changes hands. The second is the same news read from the other end -- a
 * store's blocks are ONE sequence, so owning a height of your own is not owning
 * a place in it.
 *
 * It is still not the CONTENTION case: every tab writes heights of its own, so
 * no two of them ever race for one height. Several tabs contending for the SAME
 * heights, with one winner per height, is the second case in this file.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '../../../docs/spikes/indexeddb-row-backend-browser-default/results');
const CUT = path.join(HERE, 'cut.ts');
const TABS = 4;
const BLOCKS = 20;
/** The contended range: every tab offers every one of these heights. */
const CONTENDED_FROM = 2_000;
const CONTENDED = 12;

/** What one tab reported: what it wrote, what it was refused, what it read back. */
type TabOutcome = {
	tab: number;
	errors: string[];
	attempted?: number;
	wrote?: number;
	/** Writes the store refused: a claim taken, or a height the tip had passed. */
	refused?: number;
	/** Anything that failed for another reason at all, which is what would be a defect. */
	unexpected?: string[];
	readBack?: number;
	mismatches?: number;
};

test('four tabs against one database complete with zero row mismatches', async ({browser}, testInfo) => {
	const tag = `multitab-${Date.now()}`;
	const context = await browser.newContext();
	const first = await context.newPage();
	const lead = await mountHarness(first, {cut: CUT, coi: false});
	const tabs = [lead];

	try {
		for (let index = 1; index < TABS; index++) {
			const page = await context.newPage();
			// the same bundle and the same server: four tabs of ONE app
			tabs.push(
				await mountHarness(page, {cut: CUT, coi: false, prebuilt: {outdir: lead.outdir, serverUrl: lead.serverUrl}}),
			);
		}

		const outcomes: TabOutcome[] = await Promise.all(
			tabs.map((harness, tab) =>
				harness
					.run({phase: 'once', params: {case: 'multi-tab', tag, tab, tabs: TABS, blocks: BLOCKS}})
					.then((run) => ({tab, errors: run.errors, ...run.results}) as TabOutcome)
					// a tab that cannot even OPEN the database is the failure mode this
					// case exists to look for, so it is recorded rather than thrown
					.catch((error) => ({tab, errors: [`${(error as Error).message}`]}) as TabOutcome),
			),
		);

		// what the tabs were TOLD they wrote, which is what the database must hold:
		// only one tab writes at a time, and a refused write wrote nothing
		const written = outcomes.reduce((total, outcome) => total + (outcome.wrote ?? 0), 0);
		const audit = await lead.run({
			phase: 'once',
			params: {case: 'multi-tab-audit', tag, tabs: TABS, blocks: BLOCKS, expected: written},
		});

		fs.mkdirSync(RESULTS, {recursive: true});
		fs.writeFileSync(
			path.join(RESULTS, `multi-tab-${testInfo.project.name}.json`),
			JSON.stringify(
				{project: testInfo.project.name, ranAt: new Date().toISOString(), tabs: outcomes, audit: audit.results},
				null,
				2,
			),
		);

		// every tab OPENED the shared database and ran, which is the claim ADR-0024
		// needs from this case and the one both SQLite VFSs failed
		expect(outcomes.filter((outcome) => (outcome.errors ?? []).length > 0)).toEqual([]);
		expect(outcomes.filter((outcome) => (outcome.unexpected ?? []).length > 0)).toEqual([]);
		for (const outcome of outcomes) {
			// a tab either wrote a block or was refused it; nothing is unaccounted for
			expect((outcome.wrote ?? 0) + (outcome.refused ?? 0)).toBe(BLOCKS);
			// and everything it was told it wrote is readable through its own connection
			expect(outcome.mismatches).toBe(0);
			expect(outcome.readBack).toBe(outcome.wrote);
		}
		// somebody made progress: a store where every writer is refused would satisfy
		// every assertion above and be useless
		expect(written).toBeGreaterThanOrEqual(BLOCKS);
		expect(audit.errors).toEqual([]);
		expect(audit.results.missing).toBe(0);
		expect(audit.results.surplus).toBe(0);
		expect(audit.results.found).toBe(written);
	} finally {
		for (const harness of tabs) await harness.dispose().catch(() => undefined);
		await context.close();
	}
});

/** What one CONTENDING tab reported: which of the shared heights it landed, and how it was refused the rest. */
type ContentionOutcome = {
	tab: number;
	errors: string[];
	attempted?: number;
	/** The contended heights this tab was TOLD it wrote. */
	won?: number[];
	refused?: number;
	/** Refusals counted BY ERROR NAME, which is what this case is asserting. */
	refusedBy?: Record<string, number>;
	/** Anything that failed for another reason at all, which is what would be a defect. */
	unexpected?: string[];
};

/** One audited height: was a block recorded there, and whose row does it carry? */
type AuditedHeight = {height: number; recorded: boolean; owner: string | null};

/**
 * Several tabs, one database, all of them offering the SAME heights.
 *
 * The case above deliberately gives each tab heights of its own, so no two of
 * them ever race for one. This is the race: four tabs of one app offer every
 * height in one range at once, against one `databaseName`, which is the
 * STORAGE the writer token is scoped to (ADR-0075) and therefore the only way
 * for two tabs to contend at all.
 *
 * It only counts HERE. `readwrite` transactions serialising across connections
 * is the primitive the guard rests on, and `fake-indexeddb` cannot demonstrate
 * it, so the node suite beside this one asserts the RULE and this run is what
 * observes it on an engine.
 *
 * Three things are asserted, and the third is the one that matters most:
 * exactly one write lands per height, every loser is refused BY NAME
 * (`StoreWriterChangedError`, not a duplicate-height error and not silence),
 * and an independent connection afterwards finds a coherent store -- no
 * half-applied block, no row from a refused writer, and a cursor that is not
 * behind its own data.
 */
test('several tabs contending for the same heights leave one winner and no torn state', async ({browser}, testInfo) => {
	const tag = `contention-${Date.now()}`;
	const context = await browser.newContext();
	const first = await context.newPage();
	const lead = await mountHarness(first, {cut: CUT, coi: false});
	const tabs = [lead];
	const heights = Array.from({length: CONTENDED}, (_, index) => CONTENDED_FROM + index);

	try {
		for (let index = 1; index < TABS; index++) {
			const page = await context.newPage();
			tabs.push(
				await mountHarness(page, {cut: CUT, coi: false, prebuilt: {outdir: lead.outdir, serverUrl: lead.serverUrl}}),
			);
		}

		// Every tab CLAIMS before any of them offers a block, and the barrier is the
		// point rather than setup: a handle that has never written claims
		// UNCONDITIONALLY on its first mutation, so a tab that arrived at the race
		// unclaimed would take the store and then be refused for offering a height
		// already recorded. That refusal is true and is not the news here -- it is
		// the duplicate-height caller bug, which means the opposite thing (see
		// `blocks.ts`). Claiming first is what makes every refusal below a LOST
		// CLAIM, which is what this case exists to observe.
		const claims = await Promise.all(
			tabs.map((harness, tab) => harness.run({phase: 'once', params: {case: 'contention-claim', tag, tab}})),
		);
		expect(claims.flatMap((claim) => claim.errors)).toEqual([]);

		const outcomes: ContentionOutcome[] = await Promise.all(
			tabs.map((harness, tab) =>
				harness
					.run({phase: 'once', params: {case: 'contention', tag, tab, from: CONTENDED_FROM, blocks: CONTENDED}})
					.then((run) => ({tab, errors: run.errors, ...run.results}) as ContentionOutcome)
					.catch((error) => ({tab, errors: [`${(error as Error).message}`]}) as ContentionOutcome),
			),
		);

		// every tab has closed its handle by now, so this is a connection that took
		// no part in the race, reading the store the race left behind
		const audit = await lead.run({
			phase: 'once',
			params: {case: 'contention-audit', tag, from: CONTENDED_FROM, blocks: CONTENDED},
		});

		fs.mkdirSync(RESULTS, {recursive: true});
		fs.writeFileSync(
			path.join(RESULTS, `contention-${testInfo.project.name}.json`),
			JSON.stringify(
				{
					project: testInfo.project.name,
					ranAt: new Date().toISOString(),
					contended: {from: CONTENDED_FROM, heights: CONTENDED, tabs: TABS},
					tabs: outcomes,
					audit: audit.results,
				},
				null,
				2,
			),
		);

		expect(outcomes.filter((outcome) => (outcome.errors ?? []).length > 0)).toEqual([]);
		expect(outcomes.filter((outcome) => (outcome.unexpected ?? []).length > 0)).toEqual([]);
		for (const outcome of outcomes) {
			expect(outcome.attempted).toBe(CONTENDED);
			// a tab either landed a height or was refused it; nothing is unaccounted for
			expect((outcome.won ?? []).length + (outcome.refused ?? 0)).toBe(CONTENDED);
			// and a loser is refused by NAME. `StoreWriterChangedError` is a lost race
			// and nothing else: not a duplicate height, not a height below the tip, not
			// a quiet no-op that would leave a tab believing it had written.
			expect(outcome.refusedBy).toEqual(outcome.refused ? {StoreWriterChangedError: outcome.refused} : {});
		}

		// EXACTLY ONE write per height: every contended height was landed, once, by
		// one tab, though which tab holds the store is the engine's business.
		const won = outcomes.flatMap((outcome) => outcome.won ?? []);
		expect([...won].sort((left, right) => left - right)).toEqual(heights);

		expect(audit.errors).toEqual([]);
		const audited = audit.results.heights as AuditedHeight[];
		const winnerOf = new Map(outcomes.flatMap((outcome) => (outcome.won ?? []).map((height) => [height, outcome.tab])));
		expect(audited.map((row) => row.height)).toEqual(heights);
		for (const row of audited) {
			// no half-applied block: the block record and the row it carried commit in
			// one transaction, so a height has both or neither
			expect(row.recorded).toBe(true);
			// and no row from a refused writer: the row at a height names the tab that
			// was told it wrote that height, and a refused write wrote nothing
			expect(row.owner).toBe(`0x${winnerOf.get(row.height)}`);
		}
		// no cursor behind its data. The cursor is opaque to the STORE (ADR-0027) and
		// this test is the caller that wrote it, so reading it back is this side's
		// business: it says which height, and by which tab, and both must be the last
		// write that landed.
		const last = heights[heights.length - 1];
		expect(audit.results.cursor).toBe(`${last}:${winnerOf.get(last)}`);
	} finally {
		for (const harness of tabs) await harness.dispose().catch(() => undefined);
		await context.close();
	}
});
