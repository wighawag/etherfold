import {describe, expect, it} from 'vitest';
import {getNewToBlockFromError, RangeLogFetcher} from '../src/internal/engine/RangeLogFetcher.js';

/**
 * Every input in the "real refusals" blocks below is a response a real provider
 * really sent, quoted verbatim, with the endpoint named in a comment above it.
 * They were re-captured live on 2026-09-08 across 60+ keyless public endpoints;
 * the probe script, the raw output and what moved since the 2026-06-30 capture
 * are in `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/`.
 * The two figures that did NOT come off the wire here are quoted from a public
 * capture (ethers-io/ethers.js#4703) and are marked as such.
 *
 * They are quoted rather than invented because the whole point of this parser is
 * to match what nodes send, and what nodes send is not what one would guess: a
 * cap is stated as a block SPAN by some and a RESULT COUNT by others, the same
 * complaint arrives under four different codes, and one client puts the entire
 * hint in `data` behind a message that says only "invalid params".
 */
function rpcError(code: number, message?: string, data?: any) {
	return {code, message, data};
}

describe('getNewToBlockFromError', () => {
	describe('a refusal that carries STRUCTURED data is read from the data', () => {
		it('reads `data.to` from an Infura -32005', () => {
			// Infura, quoted verbatim in ethers-io/ethers.js#4703. The same information is
			// in the prose and in `data`; `data` is the one that needs no regex.
			const err = {
				code: -32005,
				data: {from: '0xBDE5F8', limit: 10000, to: '0x102DBCC'},
				message: 'query returned more than 10000 results. Try with this block range [0xBDE5F8, 0x102DBCC].',
			};
			expect(getNewToBlockFromError(err)).toBe(0x102dbcc);
		});

		it('reads `data.to` even when the message carries no suggested range', () => {
			// COMPOSITE of two real Infura responses, and the one input here that is not a
			// single captured body: the `data` object is #4703's verbatim, the message is
			// Infura's other real phrasing (the finding records Infura sending
			// "query returned more than 10000 results" with NO suggested range). It is what
			// separates "read the data" from "read the prose", which the capture above
			// cannot separate because there the two agree.
			const err = {
				code: -32005,
				data: {from: '0xBDE5F8', limit: 10000, to: '0x102DBCC'},
				message: 'query returned more than 10000 results',
			};
			expect(getNewToBlockFromError(err)).toBe(0x102dbcc);
		});

		it('reads the hint out of `data` when the MESSAGE is a generic "invalid params"', () => {
			// rpc.gnosischain.com (Nethermind), captured 2026-09-08. The message alone fails
			// the range-hint gate, so before this the whole hint was discarded and the
			// fetcher halved blindly against a node that had told it the answer.
			const err = rpcError(
				-32602,
				'invalid params',
				'Query returned more than 50000 results. Try with this block range [0x1000000, 0x1080000].',
			);
			expect(getNewToBlockFromError(err)).toBe(0x1080000);
		});

		it('reads the same shape from a second chain', () => {
			// rpc.frax.com (Nethermind), captured 2026-09-08.
			const err = rpcError(
				-32602,
				'invalid params',
				'Query returned more than 20000 results. Try with this block range [0x100000, 0x81dfec].',
			);
			expect(getNewToBlockFromError(err)).toBe(0x81dfec);
		});

		it('falls back to halving when `data` states a cap but suggests no range', () => {
			// api.roninchain.com/rpc, captured 2026-09-08. A range hint in `data` with
			// nothing machine-readable to extract: the stated cap (200) is user story 3
			// of the spec and is not read here.
			const err = rpcError(
				-32602,
				'Invalid params',
				'requested block range 16777217 exceeds the limit of 200; narrow your fromBlock/toBlock',
			);
			expect(getNewToBlockFromError(err)).toBeUndefined();
		});

		it('ignores a `data` object that is not a range descriptor', () => {
			// aurora-is-near/aurora-relayer#326: a -32005 whose `data` echoes the request
			// rather than describing a range. Nothing in it is a suggested `toBlock`.
			const err = {
				code: -32005,
				message: 'query returned more than 1000 results',
				data: {
					host: '192.168.1.2',
					'cf-ray': '726f01a2e50317ca-MEL',
					request_body: {method: 'eth_getLogs', params: [{fromBlock: '0x0', toBlock: 'latest'}]},
				},
			};
			expect(getNewToBlockFromError(err)).toBeUndefined();
		});
	});

	describe('a refusal with PROSE only parses exactly as it did before', () => {
		it('-32005 with a suggested range (rpc.mevblocker.io, 2026-06-30)', () => {
			// The capture the finding is built on. mevblocker no longer produces this shape
			// (it enforces a block-span cap now, see the spike), which is precisely why the
			// prose path must keep working: providers revise these.
			const err = rpcError(
				-32005,
				'query returned more than 10000 results. Try with this block range [0x184036C, 0x184037B].',
			);
			expect(getNewToBlockFromError(err)).toBe(0x184037b);
		});

		it('-32602 with a suggested range (mainnet.era.zksync.io, 2026-09-08)', () => {
			const err = rpcError(
				-32602,
				'Query returned more than 10000 results. Try with this block range [0x100000, 0x1000bb].',
			);
			expect(getNewToBlockFromError(err)).toBe(0x1000bb);
		});

		it('-32602 with a suggested range (api.mainnet.abs.xyz, 2026-09-08)', () => {
			const err = rpcError(
				-32602,
				'Query returned more than 10000 results. Try with this block range [0x100000, 0x1001b6].',
			);
			expect(getNewToBlockFromError(err)).toBe(0x1001b6);
		});

		it('-32602 with the suggestion buried at the end of a paragraph (Alchemy)', () => {
			// Alchemy, quoted verbatim in ethers-io/ethers.js#4703. Two caps in one
			// sentence and the suggestion last; the gate passes on "block range".
			const err = rpcError(
				-32602,
				'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response. Based on your parameters and the response size limit, this block range should work: [0x0, 0xd043b8]',
			);
			expect(getNewToBlockFromError(err)).toBe(0xd043b8);
		});

		it('-32005 that suggests nothing falls back to halving (bsc-dataseed.bnbchain.org, 2026-09-08)', () => {
			expect(getNewToBlockFromError(rpcError(-32005, 'limit exceeded'))).toBeUndefined();
		});

		it('-32602 that states a cap but suggests nothing falls back to halving (1rpc.io/eth, 2026-09-08)', () => {
			// Also a reminder that the gate is a SUBSTRING match: "0 - 50 blocks range" is
			// not "block range", so this does not even reach the regex. Reading the stated
			// 50 is user story 3 and is not this task.
			expect(getNewToBlockFromError(rpcError(-32602, 'eth_getLogs is limited to 0 - 50 blocks range'))).toBeUndefined();
		});
	});

	describe('-32000 is read under the same gate as -32602', () => {
		it('is no longer discarded on its CODE alone', () => {
			// SYNTHETIC, and deliberately the only one here: across 60+ endpoints not a
			// single real -32000 carried a machine-readable suggestion (see the spike), so
			// no captured body can show the widened code producing a value. This is the
			// Infura -32005 body above re-coded to -32000, and it exists to fail if
			// somebody drops -32000 from the accepted codes again. Every -32000 shape that
			// providers DO send is asserted below, verbatim.
			const err = rpcError(
				-32000,
				'query returned more than 10000 results. Try with this block range [0xBDE5F8, 0x102DBCC].',
			);
			expect(getNewToBlockFromError(err)).toBe(0x102dbcc);
		});

		it('a -32000 stating a block-span cap reaches the hint path and falls back to halving', () => {
			// zkevm-rpc.com, captured 2026-09-08. Passes the gate on "block range"; the cap
			// is stated in prose only, so there is nothing to extract yet.
			expect(getNewToBlockFromError(rpcError(-32000, 'block range too large, max range: 10000'))).toBeUndefined();
			// rpc.merlinchain.io, captured 2026-09-08.
			expect(getNewToBlockFromError(rpcError(-32000, 'block range too large, max range: 2000'))).toBeUndefined();
			// rpc.immutable.com, captured 2026-09-08.
			expect(getNewToBlockFromError(rpcError(-32000, 'exceeded maximum block range: 5000'))).toBeUndefined();
		});

		it('a -32000 stating a result cap reaches the hint path and falls back to halving', () => {
			// rpc.pulsechain.com, captured 2026-09-08.
			const err = rpcError(-32000, 'query returned more than allowed number of logs, try with smaller block range');
			expect(getNewToBlockFromError(err)).toBeUndefined();
		});

		it('does NOT mis-parse a -32000 whose bracketed text is not a range', () => {
			// evm.cronos.org, captured 2026-09-08, `data` genuinely null on the wire. The
			// message carries a bracketed pair that is a PARAMETER NAME LIST, not blocks.
			// This is why widening the code did not mean widening the gate.
			expect(
				getNewToBlockFromError(rpcError(-32000, 'maximum [from, to] blocks distance: 2000', null)),
			).toBeUndefined();
			// evm.kava.io, captured 2026-09-08.
			expect(getNewToBlockFromError(rpcError(-32000, 'maximum [from, to] blocks distance: 10000'))).toBeUndefined();
		});

		it('does not read a -32000 that mentions neither results nor a block range', () => {
			// arb1.arbitrum.io/rpc, captured 2026-09-08.
			expect(getNewToBlockFromError(rpcError(-32000, 'logs matched by query exceeds limit of 10000'))).toBeUndefined();
			// api.avax.network/ext/bc/C/rpc, captured 2026-09-08.
			const avalanche = rpcError(-32000, 'requested too many blocks from 50331648 to 51380224, maximum is set to 2048');
			expect(getNewToBlockFromError(avalanche)).toBeUndefined();
			// rpc.ankr.com/eth, captured 2026-09-08: a -32000 that is not about ranges at all.
			const ankr = rpcError(
				-32000,
				'Unauthorized: You must authenticate your request with an API key. Create an account on https://www.ankr.com/rpc/ and generate your personal API key for free.',
			);
			expect(getNewToBlockFromError(ankr)).toBeUndefined();
		});
	});

	describe('the looksLikeRangeHint gate EARNS its keep', () => {
		it('yields no range for an ARCHIVE refusal, which is a -32602 about something else entirely', () => {
			// ethereum-rpc.publicnode.com, captured 2026-09-08 and byte-identical to the
			// 2026-06-30 capture. This is the case the gate exists for: a -32602 that
			// mentions neither "results" nor "block range", so it must never be read as a
			// range hint. No range size satisfies it -- the endpoint simply does not serve
			// history -- and treating it as one would have the fetcher shrink for ever.
			const err = rpcError(
				-32602,
				'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode',
			);
			expect(getNewToBlockFromError(err)).toBeUndefined();
		});

		it('does not mis-parse a bracketed pair out of a -32602 that is not about ranges', () => {
			// The mutation test for the gate: DELETE looksLikeRangeHint and this returns
			// 0x2 instead of undefined, and the fetcher retries a two-block range against
			// an endpoint whose complaint had nothing to do with ranges.
			//
			// Constructed rather than captured, and the only way it can be: no provider in
			// the 2026-09-08 sweep put a bracketed HEX pair in an unrelated invalid-params
			// message, so the input that proves the gate bites has to be written. The real
			// refusals the gate rejects (the archive one above, Cronos's "[from, to]") are
			// asserted verbatim beside it; they document the gate, this one defends it.
			const err = rpcError(-32602, 'invalid argument 0: expected one of [0x1, 0x2]');
			expect(getNewToBlockFromError(err)).toBeUndefined();
		});

		it('returns undefined for a generic invalid-params error with no range info', () => {
			// mainnet.base.org answering a malformed filter, captured 2026-09-08.
			expect(getNewToBlockFromError(rpcError(-32602, 'invalid params'))).toBeUndefined();
		});
	});

	describe('shapes that are somebody else\u2019s job', () => {
		it('returns undefined for a -32603 "block range too large" error (handled in the retry)', () => {
			// The -32603 pair (Polygon "block range is too wide", Base "block range too
			// large") is read by getLogs itself to lower a ceiling, not by this function.
			expect(getNewToBlockFromError(rpcError(-32603, 'block range too large'))).toBeUndefined();
		});

		it('returns undefined for the codes nothing reads yet', () => {
			// mainnet.base.org, captured 2026-09-08.
			expect(getNewToBlockFromError(rpcError(-32614, 'eth_getLogs is limited to a 10,000 range'))).toBeUndefined();
			// eth-mainnet.g.alchemy.com/public, captured 2026-09-08: a suggested range under
			// a code the parser does not accept. Recorded in the spike for the task that
			// widens the accepted set; deliberately NOT widened here.
			const alchemyPublic = rpcError(
				-32600,
				'You can make eth_getLogs requests with up to a 100 block range. Based on your parameters, this block range should work: [0x100000, 0x100063]',
			);
			expect(getNewToBlockFromError(alchemyPublic)).toBeUndefined();
		});
	});

	describe('malformed errors do not throw', () => {
		it('does not throw when an accepted code has no message at all', () => {
			for (const code of [-32005, -32602, -32000]) {
				expect(() => getNewToBlockFromError(rpcError(code))).not.toThrow();
				expect(getNewToBlockFromError(rpcError(code))).toBeUndefined();
			}
		});

		it('does not throw on an empty error object, or on nothing at all', () => {
			expect(getNewToBlockFromError({} as any)).toBeUndefined();
			expect(getNewToBlockFromError(undefined as any)).toBeUndefined();
			expect(getNewToBlockFromError(null as any)).toBeUndefined();
		});
	});
});

