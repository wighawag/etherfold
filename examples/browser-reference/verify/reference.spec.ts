import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {expect, test, type APIRequestContext, type Page} from '@playwright/test';
import {installFakeWallet, type FakeChainOptions} from './wallet.js';

/**
 * The reference, DRIVEN in a real browser.
 *
 * This exists because of what it caught the last time: two bugs in this
 * repository's other browser example were written, reviewed, and BUILT GREEN,
 * and were found only by driving a real Chromium. Type-checking would have
 * caught neither (ADR-0030). So every claim `browser/main.ts` makes in a comment
 * is asserted here against the running page, and the two that are hazards get
 * the hostile version of the test rather than the happy one.
 *
 * Nothing here needs a network: the wallet announces itself over EIP-6963 and
 * serves a fixed set of logs, both injected before the app loads.
 */

const APP_CHAIN = 1;

/** What the page exposes on `window.__reference`, as far as these tests reach into it. */
type Reference = {
	indexer: {
		progress(): Promise<{
			host: string;
			scope: string;
			phase: string;
			election?: {name: string; role: string; tookOver: boolean; takeoverReason?: string};
			hotUpdate?: {count: number; report: {outcome: string; generation?: {processor: string}}};
		}>;
		generations(): Promise<{record: {stream: string; processor: string}; canonical: boolean}[]>;
		checkTxInclusion(q: {txHash: string}[]): Promise<Record<string, {status: string; basis: string}>>;
	};
	onRedeploy(next: unknown): Promise<{stream: string}>;
	holders(
		min: number,
		at?: string,
	): Promise<{
		data?: {account: {address: string; holds: number; holdings: {id: string}[]}[]};
		errors?: {message: string; extensions?: {code?: string}}[];
		extensions?: {generation: string; block: number | null; blockHash: string | null};
	}>;
};

/** The two accounts the fake chain mints to, alternately (`verify/wallet.ts`). */
const ALICE = '0x0000000000000000000000000000000000000011';
const BOB = '0x0000000000000000000000000000000000000022';

async function open(page: Page, options: Partial<FakeChainOptions> = {}) {
	const settings: FakeChainOptions = {walletChainId: APP_CHAIN, transfers: 5, tipBlock: 10, ...options};
	await page.addInitScript(installFakeWallet, settings);
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(String(error)));
	await page.goto('/');
	return {errors, settings};
}

test('indexes the contract and publishes the result as stores', async ({page}) => {
	const {errors} = await open(page);

	await expect(page.locator('#transfers')).toHaveText('5');
	await expect(page.locator('#progress')).toContainText('block 10 / 10');
	await expect(page.locator('#error')).toBeEmpty();
	expect(errors).toEqual([]);
});

/**
 * THE WORKER SHAPE (ADR-0082): the fold runs in a dedicated worker, and the chain
 * it reads is the WALLET's, handed over as a port.
 *
 * Both halves are asserted as facts rather than inferred from timing. Where the
 * fold runs is what the host MEASURES (`progress().scope`, which is what
 * `globalThis` is where the answer was computed). And the wallet lives in the
 * page, which a worker has no way to reach, so every `eth_getLogs` the page's
 * wallet answered was a request the worker made through the port this tab
 * serves the wallet's provider on.
 */
test('indexes in a dedicated worker, through the wallet handed over as a port', async ({page}) => {
	const {errors} = await open(page);
	await expect(page.locator('#transfers')).toHaveText('5');

	const {progress, requests} = await page.evaluate(async () => {
		const app = (window as never as {__reference: Reference}).__reference;
		return {progress: await app.indexer.progress(), requests: window.__walletRequests};
	});

	expect(progress.host).toBe('dedicated-worker');
	expect(progress.scope).toBe('DedicatedWorkerGlobalScope');
	expect(requests['eth_getLogs'] ?? 0).toBeGreaterThan(0);
	expect(errors).toEqual([]);
});

