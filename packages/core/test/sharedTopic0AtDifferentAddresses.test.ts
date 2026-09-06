import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import type {Abi, AbiEvent} from 'abitype';
import {describe, expect, it} from 'vitest';
import {LogEventFetcher} from '../src/internal/decoding/LogEventFetcher.js';
import {topic0Of} from '../src/internal/decoding/eventIdentity.js';
import {IndexerGeneration} from '../src/indexer.js';
import {captureStream} from '../src/stream/capture.js';
import {parseStreamFixture} from '../src/stream/fixture.js';
import type {LogParseConfig} from '../src/types.js';

// ---------------------------------------------------------------------------
// AN ERC-721 AND AN ERC-20 IN ONE SOURCE
// ---------------------------------------------------------------------------
// `Transfer(address,address,uint256)` and `Approval(address,address,uint256)`
// are declared by BOTH standards and differ only in their `indexed` flags: the
// ERC-721 pair indexes the token id, the ERC-20 pair leaves the value in
// `data`. So they share a canonical signature, share a topic0, and decode into
// different shapes -- and mixing the two standards in one source is ordinary,
// not exotic.
//
// The construction-time guard used to run `deleteDuplicateEvents` over the
// MERGED list of every contract, so that combination refused to construct at
// all. ADR-0061 makes the GLOBAL refusal follow the DECODE PATH: `decodeOnto`
// resolves which ABI decodes a log by its ADDRESS, so where contracts are
// declared per address the wire DOES tell the two apart and the guard's own
// rationale ("nothing on the wire tells them apart") does not hold.
//
// What is NOT conditional, and what this file pins hardest:
//
//   - the PER-ADDRESS refusal is untouched: one address holding two shapes
//     under one topic0 is undecidable and still refuses;
//   - `parseAllEventsIrrespectiveOfAddresses` ON makes the ambiguity genuine
//     again (the address is ignored), so the SAME source refuses under it;
//   - the EVENT SET is identical either way. ADR-0031 forbids a parse-config
//     flag deciding WHICH EVENTS EXIST and that still holds: every topic0 is
//     still requested and nothing is ever spliced out of the filter. A shared
//     topic0 simply belongs in the filter ONCE.
// ---------------------------------------------------------------------------

/** The ERC-721. */
const NFT = '0x0000000000000000000000000000000000000001' as const;
/** The ERC-20. */
const TOKEN = '0x0000000000000000000000000000000000000002' as const;

// topic0s, as viem encodes them
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'; // Approval(address,address,uint256)
const APPROVAL_FOR_ALL = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31'; // ApprovalForAll(address,address,bool)

/** ERC-721 `Transfer`: the token id is INDEXED, so it rides in `topics[3]`. */
const erc721Transfer = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: true, name: 'tokenId', type: 'uint256'},
	],
} as const;

/** ERC-721 `Approval`: same signature as the ERC-20 one, different `indexed` flags. */
const erc721Approval = {
	type: 'event',
	name: 'Approval',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'owner', type: 'address'},
		{indexed: true, name: 'approved', type: 'address'},
		{indexed: true, name: 'tokenId', type: 'uint256'},
	],
} as const;

/** ERC-721 only: a topic0 neither standard shares, so the union is visible in the filter. */
const approvalForAll = {
	type: 'event',
	name: 'ApprovalForAll',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'owner', type: 'address'},
		{indexed: true, name: 'operator', type: 'address'},
		{indexed: false, name: 'approved', type: 'bool'},
	],
} as const;

/** ERC-20 `Transfer`: the value is NOT indexed, so it rides in `data`. */
const erc20Transfer = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'value', type: 'uint256'},
	],
} as const;

/** ERC-20 `Approval`. */
const erc20Approval = {
	type: 'event',
	name: 'Approval',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'owner', type: 'address'},
		{indexed: true, name: 'spender', type: 'address'},
		{indexed: false, name: 'value', type: 'uint256'},
	],
} as const;

