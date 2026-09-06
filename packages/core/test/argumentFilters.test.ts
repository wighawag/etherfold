import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {LogEventFetcher} from '../src/internal/decoding/LogEventFetcher.js';
import {resolveStreamConfig} from '../src/internal/engine/utils.js';
import type {LogParseConfig} from '../src/types.js';

// ---------------------------------------------------------------------------
// AN ARGUMENT FILTER RESTRICTS A (CONTRACT, TOPIC0) PAIR, NEVER A TOPIC0
// ---------------------------------------------------------------------------
// The old surface was a map keyed by event NAME whose value was a list of
// positional filters, and a filtered `topic0` was REMOVED from the shared
// request outright. Three things followed from that and all three are fixed
// here (ADR-0062):
//
//   - there was no `null` in the type, so the wildcard `eth_getLogs` defines
//     could not be written, and "Transfers TO me" -- a constraint on the SECOND
//     indexed argument -- was inexpressible;
//   - a filter reached every contract declaring the name, so "filter the NFT
//     and leave the ERC-20 alone" was inexpressible even in principle;
//   - one name can cover two topic0s (two versions across an upgrade) or one
//     topic0 with two decoding shapes at two addresses (ADR-0061), so a
//     POSITIONAL filter meant different things at different addresses.
//
// The rule that replaces it is: AN ADDRESS NOBODY FILTERED IS NOT FILTERED. Per
// live topic0, the rules targeting it produce one request each per `match`
// entry, and every address they did not reach is collected into a LEFTOVER
// request that asks for that topic0 unfiltered.
// ---------------------------------------------------------------------------

const NFT = '0x0000000000000000000000000000000000000001' as const;
const TOKEN = '0x0000000000000000000000000000000000000002' as const;
const OTHER = '0x0000000000000000000000000000000000000003' as const;

const ME = '0x0000000000000000000000000000000000000011' as const;
const YOU = '0x0000000000000000000000000000000000000022' as const;

// topic0s, as viem encodes them
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
const TRANSFER_V2 = '0xe19260aff97b920c7df27010903aeb9c8d2be5d310a2c67824cf3f15396e4c16'; // Transfer(address,address,uint256,bytes)
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'; // Approval(address,address,uint256)
const APPROVAL_FOR_ALL = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31'; // ApprovalForAll(address,address,bool)

const asTopic = (address: `0x${string}`) => `0x${'0'.repeat(24)}${address.slice(2)}` as `0x${string}`;
const word = (value: number) => `0x${value.toString(16).padStart(64, '0')}` as `0x${string}`;

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

/** ERC-20 `Transfer`: the value is NOT indexed, so it rides in `data`. Same topic0. */
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

const approval = {
	type: 'event',
	name: 'Approval',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'owner', type: 'address'},
		{indexed: true, name: 'approved', type: 'address'},
		{indexed: true, name: 'tokenId', type: 'uint256'},
	],
} as const;

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

/** `Transfer(address,address,uint256,bytes)` -- a SECOND topic0 under the same NAME. */
const transferV2 = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'id', type: 'uint256'},
		{indexed: false, name: 'memo', type: 'bytes'},
	],
} as const;

/** Anonymous: no topic0, so nothing to request by and nothing to filter. */
const anonymousPing = {
	type: 'event',
	name: 'Ping',
	anonymous: true,
	inputs: [{indexed: true, name: 'who', type: 'address'}],
} as const;

const NFT_ONLY = [{address: NFT, abi: [erc721Transfer, approval, approvalForAll] as unknown as Abi}];
const MIXED = [
	{address: NFT, abi: [erc721Transfer, approval, approvalForAll] as unknown as Abi},
	{address: TOKEN, abi: [erc20Transfer] as unknown as Abi},
];
/** Two ERC-721s: ONE topic0, ONE decoding shape, TWO addresses. */
const TWO_NFTS = [
	{address: NFT, abi: [erc721Transfer, approval] as unknown as Abi},
	{address: OTHER, abi: [erc721Transfer, approval] as unknown as Abi},
];

const quietProvider = {request: async () => undefined} as any;
const passThrough = <T>(p: Promise<T>) => p;

type Request = {address?: string[]; topics?: (string | string[] | null)[]};

function recordingProvider() {
	const requests: Request[] = [];
	const provider = {
		async request(args: {method: string; params?: any}): Promise<any> {
			if (args.method !== 'eth_getLogs') throw new Error(`unexpected method ${args.method}`);
			requests.push(args.params[0]);
			return [];
		},
	};
	return {provider: provider as any, requests};
}