const passThrough = <T>(p: Promise<T>) => p;

/**
 * A provider that REFUSES every `eth_getLogs` whose span is wider than `answersUpTo`
 * blocks, with a body a real endpoint really sent, and records the spans it was asked
 * for.
 *
 * The spans are the measurement: what the fetcher does with a refusal is invisible in
 * the answer (it is an empty log list either way) and visible only in the range it
 * asks for NEXT.
 */
function refusingProvider(refusal: any, answersUpTo: number) {
	const spans: {fromBlock: number; toBlock: number}[] = [];
	const provider = {
		async request(args: {method: string; params?: any}): Promise<any> {
			if (args.method !== 'eth_getLogs') throw new Error(`unexpected method ${args.method}`);
			const fromBlock = parseInt(args.params[0].fromBlock.slice(2), 16);
			const toBlock = parseInt(args.params[0].toBlock.slice(2), 16);
			spans.push({fromBlock, toBlock});
			if (toBlock - fromBlock + 1 > answersUpTo) {
				throw refusal;
			}
			return [];
		},
	};
	return {provider: provider as any, spans};
}

/**
 * The other half of the claim: the parser above is only worth anything through the
 * range the RETRY then asks for. Both cases live here because they are the same
 * mechanism seen from either side -- a hint that was read, and a hint that was not.
 */