/** The ordinary source: an ERC-721 and an ERC-20, each at its own address. */
const MIXED_STANDARDS = [
	{address: NFT, abi: [erc721Transfer, erc721Approval, approvalForAll] as unknown as Abi},
	{address: TOKEN, abi: [erc20Transfer, erc20Approval] as unknown as Abi},
];

const AGNOSTIC: LogParseConfig = {parseAllEventsIrrespectiveOfAddresses: true};

const quietProvider = {request: async () => undefined} as any;
const passThrough = <T>(p: Promise<T>) => p;

const word = (value: number) => value.toString(16).padStart(64, '0');
const addressTopic = (address: `0x${string}`) => `0x${'0'.repeat(24)}${address.slice(2)}` as `0x${string}`;

// digits only, so the checksummed form viem decodes to is the same string
const ALICE = '0x0000000000000000000000000000000000000011' as const;
const BOB = '0x0000000000000000000000000000000000000022' as const;

function log(address: `0x${string}`, topics: `0x${string}`[], data: `0x${string}`): Record<string, unknown> {
	return {
		blockNumber: '0x64',
		blockHash: '0xaaa',
		transactionIndex: '0x0',
		removed: false,
		address,
		data,
		topics,
		transactionHash: `0x${'1'.padStart(64, '0')}`,
		logIndex: '0x0',
	};
}

/** A provider that answers no logs and records the filters it was asked with. */
function recordingProvider() {
	const requests: {address?: string[]; topics?: (string | string[])[]}[] = [];
	const provider = {
		async request(args: {method: string; params?: any}): Promise<any> {
			if (args.method === 'eth_getLogs') {
				requests.push(args.params[0]);
				return [];
			}
			if (args.method === 'eth_blockNumber') return '0x3e8';
			throw new Error(`unexpected method ${args.method}`);
		},
	};
	return {provider: provider as any, requests};
}

/**
 * The topic0s ONE request asks for, read from the WHOLE topics array and
 * REFUSING a request that is not well formed.
 *
 * An `eth_getLogs` topics array is POSITIONAL: slot 0 is the event selector and
 * every later slot constrains an INDEXED ARGUMENT, so several topic0s belong
 * NESTED in slot 0 and never spread across slots. This file inherited a helper
 * that read slot 0 and nothing else, which made a flattened conjunction --
 * `{topics: [t0a, t0b]}`, a request no log can satisfy -- indistinguishable from
 * one topic0 under an argument filter. See `fetchFilter.test.ts`, which owns
 * that regression.
 */
function topic0sOf(request: {topics?: (string | string[] | null)[]}, declaredTopic0s: ReadonlySet<string>): string[] {
	const topics = request.topics || [];
	for (let slot = 1; slot < topics.length; slot++) {
		const constraint = topics[slot];
		const values = Array.isArray(constraint) ? constraint : constraint === null ? [] : [constraint];
		for (const value of values) {
			if (declaredTopic0s.has(value)) {
				throw new Error(
					`malformed eth_getLogs request: the event selector ${value} sits at topics[${slot}], where an ` +
						`INDEXED ARGUMENT goes. Several topic0s belong NESTED in slot 0. Got ${JSON.stringify(topics)}`,
				);
			}
		}
	}
	const slot0 = topics[0];
	return Array.isArray(slot0) ? slot0 : slot0 ? [slot0] : [];
}

/** Every `eth_getLogs` the fetcher issued for one range, in order, each one CHECKED for that shape. */
async function requestsMade(
	contractsData: any,
	parseConfig?: LogParseConfig,
): Promise<{address?: string[]; topics?: (string | string[])[]}[]> {
	const {requests} = await requestsAndTopic0s(contractsData, parseConfig);
	return requests;
}