async function requestsMade(contractsData: any, parseConfig?: LogParseConfig): Promise<Request[]> {
	const {provider, requests} = recordingProvider();
	const fetcher = new LogEventFetcher(provider, contractsData, {numBlocksToFetchAtStart: 100_000}, parseConfig);
	await fetcher.getLogEvents({fromBlock: 100, toBlock: 110, retry: 0}, passThrough);
	return requests;
}

/** Build only, so a REFUSAL is asserted where it happens: at construction. */
const build = (contractsData: any, parseConfig: LogParseConfig) => () =>
	new LogEventFetcher(quietProvider, contractsData, {}, parseConfig);

// ---------------------------------------------------------------------------

describe('the null wildcard, which is the whole reason the shape changed', () => {
	it('reaches the node as a null in slot 1, so a constraint on the SECOND indexed argument is expressible', async () => {
		// "Transfers TO me". Without `null` in the type this could not be written at
		// all, and the one place in this repository that needed it carried a cast.
		const requests = await requestsMade(NFT_ONLY, {filters: [{event: 'Transfer', match: [[null, asTopic(ME)]]}]});

		const transfers = requests.filter((request) => request.topics?.[0] === TRANSFER);
		expect(transfers).toHaveLength(1);
		expect(transfers[0].topics).toEqual([TRANSFER, null, asTopic(ME)]);
		// well formed: three positional slots, the wildcard preserved as `null` and
		// not dropped, not stringified and not turned into an empty array
		expect(transfers[0].topics?.[1]).toBeNull();
	});

	it('trims TRAILING wildcards, because they constrain nothing', async () => {
		const requests = await requestsMade(NFT_ONLY, {
			filters: [{event: 'Transfer', match: [[asTopic(ME), null, null]]}],
		});

		const transfers = requests.filter((request) => request.topics?.[0] === TRANSFER);
		expect(transfers[0].topics).toEqual([TRANSFER, asTopic(ME)]);
	});

	it('"anything involving me" is TWO entries OR-ed, and their union is what a client wants', async () => {
		// the OR is across `match` entries and each entry is its own request, because
		// `eth_getLogs` has no OR across positions. The results are unioned and
		// de-duplicated by the fetcher, so a self-transfer is delivered once.
		const requests = await requestsMade(NFT_ONLY, {
			filters: [
				{
					event: 'Transfer',
					match: [
						[asTopic(ME), null],
						[null, asTopic(ME)],
					],
				},
			],
		});

		const transfers = requests.filter((request) => request.topics?.[0] === TRANSFER);
		expect(transfers).toHaveLength(2);
		expect(transfers[0].topics).toEqual([TRANSFER, asTopic(ME)]);
		expect(transfers[1].topics).toEqual([TRANSFER, null, asTopic(ME)]);
	});

	it('de-duplicates a log that satisfies BOTH entries, so a self-transfer is delivered once', async () => {
		const selfTransfer = {
			blockNumber: '0x64',
			blockHash: '0xaaa',
			transactionIndex: '0x0',
			removed: false,
			address: NFT,
			data: '0x',
			topics: [TRANSFER, asTopic(ME), asTopic(ME), word(7)],
			transactionHash: `0x${'1'.padStart(64, '0')}`,
			logIndex: '0x0',
		};
		const provider = {
			async request(args: {method: string; params?: any}): Promise<any> {
				if (args.method !== 'eth_getLogs') throw new Error(`unexpected method ${args.method}`);
				// both the `from` request and the `to` request match it
				return args.params[0].topics?.[0] === TRANSFER ? [selfTransfer] : [];
			},
		} as any;
		const fetcher = new LogEventFetcher(
			provider,
			NFT_ONLY as any,
			{numBlocksToFetchAtStart: 100_000},
			{
				filters: [
					{
						event: 'Transfer',
						match: [
							[asTopic(ME), null],
							[null, asTopic(ME)],
						],
					},
				],
			},
		);

		const {events} = await fetcher.getLogEvents({fromBlock: 100, toBlock: 110, retry: 0}, passThrough);

		expect(events).toHaveLength(1);
	});
});