/**
 * THE QUERY LAYER (ADR-0099): one GraphQL document, answered by the WORKER.
 *
 * The page's own document is run (`holders` in `main.ts`), so what is asserted
 * is the wiring a template copies: `graphqlQueryHandler()` in the worker entry,
 * `workerExecutor(indexer)` in the tab. It is the shape the read surface cannot
 * express: a FILTER on a declared field, an ORDER on it, and a NESTED relation
 * (an account's holdings), in one round trip, pinned to one block.
 *
 * The fake chain mints tokens 1 to 5 to two accounts in turn, so Alice holds
 * three and Bob two: ordered by holdings, Alice comes first, and a filter at
 * three leaves only her. The answer is compared whole, because what crosses the
 * port is exactly what a server's `/graphql` would answer for the same document.
 */
test('answers a GraphQL query from its worker: filtered, ordered, with a nested relation', async ({page}) => {
	const {errors} = await open(page);
	await expect(page.locator('#transfers')).toHaveText('5');

	// the page renders it, and re-queries it when the state moves
	await expect(page.locator('#holders')).toHaveText(`${ALICE}: 3 (1, 3, 5)\n${BOB}: 2 (2, 4)`);

	const {everyone, filtered} = await page.evaluate(async () => {
		const app = (window as never as {__reference: Reference}).__reference;
		return {everyone: await app.holders(1), filtered: await app.holders(3)};
	});

	expect(everyone.errors).toBeUndefined();
	expect(everyone.data).toEqual({
		account: [
			{address: ALICE, holds: 3, holdings: [{id: '1'}, {id: '3'}, {id: '5'}]},
			{address: BOB, holds: 2, holdings: [{id: '2'}, {id: '4'}]},
		],
	});
	// which generation answered, and the one block every field was read as of
	expect(typeof everyone.extensions?.generation).toBe('string');
	expect(everyone.extensions?.block).toBeGreaterThanOrEqual(5);

	expect(filtered.data).toEqual({account: [{address: ALICE, holds: 3, holdings: [{id: '1'}, {id: '3'}, {id: '5'}]}]});
	expect(errors).toEqual([]);
});

/**
 * THE SIGNAL NAMES THE BLOCK'S HASH, AND THE RE-READ IS PINNED TO IT (ADR-0083,
 * amended 2026-09-30).
 *
 * The fake chain's last event-bearing block is 5, so that is the last block the
 * state-moved signal named, and the page shows its number AND its hash. The hash
 * is the one the store recorded, which is the one `extensions.blockHash` names
 * for an answer read while that block is the tip: the page's own document pinned to it
 * answers from exactly that block, and pinned to a hash the store never recorded
 * (a block a reorg replaced) it is REFUSED rather than answered from another.
 */
test('names the applied block by its hash, and the GraphQL re-read pinned to it answers from that block', async ({
	page,
}) => {
	const {errors} = await open(page);
	await expect(page.locator('#transfers')).toHaveText('5');

	const hashOf5 = `0x${'5'.padStart(64, '0')}`;
	await expect(page.locator('#moved')).toHaveText(`block 5, ${hashOf5}`);

	const {pinned, replaced} = await page.evaluate(async (hash) => {
		const app = (window as never as {__reference: Reference}).__reference;
		return {pinned: await app.holders(1, hash), replaced: await app.holders(1, `0x${'b'.repeat(64)}`)};
	}, hashOf5);

	expect(pinned.errors).toBeUndefined();
	expect(pinned.extensions).toMatchObject({block: 5, blockHash: hashOf5});
	expect(pinned.data?.account.map(({address, holds}) => ({address, holds}))).toEqual([
		{address: ALICE, holds: 3},
		{address: BOB, holds: 2},
	]);
	expect(replaced.errors?.[0]?.extensions?.code).toBe('block-not-recorded');
	expect(errors).toEqual([]);
});

/**
 * ONE TAB INDEXES AND THE OTHERS READ (ADR-0097), with both seats derived from
 * ONE store constructor (`stateFactoriesFrom` in `browser/indexer.worker.ts`).
 *
 * The second tab's worker finds the election's lock held and is built as a
 * READER of the database the first tab's worker writes: it asks its wallet for
 * no logs, and yet its read surface and its GraphQL answer the leader's rows,
 * which they can only do if the two seats opened one database. When the leading
 * tab CLOSES, the browser releases the lock and the reader takes over.
 */