async function requestsAndTopic0s(
	contractsData: any,
	parseConfig?: LogParseConfig,
): Promise<{requests: {address?: string[]; topics?: (string | string[])[]}[]; topic0s: string[]}> {
	const {provider, requests} = recordingProvider();
	const fetcher = new LogEventFetcher(provider, contractsData, {numBlocksToFetchAtStart: 100_000}, parseConfig);
	await fetcher.getLogEvents({fromBlock: 100, toBlock: 110, retry: 0}, passThrough);
	const declaredTopic0s = new Set(
		((fetcher as unknown as {eventNameTopics: string[] | null}).eventNameTopics || []) as string[],
	);
	const topic0s: string[] = [];
	for (const request of requests) {
		topic0s.push(...topic0sOf(request, declaredTopic0s));
	}
	return {requests, topic0s};
}

/** Every topic0 the fetcher put in front of the node, WITH its multiplicity: a dedupe is a claim about counts. */
async function topic0sRequested(contractsData: any, parseConfig?: LogParseConfig): Promise<string[]> {
	return (await requestsAndTopic0s(contractsData, parseConfig)).topic0s;
}

/** The private merged list and the private verdict about whether anything decodes against it. */
const mergedListOf = (fetcher: LogEventFetcher<Abi>) =>
	fetcher as unknown as {allABIEvents: AbiEvent[]; mergedListDecodes: boolean};

// ---------------------------------------------------------------------------

describe('an ERC-721 and an ERC-20 in one source', () => {
	it('CONSTRUCTS, where the merged-list refusal used to reject the whole source', () => {
		expect(() => new LogEventFetcher(quietProvider, MIXED_STANDARDS as any)).not.toThrow();
	});

	it('decodes each address log under its OWN declaration, which is what the address resolves', () => {
		const fetcher = new LogEventFetcher(quietProvider, MIXED_STANDARDS as any);

		const [nftTransfer, tokenTransfer, nftApproval, tokenApproval] = fetcher.parse([
			// ERC-721: the id is the THIRD topic and `data` is empty
			log(NFT, [TRANSFER, addressTopic(ALICE), addressTopic(BOB), `0x${word(7)}`], '0x'),
			// ERC-20: the value is in `data`
			log(TOKEN, [TRANSFER, addressTopic(ALICE), addressTopic(BOB)], `0x${word(1000)}`),
			log(NFT, [APPROVAL, addressTopic(ALICE), addressTopic(BOB), `0x${word(7)}`], '0x'),
			log(TOKEN, [APPROVAL, addressTopic(ALICE), addressTopic(BOB)], `0x${word(1000)}`),
		] as any);

		// the SAME topic0, two shapes, told apart by the address and by nothing else
		expect((nftTransfer as any).eventName).toBe('Transfer');
		expect((nftTransfer as any).args).toEqual({from: ALICE, to: BOB, tokenId: 7n});
		expect((tokenTransfer as any).eventName).toBe('Transfer');
		expect((tokenTransfer as any).args).toEqual({from: ALICE, to: BOB, value: 1000n});
		expect((nftApproval as any).args).toEqual({owner: ALICE, approved: BOB, tokenId: 7n});
		expect((tokenApproval as any).args).toEqual({owner: ALICE, spender: BOB, value: 1000n});
		// and none of the four fell into a decode failure
		for (const event of [nftTransfer, tokenTransfer, nftApproval, tokenApproval]) {
			expect((event as any).decodeError).toBeUndefined();
		}
	});

	it('puts the shared topic0 in the fetch filter exactly ONCE, and still asks for every topic0', async () => {
		const requested = await topic0sRequested(MIXED_STANDARDS);

		// the dedupe: `Transfer` and `Approval` are each declared twice and asked for once
		expect(requested.filter((topic) => topic === TRANSFER)).toHaveLength(1);
		expect(requested.filter((topic) => topic === APPROVAL)).toHaveLength(1);
		// and NOTHING was spliced out: the ERC-721-only event is there too
		expect([...requested].sort()).toEqual([TRANSFER, APPROVAL, APPROVAL_FOR_ALL].sort());
	});

	it('asks for the SAME topic0 set as either standard alone would contribute, so nothing widened or narrowed', async () => {
		const nftAlone = await topic0sRequested([MIXED_STANDARDS[0]]);
		const tokenAlone = await topic0sRequested([MIXED_STANDARDS[1]]);

		const union = [...new Set([...nftAlone, ...tokenAlone])].sort();
		expect((await topic0sRequested(MIXED_STANDARDS)).sort()).toEqual(union);
	});

	it('REFUSES the same source with parseAllEventsIrrespectiveOfAddresses, because then the ambiguity is genuine', () => {
		// the honest consequence of following the decode path: with the address
		// ignored, the merged list IS what decodes a log, and nothing tells the two
		// `Transfer`s apart
		const build = () => new LogEventFetcher(quietProvider, MIXED_STANDARDS as any, {}, AGNOSTIC);

		expect(build).toThrow(/ambiguous ABI/);
		expect(build).toThrow(/Transfer\(address,address,uint256\)/);
		expect(build).toThrow(new RegExp(TRANSFER));
	});

	it('still REFUSES two ambiguous declarations at ONE address, on either path', () => {
		// unchanged by ADR-0061: within one address the ambiguity is real and
		// undecidable, so the per-address refusal stays exactly as it was
		const oneAddress = [{address: NFT, abi: [erc721Transfer, erc20Transfer] as unknown as Abi}];

		for (const parse of [undefined, AGNOSTIC]) {
			const build = () => new LogEventFetcher(quietProvider, oneAddress as any, {}, parse);
			expect(build).toThrow(/ambiguous ABI/);
			expect(build).toThrow(/Transfer\(address,address,uint256\)/);
		}
	});

	it('still REFUSES the two shapes declared at the same address by TWO contract entries', () => {
		// the per-address lists are MERGED by address before the guard runs, so
		// splitting one address across two entries changes nothing
		const sameAddressTwice = [
			{address: NFT, abi: [erc721Transfer] as unknown as Abi},
			{address: NFT, abi: [erc20Transfer] as unknown as Abi},
		];

		expect(() => new LogEventFetcher(quietProvider, sameAddressTwice as any)).toThrow(/ambiguous ABI/);
	});

	it('still REFUSES a single merged ABI that names no address, since nothing there resolves one', () => {
		// `abiPerAddress.size === 0`, so the merged list IS the decode path
		expect(
			() => new LogEventFetcher(quietProvider, {abi: [erc721Transfer, erc20Transfer] as unknown as Abi} as any),
		).toThrow(/ambiguous ABI/);
	});
});

