import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test, type BrowserContext, type Page} from '@playwright/test';
import {mountHarness} from './harness.js';
import {BRANCH_A_TIP, EXPECTED_A} from './workload.js';

/**
 * ONE TAB INDEXES AND THE OTHERS READ, in REAL tabs (ADR-0097).
 *
 * The election is the engine's own `navigator.locks`, never a mock: every claim
 * here is about what a browser does to a lock when a tab CLOSES, CRASHES or has
 * its worker KILLED, which is exactly what a mocked lock cannot say. The node
 * suite (`test/oneTabIndexesAndTheOthersRead.test.ts`) asserts the same seats and
 * the same handover on every commit over node's own `navigator.locks`.
 *
 * Each tab's chain is its OWN fixture chain held above block 103, so a leader
 * stops part way and the tab that takes over has something to index: "no gap" is
 * then its first request starting at or below 104 (the block after the leader's
 * last recorded one) and the state it lands on being the whole fold.
 *
 * The CRASH is a KILLED WORKER: `Worker.terminate()` ends the scope holding the
 * lock with no chance to clean up, on every engine. A main-thread tab cannot be
 * crashed that way from a test on every engine, and Chromium's own `Page.crash`
 * takes down every same-origin tab sharing the renderer process, the survivors
 * included, so it cannot show a handover either.
 *
 * A BACKGROUNDED LEADER is emulated rather than produced: several pages of one
 * context are all visible to a headless browser, so a tab is sent to the
 * background by overriding `document.visibilityState` and dispatching
 * `visibilitychange` (`election-visibility`), which is the whole of what the host
 * reads. The lock the visible tab then takes with `steal` is the engine's own.
 *
 * Deliberately not part of `pnpm test` (this package's convention): it needs
 * `playwright install`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CUT = path.join(HERE, 'cut.ts');
const WORKER = path.join(HERE, 'indexer.worker.ts');
/** Where a held leader stops: its fold records 100..103 and asks for nothing above. */
const HELD_AT = 103;

/** The foreground takeover's settle time in these runs (the default is two seconds). */
const SETTLE_MS = 300;

type Report = {
	seat: {
		name: string;
		role: string;
		tookOver: boolean;
		takeoverReason?: string;
		displaced?: boolean;
		visibility?: string;
	} | null;
	demotion: string | null;
	calls: number;
	ranges: {from: number; to: number}[];
	progress: {phase: string; lastToBlock: number | null; latestBlock: number | null; blocksBehindTip: number | null};
	state: typeof EXPECTED_A;
};