describe('a filter restricts a (contract, topic0) pair, never a topic0', () => {
	it('SCOPES to the NFT and leaves the ERC-20 Transfers requested and UNFILTERED', async () => {
		// the case that is inexpressible today, and the whole point of the redesign.
		// The rule is scoped to the address where a token id exists at all.
		const requests = await requestsMade(MIXED, {
			filters: [{event: 'Transfer', contracts: [NFT], match: [[null, null, word(7)]]}],
		});

		const filtered = requests.filter((request) => request.topics?.[0] === TRANSFER);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].topics).toEqual([TRANSFER, null, null, word(7)]);
		expect(filtered[0].address).toEqual([NFT]);

		// AN ADDRESS NOBODY FILTERED IS NOT FILTERED
		const leftover = requests.filter(
			(request) => Array.isArray(request.topics?.[0]) && (request.topics[0] as string[]).indexOf(TRANSFER) !== -1,
		);
		expect(leftover).toHaveLength(1);
		expect(leftover[0].address).toEqual([TOKEN]);
		expect(leftover[0].topics).toEqual([[TRANSFER]]);
	});

	it('groups the LEFTOVER by address set: filtered where scoped, unfiltered for the rest', async () => {
		// One topic0 declared at two addresses, a rule reaching one of them. The
		// scoped request and the leftover request are both issued, and the leftover
		// carries the addresses the rule did not name.
		const requests = await requestsMade(TWO_NFTS, {
			filters: [{event: 'Transfer', contracts: [NFT], match: [[asTopic(ME)]]}],
		});

		// `Approval` is at BOTH addresses and no rule mentions it, so it is UNSCOPED
		// and travels in the group holding the whole source. The leftover groups come
		// FIRST, which is what keeps the order stable.
		expect(requests).toEqual([
			{
				address: [OTHER],
				fromBlock: '0x64',
				toBlock: '0x6e',
				topics: [[TRANSFER]],
			},
			{
				address: [NFT, OTHER],
				fromBlock: '0x64',
				toBlock: '0x6e',
				topics: [[APPROVAL]],
			},
			{
				address: [NFT],
				fromBlock: '0x64',
				toBlock: '0x6e',
				topics: [TRANSFER, asTopic(ME)],
			},
		]);
	});

	it('leaves NO leftover request when the rule reaches every address declaring the topic0', async () => {
		const requests = await requestsMade(TWO_NFTS, {filters: [{event: 'Transfer', match: [[asTopic(ME)]]}]});

		const transferRequests = requests.filter(
			(request) =>
				request.topics?.[0] === TRANSFER ||
				(Array.isArray(request.topics?.[0]) && (request.topics[0] as string[]).indexOf(TRANSFER) !== -1),
		);
		expect(transferRequests).toHaveLength(1);
		expect(transferRequests[0].address).toEqual([NFT, OTHER]);
	});

	it('lets two rules target ONE topic0 at two different addresses', async () => {
		// what the old map keyed by event name could not hold at all: the second
		// entry would simply have overwritten the first
		const requests = await requestsMade(TWO_NFTS, {
			filters: [
				{event: 'Transfer', contracts: [NFT], match: [[asTopic(ME)]]},
				{event: 'Transfer', contracts: [OTHER], match: [[asTopic(YOU)]]},
			],
		});

		const transfers = requests.filter((request) => request.topics?.[0] === TRANSFER);
		expect(transfers).toHaveLength(2);
		expect(transfers.map((request) => [request.address, request.topics])).toEqual([
			[[NFT], [TRANSFER, asTopic(ME)]],
			[[OTHER], [TRANSFER, asTopic(YOU)]],
		]);
		// both addresses are covered, so nothing is left over for `Transfer`
		expect(
			requests.filter(
				(request) => Array.isArray(request.topics?.[0]) && (request.topics[0] as string[]).indexOf(TRANSFER) !== -1,
			),
		).toHaveLength(0);
	});
});

describe('no rule configured produces exactly the request it produces today', () => {
	for (const [label, parseConfig] of [
		['no parse config at all', undefined],
		['an empty parse config', {}],
		['an empty rule list', {filters: []}],
	] as [string, LogParseConfig | undefined][]) {
		it(`is ONE request, all addresses, all topic0s nested in slot 0 (${label})`, async () => {
			expect(await requestsMade(MIXED, parseConfig)).toEqual([
				{
					address: [NFT, TOKEN],
					fromBlock: '0x64',
					toBlock: '0x6e',
					topics: [[TRANSFER, APPROVAL, APPROVAL_FOR_ALL]],
				},
			]);
		});
	}
});