describe('what makes tolerating SAFE, asserted structurally', () => {
	// The merged list may now hold two members under one topic0, and that is safe
	// for exactly one reason: nothing decodes against it there. The two used to be
	// separately written copies of one expression, and a drift between them would
	// be SILENT -- `decodeEventLog` would return the first member matching the
	// topic0 and write another address's `args` onto the event with no
	// `decodeError`. So the invariant is pinned rather than trusted.

	it('never leaves an ambiguous merged list on a route that decodes against it', () => {
		const sources: any[] = [
			MIXED_STANDARDS,
			[MIXED_STANDARDS[0]],
			[{address: NFT, abi: [erc721Transfer, approvalForAll] as unknown as Abi}],
			{abi: [erc721Transfer, approvalForAll] as unknown as Abi},
			[],
		];

		for (const contractsData of sources) {
			for (const parse of [undefined, AGNOSTIC]) {
				let fetcher: LogEventFetcher<Abi>;
				try {
					fetcher = new LogEventFetcher(quietProvider, contractsData, {}, parse);
				} catch {
					// a refusal is the other honest answer, and it is loud
					continue;
				}
				const {allABIEvents, mergedListDecodes} = mergedListOf(fetcher);
				if (!mergedListDecodes) continue;
				const topics = allABIEvents.map((event) => topic0Of(event)).filter(Boolean);
				expect(topics).toEqual([...new Set(topics)]);
			}
		}
	});

	it('FREEZES the verdict at construction, so mutating the parse config later cannot switch routes', () => {
		// `parseConfig` is the CALLER's object, held by reference. Re-reading the flag
		// per log let a mutation after construction move decoding onto the very list
		// that was tolerated as ambiguous.
		const parse: LogParseConfig = {};
		const fetcher = new LogEventFetcher(quietProvider, MIXED_STANDARDS as any, {}, parse);

		(parse as {parseAllEventsIrrespectiveOfAddresses?: boolean}).parseAllEventsIrrespectiveOfAddresses = true;

		expect(mergedListOf(fetcher).mergedListDecodes).toBe(false);
		// and an ERC-20 Transfer still decodes as the ERC-20 one, not as whichever
		// member of the merged list happens to match the topic0 first
		const [event] = fetcher.parse([
			log(TOKEN, [TRANSFER, addressTopic(ALICE), addressTopic(BOB)], `0x${word(1000)}`),
		] as any);
		expect((event as any).args).toEqual({from: ALICE, to: BOB, value: 1000n});
	});

	it('still COLLAPSES an identical declaration that arrives AFTER a tolerated one', () => {
		// the workload's own order: one ERC-721 `Approval`, then TWO identical ERC-20
		// ones. Compared against a single remembered shape the third would be
		// tolerated as well, and "identical declarations are collapsed" would stop
		// being true exactly where a collision is tolerated.
		const OTHER_TOKEN = '0x0000000000000000000000000000000000000003' as const;
		const fetcher = new LogEventFetcher(quietProvider, [
			{address: NFT, abi: [erc721Approval] as unknown as Abi},
			{address: TOKEN, abi: [erc20Approval] as unknown as Abi},
			{address: OTHER_TOKEN, abi: [erc20Approval] as unknown as Abi},
		] as any);

		const approvals = mergedListOf(fetcher).allABIEvents.filter((event) => topic0Of(event) === APPROVAL);

		// two SHAPES, not three DECLARATIONS
		expect(approvals).toHaveLength(2);
	});
});