function tag(): string {
	return `election-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type Tab = {
	page: Page;
	run: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
	dispose: () => Promise<void>;
};

/** N tabs of ONE app on ONE origin: one build, one server, a page each. */
async function openTabs(context: BrowserContext, count: number): Promise<Tab[]> {
	const tabs: Tab[] = [];
	for (let index = 0; index < count; index++) {
		const page = await context.newPage();
		const first = tabs[0];
		const harness = await mountHarness(page, {
			cut: CUT,
			worker: WORKER,
			coi: false,
			...(first
				? {
						prebuilt: {
							outdir: (first as unknown as {outdir: string}).outdir,
							serverUrl: (first as unknown as {serverUrl: string}).serverUrl,
						},
					}
				: {}),
		});
		const tab = {
			page,
			outdir: harness.outdir,
			serverUrl: harness.serverUrl,
			async run(params: Record<string, unknown>) {
				const outcome = await harness.run({phase: 'once', params});
				expect(outcome.errors).toEqual([]);
				return outcome.results;
			},
			dispose: () => harness.dispose(),
		};
		tabs.push(tab);
	}
	return tabs;
}

async function report(tab: Tab): Promise<Report> {
	return (await tab.run({case: 'election-report'})) as unknown as Report;
}

async function disposeAll(tabs: Tab[], context: BrowserContext): Promise<void> {
	// Guests first: the first tab owns the build directory the others are served from.
	for (const tab of [...tabs].reverse()) await tab.dispose().catch(() => undefined);
	await context.close();
}

test('main-thread tabs: one fetches, all read alike, readers render progress, and closing the leader hands over with no gap', async ({
	browser,
}) => {
	const context = await browser.newContext();
	const tabs = await openTabs(context, 4);
	const [leader, second, third, nextDoor] = tabs as [Tab, Tab, Tab, Tab];
	const run = tag();
	try {
		// The FIRST tab finds the lock free, leads, and stops at the hold.
		expect((await leader.run({case: 'election-main-open', tag: run, holdAbove: HELD_AT})).seat).toMatchObject({
			role: 'writer',
			tookOver: false,
		});
		for (const tab of [second, third]) {
			expect((await tab.run({case: 'election-main-open', tag: run})).seat).toMatchObject({role: 'reader'});
		}
		// ANOTHER APP on this origin, under its own election name: it never contends.
		expect((await nextDoor.run({case: 'election-main-open', tag: run, app: 'next-door'})).seat).toMatchObject({
			role: 'writer',
		});

		// EXACTLY ONE FETCHES, and every tab answers reads identically, readers rendering
		// the leader's progress.
		await expect.poll(async () => (await report(leader)).progress.lastToBlock, {timeout: 30_000}).toBe(HELD_AT);
		const led = await report(leader);
		expect(led.calls).toBeGreaterThan(0);
		for (const tab of [second, third]) {
			await expect.poll(async () => (await report(tab)).progress.lastToBlock, {timeout: 30_000}).toBe(HELD_AT);
			const read = await report(tab);
			expect(read.calls).toBe(0);
			expect(read.seat).toMatchObject({role: 'reader', tookOver: false});
			expect(read.progress.blocksBehindTip).toBe(BRANCH_A_TIP - HELD_AT);
			expect(read.state).toEqual(led.state);
		}

		// THE LEADER CLOSES. A remaining tab takes over without a reload and indexes
		// forward from the stored cursor.
		await leader.page.close();
		const survivors = [second, third];
		await expect
			.poll(
				async () => (await Promise.all(survivors.map(report))).filter((one) => one.seat?.role === 'writer').length,
				{
					timeout: 30_000,
				},
			)
			.toBe(1);
		const reports = await Promise.all(survivors.map(report));
		const takerTab = survivors[reports.findIndex((one) => one.seat?.role === 'writer')]!;
		expect(reports.find((one) => one.seat?.role === 'writer')!.seat).toMatchObject({tookOver: true});
		// The seat is announced before the new leader's first fetch: wait for that fetch.
		await expect.poll(async () => (await report(takerTab)).ranges.length, {timeout: 30_000}).toBeGreaterThan(0);
		expect((await report(takerTab)).ranges[0]!.from).toBeLessThanOrEqual(HELD_AT + 1);
		for (const tab of survivors) {
			await expect.poll(async () => (await report(tab)).state, {timeout: 30_000}).toEqual(EXPECTED_A);
		}
		// ...and the tab that did not take over still fetched nothing.
		expect(reports.filter((one) => one.seat?.role === 'reader').every((one) => one.calls === 0)).toBe(true);
	} finally {
		await disposeAll(tabs, context);
	}
});

test('a dedicated-worker host per tab: the lock is held in the worker, and KILLING it hands over', async ({
	browser,
}) => {
	const context = await browser.newContext();
	const tabs = await openTabs(context, 3);
	const [leader, second, third] = tabs as [Tab, Tab, Tab];
	const run = tag();
	try {
		await leader.run({case: 'election-worker-open', tag: run, holdAbove: HELD_AT});
		await expect.poll(async () => (await report(leader)).seat?.role, {timeout: 30_000}).toBe('writer');
		await second.run({case: 'election-worker-open', tag: run});
		await third.run({case: 'election-worker-open', tag: run});

		await expect.poll(async () => (await report(leader)).progress.lastToBlock, {timeout: 30_000}).toBe(HELD_AT);
		const led = await report(leader);
		for (const tab of [second, third]) {
			await expect.poll(async () => (await report(tab)).progress.lastToBlock, {timeout: 30_000}).toBe(HELD_AT);
			const read = await report(tab);
			expect(read.seat).toMatchObject({role: 'reader'});
			expect(read.calls).toBe(0);
			expect(read.state).toEqual(led.state);
		}

		// NOT a clean close: the worker holding the lock is terminated.
		await leader.run({case: 'election-worker-kill'});
		const survivors = [second, third];
		await expect
			.poll(
				async () => (await Promise.all(survivors.map(report))).filter((one) => one.seat?.role === 'writer').length,
				{
					timeout: 30_000,
				},
			)
			.toBe(1);
		const reports = await Promise.all(survivors.map(report));
		const takerTab = survivors[reports.findIndex((one) => one.seat?.role === 'writer')]!;
		expect(reports.find((one) => one.seat?.role === 'writer')!.seat).toMatchObject({tookOver: true});
		// The seat is announced before the new leader's first fetch: wait for that fetch.
		await expect.poll(async () => (await report(takerTab)).ranges.length, {timeout: 30_000}).toBeGreaterThan(0);
		expect((await report(takerTab)).ranges[0]!.from).toBeLessThanOrEqual(HELD_AT + 1);
		for (const tab of survivors) {
			await expect.poll(async () => (await report(tab)).state, {timeout: 30_000}).toEqual(EXPECTED_A);
		}
	} finally {
		await disposeAll(tabs, context);
	}
});

test('ONE store constructor (`stateFactoriesFrom`) in a worker entry: the first tab writes, the second reads its rows, and takes over when the leader CLOSES', async ({
	browser,
}) => {
	const context = await browser.newContext();
	const tabs = await openTabs(context, 2);
	const [leader, second] = tabs as [Tab, Tab];
	const run = tag();
	try {
		await leader.run({case: 'election-worker-open', tag: run, holdAbove: HELD_AT, helper: true});
		await expect.poll(async () => (await report(leader)).seat?.role, {timeout: 30_000}).toBe('writer');
		await second.run({case: 'election-worker-open', tag: run, helper: true});

		await expect.poll(async () => (await report(leader)).progress.lastToBlock, {timeout: 30_000}).toBe(HELD_AT);
		const led = await report(leader);
		await expect.poll(async () => (await report(second)).progress.lastToBlock, {timeout: 30_000}).toBe(HELD_AT);
		const read = await report(second);
		expect(read.seat).toMatchObject({role: 'reader'});
		expect(read.calls).toBe(0);
		// the reader's read surface answers the rows the LEADER wrote, so both opened one database
		expect(read.state).toEqual(led.state);
		expect(read.state.transfers).toBeGreaterThan(0);

		// A CLEAN CLOSE of the leader's tab, which takes its worker and its lock with it.
		await leader.page.close();
		await expect.poll(async () => (await report(second)).seat?.role, {timeout: 30_000}).toBe('writer');
		expect((await report(second)).seat).toMatchObject({tookOver: true, takeoverReason: 'leader-gone'});
		await expect.poll(async () => (await report(second)).ranges.length, {timeout: 30_000}).toBeGreaterThan(0);
		expect((await report(second)).ranges[0]!.from).toBeLessThanOrEqual(HELD_AT + 1);
		await expect.poll(async () => (await report(second)).state, {timeout: 30_000}).toEqual(EXPECTED_A);
	} finally {
		await disposeAll(tabs, context);
	}
});

test('two tabs that both believe they lead leave the store correct, the loser demoting as today', async ({browser}) => {
	const context = await browser.newContext();
	const tabs = await openTabs(context, 2);
	const [elected, rogue] = tabs as [Tab, Tab];
	const run = tag();
	try {
		// The elected tab leads, folds to the tip and goes on cycling there (a cycle at
		// the tip still writes its cursor, which is where a refusal is met).
		await elected.run({case: 'election-main-open', tag: run});
		await expect.poll(async () => (await report(elected)).progress.lastToBlock, {timeout: 30_000}).toBe(BRANCH_A_TIP);
		// A tab that believes it leads WITHOUT the lock (no election at all): it claims
		// the same store and folds to the tip.
		await rogue.run({case: 'election-main-open', tag: run, noElection: true});
		await expect.poll(async () => (await report(rogue)).state, {timeout: 30_000}).toEqual(EXPECTED_A);
		// The elected tab's next write is refused and it DEMOTES; nothing is corrupted.
		await expect.poll(async () => (await report(elected)).demotion, {timeout: 30_000}).toBe('write-refused');
		expect((await report(elected)).state).toEqual(EXPECTED_A);
		expect((await report(rogue)).demotion).toBeNull();
	} finally {
		await disposeAll(tabs, context);
	}
});

/**
 * A VISIBLE TAB TAKES THE LEASE FROM A BACKGROUNDED LEADER (ADR-0097, D4 as
 * amended), on both hosting shapes a tab elects with: the leader is held part way
 * (as a throttled tab is), goes to the background, a reader comes forward past the
 * settle time and takes the lease, and indexes on from the stored cursor.
 */
for (const shape of ['main', 'worker'] as const) {
	test(`${shape === 'main' ? 'main-thread tabs' : 'a dedicated-worker host per tab'}: a reader made visible past the settle time takes the lease from a hidden leader, with no gap`, async ({
		browser,
	}) => {
		const context = await browser.newContext();
		const tabs = await openTabs(context, 2);
		const [leader, reader] = tabs as [Tab, Tab];
		const run = tag();
		const open = `election-${shape}-open`;
		try {
			await leader.run({case: open, tag: run, holdAbove: HELD_AT, settleMs: SETTLE_MS, visibility: 'visible'});
			await expect.poll(async () => (await report(leader)).seat?.role, {timeout: 30_000}).toBe('writer');
			await reader.run({case: open, tag: run, settleMs: SETTLE_MS, visibility: 'hidden'});
			await expect.poll(async () => (await report(leader)).progress.lastToBlock, {timeout: 30_000}).toBe(HELD_AT);
			await expect.poll(async () => (await report(reader)).progress.lastToBlock, {timeout: 30_000}).toBe(HELD_AT);
			// A HIDDEN READER never takes it, however long it waits.
			await reader.page.waitForTimeout(SETTLE_MS * 3);
			expect((await report(reader)).seat).toMatchObject({role: 'reader'});
			expect((await report(reader)).calls).toBe(0);

			// THE USER SWITCHES TABS.
			await leader.run({case: 'election-visibility', visibility: 'hidden'});
			await reader.run({case: 'election-visibility', visibility: 'visible'});

			await expect.poll(async () => (await report(reader)).seat?.role, {timeout: 30_000}).toBe('writer');
			const taker = await report(reader);
			expect(taker.seat).toMatchObject({tookOver: true, takeoverReason: 'leader-backgrounded', visibility: 'visible'});
			await expect.poll(async () => (await report(leader)).seat?.role, {timeout: 30_000}).toBe('reader');
			const stepped = await report(leader);
			expect(stepped.seat).toMatchObject({displaced: true, visibility: 'hidden'});
			if (shape === 'main') expect(stepped.demotion).toBe('lease-lost');
			const callsAtHandover = stepped.calls;

			// NO GAP: the new leader starts at or below the block after the one the old
			// leader recorded, and both tabs land on the whole fold.
			await expect.poll(async () => (await report(reader)).ranges.length, {timeout: 30_000}).toBeGreaterThan(0);
			expect((await report(reader)).ranges[0]!.from).toBeLessThanOrEqual(HELD_AT + 1);
			for (const tab of [reader, leader]) {
				await expect.poll(async () => (await report(tab)).state, {timeout: 30_000}).toEqual(EXPECTED_A);
			}
			await expect.poll(async () => (await report(leader)).progress.lastToBlock, {timeout: 30_000}).toBe(BRANCH_A_TIP);
			// ...and the old leader asked the chain for nothing after it stepped down.
			await leader.page.waitForTimeout(500);
			expect((await report(leader)).calls).toBe(callsAtHandover);
		} finally {
			await disposeAll(tabs, context);
		}
	});
}