test("a second tab reads the leader's rows through its read surface and GraphQL, and takes over when the leader closes", async ({
	context,
}) => {
	const first = await context.newPage();
	const second = await context.newPage();
	const leader = await open(first);
	await expect(first.locator('#transfers')).toHaveText('5');
	const reader = await open(second);

	const seatOf = (page: Page) =>
		page.evaluate(
			async () => (await (window as never as {__reference: Reference}).__reference.indexer.progress()).election,
		);
	await expect.poll(() => seatOf(first)).toMatchObject({role: 'writer'});
	await expect.poll(() => seatOf(second)).toMatchObject({role: 'reader', tookOver: false});

	// the read surface, rendered by the reader tab...
	await expect(second.locator('#transfers')).toHaveText('5');

	// THE LEADER APPLIES A BLOCK the reader hears about. It has to: this app runs its
	// processor as a MODULE, whose generation is named only once the fold is built,
	// which a reader never does, so a reader that joined a QUIET chain cannot name the
	// generation its answers belong to until the leader's state-moved signal names it
	// (`readerGenerationOf`, `@etherfold/browser`), and refuses a query until then.
	// Both pages' wallets are the one chain, so the block is minted on each.
	await second.evaluate(() => window.__mint());
	await first.evaluate(() => window.__mint());
	await expect(second.locator('#transfers')).toHaveText('6');

	// ...and GraphQL, answered by the reader's worker from the store the leader wrote
	const answered = await second.evaluate(async () => {
		const app = (window as never as {__reference: Reference}).__reference;
		return {holders: await app.holders(3), requests: window.__walletRequests};
	});
	expect(answered.holders.errors).toBeUndefined();
	const byAddress = [...(answered.holders.data?.account ?? [])].sort((a, b) => a.address.localeCompare(b.address));
	expect(byAddress).toEqual([
		{address: ALICE, holds: 3, holdings: [{id: '1'}, {id: '3'}, {id: '5'}]},
		{address: BOB, holds: 3, holdings: [{id: '2'}, {id: '4'}, {id: '6'}]},
	]);
	// a reader fetches nothing: every log it reads, the leader fetched
	expect(answered.requests['eth_getLogs'] ?? 0).toBe(0);

	await first.close();
	await expect
		.poll(() => seatOf(second))
		.toMatchObject({role: 'writer', tookOver: true, takeoverReason: 'leader-gone'});
	const after = await second.evaluate(async () => (window as never as {__reference: Reference}).__reference.holders(3));
	expect(after.errors).toBeUndefined();
	expect(after.data?.account).toHaveLength(2);
	expect(leader.errors).toEqual([]);
	expect(reader.errors).toEqual([]);
});

/**
 * HAZARD 1, the hostile version: the ALREADY-SETTLED path.
 *
 * A single announced wallet is auto-selected, so the connection has settled
 * before `waitForWallet` subscribes and the callback runs SYNCHRONOUSLY inside
 * `subscribe()`. Writing `const unsubscribe = connection.subscribe(...)` and
 * calling `unsubscribe` from the callback throws a temporal dead zone error on
 * exactly this path -- and only on this path, which is why a human clicking
 * through a picker never sees it.
 *
 * The assertion that matters is `errors`: an uncaught TDZ throw inside the
 * subscription surfaces as a `pageerror` while the page still looks half-alive.
 */
test('survives the already-settled wallet path, which is where the TDZ bug lived', async ({page}) => {
	const {errors} = await open(page);

	await expect(page.locator('#transfers')).toHaveText('5');
	expect(errors.filter((e) => e.includes('before initialization'))).toEqual([]);
	expect(errors).toEqual([]);
});

/**
 * HAZARD 2, the hostile version: a wallet on the WRONG chain.
 *
 * The pinned `connection.provider` answers `eth_chainId` with the app's own
 * chain whatever the wallet is set to, so an app that checks the provider passes
 * this and indexes a chain-1 address against a chain-137 node. An app that asks
 * the CONNECTION STATE refuses.
 *
 * This test is the difference between the two, and it is the one that would have
 * failed on the code that shipped.
 */
test('refuses a wallet on another chain, which the pinned provider cannot detect', async ({page}) => {
	await open(page, {walletChainId: 137});

	await expect(page.locator('#error')).toContainText('wallet is on chain 137');
	// and it refused rather than indexing the wrong chain quietly
	await expect(page.locator('#transfers')).toHaveText('0');
});