describe('an argument filter over a tolerated shared topic0', () => {
	// The hazard ADR-0061 recorded and deliberately did not repair: a tolerated
	// collision gives ONE topic0 covering TWO indexed layouts, so a POSITIONAL
	// filter written for one layout meant something else at the other address.
	// ADR-0062 repairs it, and the repair is a REFUSAL with a remedy rather than a
	// guess: say WHICH contracts the rule is for, and the other address is left
	// alone in the leftover request.

	it('REFUSES an unscoped rule, naming both shapes and their addresses', () => {
		const holder = addressTopic(ALICE);
		const build = () =>
			new LogEventFetcher(quietProvider, MIXED_STANDARDS as any, {}, {
				filters: [{event: 'Transfer', match: [[holder]]}],
			} as LogParseConfig);

		expect(build).toThrow(/2 different decoding shapes answer to/);
		// the remedy, and enough to act on it: which shapes, and where they are
		expect(build).toThrow(/Add `contracts` to scope this rule to one of them/);
		expect(build).toThrow(new RegExp(NFT));
		expect(build).toThrow(new RegExp(TOKEN));
	});

	it('SCOPED to the NFT, filters the NFT and leaves the ERC-20 Transfers requested and unfiltered', async () => {
		// the case that was inexpressible: an ERC-721 `Transfer` indexes three
		// arguments and an ERC-20 one indexes two, so a token-id filter is a
		// `topics[3]` constraint no ERC-20 log can satisfy. Scoped, it never reaches
		// the ERC-20 -- whose Transfers are still asked for, in the leftover request.
		const tokenId = `0x${word(7)}` as `0x${string}`;

		const {requests, topic0s} = await requestsAndTopic0s(MIXED_STANDARDS, {
			filters: [{event: 'Transfer', contracts: [NFT], match: [[addressTopic(ALICE), addressTopic(BOB), tokenId]]}],
		});

		const filtered = requests.filter((request) => request.topics?.[0] === TRANSFER);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].topics).toEqual([TRANSFER, addressTopic(ALICE), addressTopic(BOB), tokenId]);
		expect(filtered[0].address).toEqual([NFT]);

		// AN ADDRESS NOBODY FILTERED IS NOT FILTERED: the ERC-20's Transfers are
		// requested, unfiltered, at the ERC-20 alone
		const leftoverTransfer = requests.find(
			(request) => Array.isArray(request.topics?.[0]) && request.topics[0].indexOf(TRANSFER) !== -1,
		);
		expect(leftoverTransfer?.address).toEqual([TOKEN]);
		expect(leftoverTransfer?.topics).toHaveLength(1);

		// and every topic0 the source declares is still asked for, filter or not
		expect([...new Set(topic0s)].sort()).toEqual([TRANSFER, APPROVAL, APPROVAL_FOR_ALL].sort());
	});
});