describe('targeting by canonical SIGNATURE rather than by NAME', () => {
	// ONE field carries both, discriminated on `(`: a Solidity event name is an
	// identifier and can never contain one.
	const UPGRADED = [{address: NFT, abi: [erc721Transfer, transferV2] as unknown as Abi}];

	it('filters ONE version and leaves the other in the leftover request', async () => {
		const requests = await requestsMade(UPGRADED, {
			filters: [{event: 'Transfer(address,address,uint256)', match: [[asTopic(ME)]]}],
		});

		expect(requests).toEqual([
			{address: [NFT], fromBlock: '0x64', toBlock: '0x6e', topics: [[TRANSFER_V2]]},
			{address: [NFT], fromBlock: '0x64', toBlock: '0x6e', topics: [TRANSFER, asTopic(ME)]},
		]);
	});

	it('while the NAME covers BOTH versions, which is the difference between the two spellings', async () => {
		const requests = await requestsMade(UPGRADED, {filters: [{event: 'Transfer', match: [[asTopic(ME)]]}]});

		expect(requests).toEqual([
			{address: [NFT], fromBlock: '0x64', toBlock: '0x6e', topics: [TRANSFER, asTopic(ME)]},
			{address: [NFT], fromBlock: '0x64', toBlock: '0x6e', topics: [TRANSFER_V2, asTopic(ME)]},
		]);
	});
});

// ---------------------------------------------------------------------------
// THE REFUSALS
// ---------------------------------------------------------------------------
// Every one of them is at CONSTRUCTION and every message names a remedy. The
// two alternatives are both silent: widening hands back a superset stream
// nobody asked for, and narrowing unrequests logs, after which nothing tells
// "the chain had none" from "we never asked" (ADR-0031).
// ---------------------------------------------------------------------------

describe('a misconfigured rule is refused at construction, with the remedy in the message', () => {
	it('R1: an event the source does not declare, naming it and listing what IS declared', () => {
		const refuse = build(NFT_ONLY, {filters: [{event: 'Trasnfer', match: [[asTopic(ME)]]}]});

		expect(refuse).toThrow(/`Trasnfer`/);
		expect(refuse).toThrow(/Declared events: .*`Transfer`.*`Approval`.*`ApprovalForAll`/);
		expect(refuse).toThrow(/Name one of those/);
	});

	it('R2: an address in `contracts` that declares no matching event, naming the ones that do', () => {
		const refuse = build(MIXED, {filters: [{event: 'ApprovalForAll', contracts: [TOKEN], match: [[asTopic(ME)]]}]});

		expect(refuse).toThrow(new RegExp(TOKEN));
		expect(refuse).toThrow(/Remove it, or name one of the contracts that do declare it/);
		expect(refuse).toThrow(new RegExp(NFT));
	});

	it('R3: one topic0 with two decoding shapes, telling the author to scope the rule', () => {
		// the ADR-0061 tolerated collision meeting a filter: now a misconfiguration
		// with a remedy rather than an inherent hazard
		const refuse = build(MIXED, {filters: [{event: 'Transfer', match: [[asTopic(ME)]]}]});

		expect(refuse).toThrow(/2 different decoding shapes answer to/);
		expect(refuse).toThrow(/Add `contracts` to scope this rule to one of them/);
		expect(refuse).toThrow(new RegExp(TRANSFER));
	});

	it('R4: a `match` entry deeper than the shape indexes, so the request matches nothing', () => {
		// ERC-20 `Transfer` indexes two arguments, so a third slot is a `topics[3]`
		// constraint no log of it can carry
		const refuse = build([{address: TOKEN, abi: [erc20Transfer] as unknown as Abi}], {
			filters: [{event: 'Transfer', match: [[asTopic(ME), asTopic(YOU), word(7)]]}],
		});

		expect(refuse).toThrow(/indexes only 2/);
		expect(refuse).toThrow(/provably matches no log/);
		expect(refuse).toThrow(/Shorten the entry to at most 2 slots/);
	});

	it('R5: an empty `match`, an empty entry, and an all-null entry', () => {
		expect(build(NFT_ONLY, {filters: [{event: 'Transfer', match: []}]})).toThrow(
			/empty `match`.*Give it at least one entry/s,
		);
		expect(build(NFT_ONLY, {filters: [{event: 'Transfer', match: [[]]}]})).toThrow(
			/constrains nothing \(it is empty\).*Constrain at least one slot/s,
		);
		expect(build(NFT_ONLY, {filters: [{event: 'Transfer', match: [[null, null]]}]})).toThrow(
			/every slot is the null wildcard.*Constrain at least one slot/s,
		);
	});

	it('R6: `contracts` on an address-less source, which has no address to scope by', () => {
		const merged = {abi: [erc721Transfer, approval] as unknown as Abi};
		const refuse = build(merged, {filters: [{event: 'Transfer', contracts: [NFT], match: [[asTopic(ME)]]}]});

		expect(refuse).toThrow(/ONE merged ABI and no addresses/);
		expect(refuse).toThrow(/Drop `contracts`, or declare the source as a list of `\{address, abi\}` contracts/);
	});

	it('R7: a near-miss signature, listing the canonical signatures that DO exist for that name', () => {
		// the comparison is strict byte equality with viem's canonical form: no
		// spaces, no `uint` alias
		const refuse = build(NFT_ONLY, {
			filters: [{event: 'Transfer(address, address, uint256)', match: [[asTopic(ME)]]}],
		});

		expect(refuse).toThrow(/not byte-equal to any canonical signature/);
		expect(refuse).toThrow(/Declared for `Transfer`: `Transfer\(address,address,uint256\)`/);
		expect(refuse).toThrow(/write `uint256`, never `uint`/);
	});

	it('R7: and a `uint` alias is refused rather than accepted', () => {
		expect(build(NFT_ONLY, {filters: [{event: 'Transfer(address,address,uint)', match: [[asTopic(ME)]]}]})).toThrow(
			/not byte-equal to any canonical signature/,
		);
	});

	it('R8: an event declared only ANONYMOUSLY, which carries no topic0 to filter', () => {
		const withAnonymous = [{address: NFT, abi: [erc721Transfer, anonymousPing] as unknown as Abi}];
		const refuse = build(withAnonymous, {filters: [{event: 'Ping', match: [[asTopic(ME)]]}]});

		expect(refuse).toThrow(/ONLY as an anonymous event/);
		expect(refuse).toThrow(/carries no topic0/);
		expect(refuse).toThrow(/Filter a non-anonymous event instead: .*`Transfer`/);
	});
});