/**
 * AXIS TWO: a redeploy at the SAME address with a regenerated ABI.
 *
 * Driven through the app's own `onRedeploy`, so what runs is the wiring a
 * template would copy, not a re-implementation of it in the test.
 *
 * Across the port a reconfigure is not an outage: the new source is a new
 * generation folding BESIDE the live one, which goes on answering, and the
 * canonical pointer moves to it once it has caught up (`on-catch-up`, the
 * default). So what is asserted is the new generation becoming the one that
 * answers, with the count it re-indexed from the start block.
 */
test('a new ABI at the same address re-indexes beside the live state, then answers', async ({page}) => {
	const {errors} = await open(page);
	await expect(page.locator('#transfers')).toHaveText('5');

	const {reload, stream} = await page.evaluate(async () => {
		const app = (window as never as {__reference: Reference}).__reference;
		// the ABI a redeployed implementation generates: same address, one more event
		const abiV2 = [
			{
				type: 'event',
				name: 'Transfer',
				anonymous: false,
				inputs: [
					{indexed: true, name: 'from', type: 'address'},
					{indexed: true, name: 'to', type: 'address'},
					{indexed: false, name: 'id', type: 'uint256'},
				],
			},
			{
				type: 'event',
				name: 'Approval',
				anonymous: false,
				inputs: [
					{indexed: true, name: 'owner', type: 'address'},
					{indexed: true, name: 'approved', type: 'address'},
					{indexed: true, name: 'id', type: 'uint256'},
				],
			},
		];
		const added = await app.onRedeploy({
			abi: abiV2,
			address: '0x0000000000000000000000000000000000000099',
			startBlock: 0,
		});
		return {reload: document.getElementById('reload')?.textContent ?? '', stream: added.stream};
	});

	expect(reload).toContain('re-indexing from the start block beside the live state');

	// the new generation catches up and becomes the one answering reads
	await expect
		.poll(async () =>
			page.evaluate(async () => {
				const app = (window as never as {__reference: Reference}).__reference;
				return (await app.indexer.generations()).find((generation) => generation.canonical)?.record.stream;
			}),
		)
		.toBe(stream);
	// and it answers the same count, re-indexed from the start block under the new source
	await expect(page.locator('#transfers')).toHaveText('5');
	expect(errors).toEqual([]);
});

/**
 * THE FINALITY PAIRING: `checkTxInclusion`, and the direction that is safe.
 *
 * The transaction is one the fake chain really emitted, in a block inside the
 * unconfirmed window, so the verdict is a `window-hit` -- the only basis that
 * does not depend on any chain view but the indexer's own.
 */
test('says whether the indexed state already accounts for a transaction', async ({page}) => {
	await open(page);
	await expect(page.locator('#transfers')).toHaveText('5');

	const verdicts = await page.evaluate(() => {
		const app = (window as never as {__reference: Reference}).__reference;
		return app.indexer.checkTxInclusion([
			// block 5, which the fake chain emitted and the indexer has processed
			{txHash: `0x${(5).toString(16).padStart(64, '0')}`},
			// a transaction that emitted nothing this indexer watches
			{txHash: `0x${'ff'.repeat(32)}`},
		]);
	});

	const included = verdicts[`0x${(5).toString(16).padStart(64, '0')}`];
	expect(included.status).toBe('included');
	expect(included.basis).toBe('window-hit');

	// The documented limit, asserted rather than described: a transaction that
	// emitted no indexed event can never hit, so `absent` here means "not in the
	// window" and NOT "did not happen".
	expect(verdicts[`0x${'ff'.repeat(32)}`].status).toBe('absent');
});

/**
 * AXIS ONE: an edited processor, taken by the WORKER without a page reload, and
 * folded BESIDE the live state.
 *
 * The edit is a real one: `src/processor.ts` is rewritten on disk, the dev server
 * the run is served from sees it, and what reaches the worker is whatever Vite's
 * HMR delivers (put back afterwards, whatever happens). So every link is the
 * shipped one: the worker entry's own `import.meta.hot.accept`, the host's
 * `reconfigureFromHotUpdate`, the verdict on the progress push, and the tab's own
 * accept that keeps the save from reloading the page.
 *
 * Asserted as facts: the page is the SAME page (a marker set from outside it
 * survives), the tab was told `registered`, the generation that answers becomes
 * the one the verdict named, the count is the edited handler's, and the number on
 * screen never went below the incumbent's while the edit caught up.
 *
 * And it leaves the server as it found it: the test does not end until the dev
 * server serves the unedited processor again (`restoreProcessor`), so a later
 * page in the same run is not handed the edit.
 */