// ---------------------------------------------------------------------------
// THE REPO'S OWN CONFORMANCE WORKLOAD
// ---------------------------------------------------------------------------
// stratagems alpha1 is Stratagems (ERC-721) plus Gems and GemsGenerator
// (ERC-20), so it is precisely the case above with real bytes. Its source could
// not construct a fetcher at all, and the acceptance gate was blind to that
// because the conformance tests replay through PROCESSORS and never construct
// one. This is the test that stops the gate being blind.
//
// It reads the committed fixture for its `source` field ONLY, through the
// repository's own format parser, and asserts nothing about its events.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALPHA1_STREAM = path.join(
	HERE,
	'../../conformance-workload-stratagems/fixtures/stratagems-alpha1.stream.json.gz',
);

function workloadSource() {
	const text = zlib.gunzipSync(fs.readFileSync(ALPHA1_STREAM)).toString('utf-8');
	return parseStreamFixture<Abi>(text).source;
}

describe("the conformance workload's three-contract source", () => {
	it('is the mixed-standards case, with a shared topic0 across three real addresses', () => {
		const source = workloadSource();
		const contracts = source.contracts as readonly {address: `0x${string}`; abi: Abi}[];

		expect(contracts).toHaveLength(3);
		// `Approval(address,address,uint256)` is declared by Stratagems (ERC-721,
		// `tokenID` indexed) and by Gems (ERC-20, `value` not indexed)
		const declaringApproval = contracts.filter((contract) =>
			contract.abi.some((item) => item.type === 'event' && item.name === 'Approval'),
		);
		expect(declaringApproval.length).toBeGreaterThan(1);
	});

	it('CONSTRUCTS a LogEventFetcher, which is what the load and replay path needs', () => {
		const source = workloadSource();

		expect(() => new LogEventFetcher(quietProvider, source.contracts as any)).not.toThrow();
	});

	it('CONSTRUCTS an IndexerGeneration, which is what threw before ADR-0061', () => {
		const source = workloadSource();
		const processor = {} as any;

		expect(() => new IndexerGeneration(quietProvider, processor, source, {stream: {finality: 12}})).not.toThrow();
	});

	it('lets captureStream get past construction and reach the node', async () => {
		// `captureStream` builds a `LogEventFetcher` and then fetches; before
		// ADR-0061 it could not re-capture the very source it committed
		const source = workloadSource();
		const {provider, requests} = recordingProvider();

		const fixture = await captureStream(provider, source, {
			fromBlock: 12_082_307,
			toBlock: 12_082_317,
			fetch: {numBlocksToFetchAtStart: 100_000},
		});

		expect(requests.length).toBeGreaterThan(0);
		expect(fixture.source).toBe(source);
		expect(fixture.eventStream).toEqual([]);
	});

	it('REFUSES that same source under parseAllEventsIrrespectiveOfAddresses, honestly', () => {
		const source = workloadSource();

		expect(() => new LogEventFetcher(quietProvider, source.contracts as any, {}, AGNOSTIC)).toThrow(/ambiguous ABI/);
	});
});