describe('what the fetcher does with a refusal', () => {
	it('still HALVES against a provider that says nothing useful', async () => {
		// bsc-dataseed.bnbchain.org, captured 2026-09-08: a -32005 with no suggested
		// range and no `data` at all. This is the unknown-endpoint case, which the
		// halving fallback is what makes work, and which nothing here may make worse.
		const {provider, spans} = refusingProvider({code: -32005, message: 'limit exceeded'}, 300);
		const fetcher = new RangeLogFetcher(provider, null, null, {numBlocksToFetchAtStart: 1000});

		const result = await fetcher.getLogs({fromBlock: 1, toBlock: 100000}, passThrough);

		expect(spans.map((s) => s.toBlock - s.fromBlock + 1)).toEqual([1000, 499, 249]);
		expect(result.toBlockUsed).toBe(249);
	});

	it('shrinks to the range the provider named, rather than halving, when it named one', async () => {
		// Infura, quoted verbatim in ethers-io/ethers.js#4703, hint in `data` ONLY:
		// the message is Infura's no-suggestion phrasing, so halving is what a reader
		// of the prose alone would do. The blocks are the capture's own.
		const refusal = {
			code: -32005,
			data: {from: '0xBDE5F8', limit: 10000, to: '0x102DBCC'},
			message: 'query returned more than 10000 results',
		};
		const {provider, spans} = refusingProvider(refusal, 4_000_000);
		const fetcher = new RangeLogFetcher(provider, null, null, {
			numBlocksToFetchAtStart: 10_000_000,
			maxBlocksPerFetch: 10_000_000,
		});

		await fetcher.getLogs({fromBlock: 0xbde5f8, toBlock: 0xbde5f8 + 9_999_999}, passThrough);

		// 0xBDE5F8..0x102DBCC is 4,519,381 blocks; the retry asks for 80% of what the
		// node said it could serve, which is 3,615,504 -- and NOT the 5,000,000 that
		// halving would have asked for.
		expect(spans.map((s) => s.toBlock - s.fromBlock + 1)).toEqual([10_000_000, 3_615_504]);
	});
});