// ---------------------------------------------------------------------------
// STREAM IDENTITY
// ---------------------------------------------------------------------------

describe('two authored forms with the same meaning are ONE stream', () => {
	const canonicalise = (filters: LogParseConfig['filters']) =>
		JSON.stringify(resolveStreamConfig({parse: {filters}}).parse?.filters);

	it('does not depend on the ORDER of the rules', () => {
		const a = canonicalise([
			{event: 'Transfer', match: [[asTopic(ME)]]},
			{event: 'Approval', match: [[asTopic(YOU)]]},
		]);
		const b = canonicalise([
			{event: 'Approval', match: [[asTopic(YOU)]]},
			{event: 'Transfer', match: [[asTopic(ME)]]},
		]);
		expect(a).toBe(b);
	});

	it('does not depend on the ORDER of the `match` entries, which are OR-ed', () => {
		expect(
			canonicalise([
				{
					event: 'Transfer',
					match: [
						[asTopic(ME), null],
						[null, asTopic(ME)],
					],
				},
			]),
		).toBe(
			canonicalise([
				{
					event: 'Transfer',
					match: [
						[null, asTopic(ME)],
						[asTopic(ME), null],
					],
				},
			]),
		);
	});

	it('does not depend on TRAILING wildcards, which constrain nothing', () => {
		expect(canonicalise([{event: 'Transfer', match: [[asTopic(ME), null, null]]}])).toBe(
			canonicalise([{event: 'Transfer', match: [[asTopic(ME)]]}]),
		);
	});

	it('does not depend on the CASE or the ORDER of the `contracts` addresses', () => {
		expect(
			canonicalise([
				{event: 'Transfer', contracts: [TOKEN.toLowerCase() as `0x${string}`, NFT], match: [[asTopic(ME)]]},
			]),
		).toBe(canonicalise([{event: 'Transfer', contracts: [NFT, TOKEN], match: [[asTopic(ME)]]}]));
	});

	it('DE-DUPLICATES a rule written twice, which asks the same question twice', () => {
		expect(
			canonicalise([
				{event: 'Transfer', match: [[asTopic(ME)]]},
				{event: 'Transfer', match: [[asTopic(ME)]]},
			]),
		).toBe(canonicalise([{event: 'Transfer', match: [[asTopic(ME)]]}]));
	});

	it('is IDEMPOTENT, so a resolved config resolves to itself', () => {
		const once = resolveStreamConfig({parse: {filters: [{event: 'Transfer', match: [[asTopic(ME), null]]}]}});
		expect(JSON.stringify(resolveStreamConfig(once))).toBe(JSON.stringify(once));
	});

	it('keeps a NAME and the SIGNATURE it covers APART, because they are different intents', () => {
		// a name follows an upgrade onto a second topic0 and a signature does not,
		// and resolving one into the other would need the SOURCE, which a config
		// normalisation does not have
		expect(canonicalise([{event: 'Transfer', match: [[asTopic(ME)]]}])).not.toBe(
			canonicalise([{event: 'Transfer(address,address,uint256)', match: [[asTopic(ME)]]}]),
		);
	});
});
