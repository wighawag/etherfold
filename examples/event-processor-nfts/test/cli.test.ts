import {prepareIndexing, run} from 'etherfold';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// ---------------------------------------------------------------------------------------------------
// THE SAME PROCESSOR, UNDER THE CLI
// ---------------------------------------------------------------------------------------------------
// `src/entities.ts` is what `browser/main.ts` runs against IndexedDB in a tab.
// This drives THAT FILE, unchanged, through `etherfold build --store sqlite`
// and through `etherfold run` into versioned rows -- which is the whole claim of
// "one processor, everywhere", checked rather than asserted. Under `run` it is
// checked against the deployment a developer actually reaches for: one process
// that follows the chain, folds, and answers HTTP.
//
// The chain is a fake node; everything above it is the shipped pipeline
// (`LogFetcher` -> `createDirectIngestion` -> `StreamBuilder` ->
// `EntityEventProcessor` -> a real libSQL database), and the processor object is
// the one the browser demo imports.
//
// ## IT RUNS FROM THE BUNDLE THIS EXAMPLE SHIPS, and that is load-bearing
//
// `--processor` names `dist/cli.bundle.js`, the artifact `pnpm build:bundle`
// produces, and NO importer is injected -- because the bytes are what a
// deployment actually reads, and because the hash of those bytes IS this
// deployment's identity (ADR-0086). This example used to hand the command a
// module object instead, which derives no identity at all, so the fold fell back
// on a `version` field in `src/entities.ts` -- the author-DECLARED identity that
// is now deleted, and an unbundled path is refused. An example is EVIDENCE, so it
// has to be evidence of the arrival a reader is being taught.
//
// The build runs as this package's `pretest`, so the bytes are there whether the
// suite is run on its own or as part of the whole tree.
// ---------------------------------------------------------------------------------------------------

/**
 * THE ARTIFACT, by absolute path, so the suite does not depend on which directory
 * the runner happened to start in.
 */
const BUNDLE = fileURLToPath(new URL('../dist/cli.bundle.js', import.meta.url));

const CONTRACT = '0x0000000000000000000000000000000000000099';
const ALICE = '0x0000000000000000000000000000000000000011';
const BOB = '0x0000000000000000000000000000000000000022';
const ZERO = '0x0000000000000000000000000000000000000000';
const START_BLOCK = 1_000_000;
const TIP = START_BLOCK + 100;

// read by `src/cli.ts` at import time -- which for a bundle is the moment the CLI
// evaluates the bytes it just read, inside `prepareIndexing` -- so the fake chain
// and the artifact agree on what is being indexed
process.env.NFT_CONTRACT = CONTRACT;
process.env.NFT_START_BLOCK = String(START_BLOCK);

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hex = (value: number | bigint) => `0x${value.toString(16)}`;
const addressTopic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

let logCounter = 0;
function log(blockNumber: number, blockHash: string, topics: string[], logIndex = 0) {
	logCounter++;
	return {
		blockNumber: hex(blockNumber),
		blockHash,
		transactionIndex: '0x0',
		removed: false,
		address: CONTRACT,
		data: '0x',
		topics,
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: hex(logIndex),
		blockTimestamp: hex(1_600_000_000 + blockNumber * 12),
	};
}

const tokenTopic = (id: bigint) => `0x${id.toString(16).padStart(64, '0')}`;

const transfer = (blockNumber: number, blockHash: string, from: string, to: string, id: bigint, logIndex = 0) =>
	log(blockNumber, blockHash, [TRANSFER_TOPIC, addressTopic(from), addressTopic(to), tokenTopic(id)], logIndex);

/**
 * An ERC-20 transfer: the SAME `topic0`, three topics instead of four.
 *
 * It is here because it is the interesting half of this example -- the decoder
 * fails rather than reading a balance as a token id, and the processor counts
 * the refusal in `handleUnparsedEvent`. That path has to work under the CLI too.
 */
const erc20Transfer = (blockNumber: number, blockHash: string, logIndex = 0) =>
	log(blockNumber, blockHash, [TRANSFER_TOPIC, addressTopic(ALICE), addressTopic(BOB)], logIndex);

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 7n),
	erc20Transfer(START_BLOCK + 10, '0xa10', 1),
	transfer(START_BLOCK + 90, '0xa90', ALICE, BOB, 7n),
];