test('an edited processor is swapped in by the worker, beside the live state, without a reload', async ({
	page,
	request,
}) => {
	const processorFile = fileURLToPath(new URL('../src/processor.ts', import.meta.url));
	const original = readFileSync(processorFile, 'utf8');
	const edited = original.replace(UNEDITED_HANDLER, '(counter?.value ?? 0) + 2');
	expect(edited).not.toBe(original);

	const {errors} = await open(page);
	await expect(page.locator('#transfers')).toHaveText('5');
	const incumbent = await page.evaluate(async () => {
		const app = (window as never as {__reference: Reference}).__reference;
		return (await app.indexer.generations()).find((generation) => generation.canonical)?.record.processor;
	});
	// A reload would lose both of these.
	await page.evaluate(() => {
		const shown: string[] = [];
		new MutationObserver(() => shown.push(document.getElementById('transfers')?.textContent ?? '')).observe(
			document.getElementById('transfers')!,
			{childList: true, characterData: true, subtree: true},
		);
		Object.assign(window, {__survivor: 'not-reloaded', __transfersShown: shown});
	});

	let failure: {error: unknown} | undefined;
	try {
		writeFileSync(processorFile, edited);

		await expect(page.locator('#reload')).toContainText('processor edited: folding beside the live state');
		const verdict = await page.evaluate(async () => {
			const app = (window as never as {__reference: Reference}).__reference;
			return (await app.indexer.progress()).hotUpdate;
		});
		expect(verdict?.report.outcome).toBe('registered');
		expect(verdict?.report.generation?.processor).not.toBe(incumbent);

		// the edit catches up and becomes the generation that answers, under the edited handler
		await expect
			.poll(async () =>
				page.evaluate(async () => {
					const app = (window as never as {__reference: Reference}).__reference;
					return (await app.indexer.generations()).find((generation) => generation.canonical)?.record.processor;
				}),
			)
			.toBe(verdict?.report.generation?.processor);
		await expect(page.locator('#transfers')).toHaveText('10');

		const after = await page.evaluate(() => ({
			survivor: (window as never as {__survivor?: string}).__survivor,
			shown: (window as never as {__transfersShown: string[]}).__transfersShown,
		}));
		expect(after.survivor).toBe('not-reloaded');
		// NEVER A BLANK APP: the incumbent answered until the edit had caught up
		expect(after.shown.map(Number).every((value) => value >= 5)).toBe(true);
		expect(errors).toEqual([]);
	} catch (error) {
		failure = {error};
	}
	// The file is put back whatever happened; a failed wait for the server to serve
	// it again is reported only when it is not hiding the test's own failure.
	try {
		await restoreProcessor(request, processorFile, original);
	} catch (error) {
		if (!failure) throw error;
	}
	if (failure) throw failure.error;
});

/** The line of the handler the edited-processor test changes, as it is committed. */
const UNEDITED_HANDLER = '(counter?.value ?? 0) + 1';

/**
 * Put `src/processor.ts` back, and wait until the dev server SERVES it again.
 *
 * Writing the file back is not enough on its own. The edit is taken fast (the
 * restore was measured landing about 30ms after it), and the dev server's file
 * watcher drops a second change to the same file that close behind the first
 * (chokidar throttles change events per path). By then the worker has already
 * fetched the edited module, so Vite keeps that transform and serves the EDIT to
 * every later page of the run, whose `#transfers` then reads 10 instead of 5.
 *
 * So the served module is read back until it carries the unedited handler, and
 * while it does not, the (byte-identical) original is written again, which is a
 * change the watcher does see once the throttle window has passed.
 */
async function restoreProcessor(request: APIRequestContext, file: string, original: string) {
	writeFileSync(file, original);
	await expect
		.poll(
			async () => {
				const served = await (await request.get(`/@fs${file}`)).text();
				const restored = served.includes(UNEDITED_HANDLER);
				if (!restored) writeFileSync(file, original);
				return restored;
			},
			{message: 'the dev server serves the unedited src/processor.ts again', intervals: [100, 250, 500]},
		)
		.toBe(true);
}