function fakeChain() {
	return {
		async request(args: {method: string; params?: any}): Promise<any> {
			switch (args.method) {
				case 'eth_chainId':
					return '0x1';
				case 'eth_blockNumber':
					return hex(TIP);
				case 'eth_getLogs': {
					const from = parseInt(args.params[0].fromBlock.slice(2), 16);
					const to = parseInt(args.params[0].toBlock.slice(2), 16);
					return LOGS.filter((entry) => {
						const blockNumber = parseInt(entry.blockNumber.slice(2), 16);
						return blockNumber >= from && blockNumber <= to;
					});
				}
			}
			throw new Error(`unexpected method ${args.method}`);
		},
	} as any;
}

describe('etherfold build --store sqlite, over src/entities.ts', () => {
	it('indexes the browser demo’s processor into a database, unchanged', async () => {
		const prepared = await prepareIndexing(
			'build',
			{
				processor: BUNDLE,
				nodeUrl: 'http://localhost:0',
				store: 'sqlite',
				db: ':memory:',
			},
			{
				provider: fakeChain(),
				sleep: async () => {},
			},
		);
		await prepared.index();

		const store = prepared.store;
		if (!store) throw new Error('the sqlite arm must build a store');

		const tokenID = '7'.padStart(78, '0');

		// who owns the token, from the entity keyed by the token
		expect(await store.getCurrent('nft', {tokenAddress: CONTRACT, tokenID})).toMatchObject({owner: BOB});

		// ...and the SAME fact from the entity keyed by the owner, which is the one
		// that makes "which tokens does this account own" a prefix listing
		const listing = await store.listCurrent<{tokenAddress: string; tokenID: string}>('ownership', {owner: BOB}, 25);
		expect(listing.rows.map((row) => row.tokenID)).toEqual([tokenID]);
		expect(await store.listCurrent('ownership', {owner: ALICE}, 25)).toMatchObject({rows: []});

		expect(await store.getCurrent('counter', {name: 'transfers'})).toMatchObject({value: 2});
		// the ERC-20 log with the same topic0: refused by the decoder, counted by
		// `handleUnparsedEvent`, exactly as in the tab
		expect(await store.getCurrent('counter', {name: 'undecodable'})).toMatchObject({value: 1});
	});
});

describe('etherfold run, over the same src/entities.ts', () => {
	it('follows the chain, folds the browser demo\u2019s processor and answers HTTP, unchanged', async () => {
		const running = await run(
			{
				processor: BUNDLE,
				nodeUrl: 'http://localhost:0',
				store: 'sqlite',
				db: ':memory:',
				// the OS picks the port, so this suite never collides with whatever is
				// already listening on the developer machine running it
				port: '0',
			},
			{
				provider: fakeChain(),
				sleep: async () => {
					await new Promise((resolve) => setTimeout(resolve, 1));
				},
				// the test runner's process is not this command's to install handlers on
				handleSignals: false,
				log: () => {},
			},
		);

		try {
			const tokenID = '7'.padStart(78, '0');
			const deadline = Date.now() + 10_000;
			let cursor: {lastToBlock: number} | undefined;
			for (;;) {
				const body = (await (await fetch(`${running.url}/status`)).json()) as {
					cursor?: {reported: boolean; value?: {lastToBlock: number}};
				};
				cursor = body.cursor?.reported ? body.cursor.value : undefined;
				if (cursor?.lastToBlock === TIP) break;
				if (Date.now() > deadline) throw new Error(`timed out; /status last reported ${JSON.stringify(body.cursor)}`);
				await new Promise((resolve) => setTimeout(resolve, 5));
			}

			// the same three assertions the one-shot makes, from the same processor file,
			// read out of the database this process is still writing to
			expect(await running.store.getCurrent('nft', {tokenAddress: CONTRACT, tokenID})).toMatchObject({owner: BOB});
			expect(await running.store.getCurrent('counter', {name: 'transfers'})).toMatchObject({value: 2});
			expect(await running.store.getCurrent('counter', {name: 'undecodable'})).toMatchObject({value: 1});
		} finally {
			await running.stop();
		}
	});
});
