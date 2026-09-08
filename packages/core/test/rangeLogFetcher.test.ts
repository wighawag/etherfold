import {describe, expect, it} from 'vitest';
import {
	archiveRefusalFromError,
	getNewToBlockFromError,
	RangeLogFetcher,
	statedBlockCapFromError,
} from '../src/internal/engine/RangeLogFetcher.js';

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

describe('archiveRefusalFromError', () => {
	describe('a refusal that IDENTIFIES itself as an archive gate is terminal', () => {
		it('recognises the captured publicnode refusal', () => {
			// ethereum-rpc.publicnode.com, captured 2026-09-08, byte-identical to the
			// 2026-06-30 capture in the finding. The one shape this classifier is built on.
			const err = rpcError(
				-32602,
				'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode',
			);
			expect(archiveRefusalFromError(err)).toBe(err.message);
		});

		it('reads the same refusal out of `data`, as the range parser does', () => {
			// CONSTRUCTED, and labelled: no captured archive refusal puts its text in `data`.
			// It is read there anyway because that is where Nethermind puts the whole of a
			// range hint (Gnosis, Fraxtal, captured 2026-09-08) while leaving the message at
			// "invalid params", so a refusal reaching only `data` is a shape this codebase has
			// already met once.
			const asString = rpcError(-32602, 'invalid params', 'Archive requests require a personal token.');
			expect(archiveRefusalFromError(asString)).toBe('Archive requests require a personal token.');
			const nested = rpcError(-32603, 'internal error', {message: 'archive data is not enabled on this endpoint'});
			expect(archiveRefusalFromError(nested)).toBe('archive data is not enabled on this endpoint');
		});
	});

	describe('anything AMBIGUOUS keeps today\u2019s behaviour', () => {
		it('does not classify a refusal that merely mentions an archive', () => {
			// CONSTRUCTED. This is the false-terminal hazard in one line: an archive node
			// that is catching up answers again in an hour, and calling that terminal stops
			// an indexer for a blip. Nothing here says the history is GATED, so it halves
			// and retries exactly as before.
			expect(archiveRefusalFromError(rpcError(-32000, 'archive node is syncing, try again later'))).toBeUndefined();
			expect(archiveRefusalFromError(rpcError(-32603, 'archive backend temporarily unavailable'))).toBeUndefined();
		});

		it('does not classify a credential refusal that says nothing about history', () => {
			// rpc.ankr.com/eth, captured 2026-09-08. A real token refusal, and deliberately
			// NOT this: it is about the endpoint as a whole rather than about serving
			// history, and widening to it would make every unauthenticated blip terminal.
			const ankr = rpcError(
				-32000,
				'Unauthorized: You must authenticate your request with an API key. Create an account on https://www.ankr.com/rpc/ and generate your personal API key for free.',
			);
			expect(archiveRefusalFromError(ankr)).toBeUndefined();
		});

		it('does not classify a range refusal, which is what halving is for', () => {
			// All captured 2026-09-08: zkevm-rpc.com, 1rpc.io/eth, evm.cronos.org,
			// rpc.mevblocker.io (whose narrower spans answered with this).
			expect(archiveRefusalFromError(rpcError(-32000, 'block range too large, max range: 10000'))).toBeUndefined();
			expect(
				archiveRefusalFromError(rpcError(-32602, 'eth_getLogs is limited to 0 - 50 blocks range')),
			).toBeUndefined();
			expect(archiveRefusalFromError(rpcError(-32000, 'maximum [from, to] blocks distance: 2000'))).toBeUndefined();
			expect(archiveRefusalFromError(rpcError(-32603, 'service temporarily unavailable'))).toBeUndefined();
		});

		it('does not classify a transport failure, which carries no provider text at all', () => {
			expect(archiveRefusalFromError(new Error('socket hang up'))).toBeUndefined();
			expect(archiveRefusalFromError(new Error('fetch failed'))).toBeUndefined();
		});

		it('does not throw on a malformed or absent error', () => {
			expect(archiveRefusalFromError({} as any)).toBeUndefined();
			expect(archiveRefusalFromError(rpcError(-32602))).toBeUndefined();
			expect(archiveRefusalFromError(undefined as any)).toBeUndefined();
			expect(archiveRefusalFromError(null as any)).toBeUndefined();
		});
	});

	it('leaves the range parser alone: an archive refusal still yields NO range hint', () => {
		// The two functions read the same error and must not overlap. The gate test above
		// pins the other half of this.
		const err = rpcError(
			-32602,
			'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode',
		);
		expect(getNewToBlockFromError(err)).toBeUndefined();
		expect(archiveRefusalFromError(err)).toBe(err.message);
	});
});

/**
 * Alchemy's refusal, quoted verbatim in ethers-io/ethers.js#4703 and used in
 * several places below. It is the shape the whole cap-extraction exists for: it
 * states TWO caps in one sentence -- a 2K BLOCK span and a 10K LOG count -- and
 * then suggests a range that honours only the second.
 */
const ALCHEMY_TWO_CAPS =
	'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response. Based on your parameters and the response size limit, this block range should work: [0x0, 0xd043b8]';

describe('statedBlockCapFromError', () => {
	describe('a cap stated in PROSE is extracted', () => {
		it('reads the two shapes the finding named, unit suffix included', () => {
			// Alchemy, quoted verbatim in ethers-io/ethers.js#4703. `2K` is the block span;
			// the `10K logs` beside it is a RESULT cap and must not be read as one.
			expect(statedBlockCapFromError(rpcError(-32602, ALCHEMY_TWO_CAPS))).toBe(2000);
			// Quoted in ethers-io/ethers.js#1816, and live today on rpc.immutable.com as
			// "exceeded maximum block range: 5000" (captured 2026-09-08).
			expect(statedBlockCapFromError(rpcError(-32602, 'Exceed maximum block range: 5000'))).toBe(5000);
		});

		it('reads the -32000 shapes that state their cap in prose and nowhere else', () => {
			// zkevm-rpc.com, captured 2026-09-08.
			expect(statedBlockCapFromError(rpcError(-32000, 'block range too large, max range: 10000'))).toBe(10000);
			// rpc.merlinchain.io, captured 2026-09-08.
			expect(statedBlockCapFromError(rpcError(-32000, 'block range too large, max range: 2000'))).toBe(2000);
			// rpc.immutable.com, captured 2026-09-08.
			expect(statedBlockCapFromError(rpcError(-32000, 'exceeded maximum block range: 5000'))).toBe(5000);
			// api.avax.network/ext/bc/C/rpc, captured 2026-09-08. The two block NUMBERS in
			// front of the cap are the range that was refused, not a cap.
			expect(
				statedBlockCapFromError(
					rpcError(-32000, 'requested too many blocks from 50331648 to 51380224, maximum is set to 2048'),
				),
			).toBe(2048);
			// flare-api.flare.network/ext/C/rpc, captured 2026-09-08.
			expect(
				statedBlockCapFromError(
					rpcError(-32000, 'requested too many blocks from 1048576 to 17825792, maximum is set to 30'),
				),
			).toBe(30);
			// rpc.soniclabs.com, captured 2026-09-08.
			expect(statedBlockCapFromError(rpcError(-32000, 'too wide blocks range, the limit is 100'))).toBe(100);
			// evm.cronos.org, captured 2026-09-08, `data` genuinely null on the wire. The
			// bracketed pair is a parameter-name list, which is why the range parser refuses
			// this message and the cap reader still gets its number out of it.
			expect(statedBlockCapFromError(rpcError(-32000, 'maximum [from, to] blocks distance: 2000', null))).toBe(2000);
			// evm.kava.io, captured 2026-09-08.
			expect(statedBlockCapFromError(rpcError(-32000, 'maximum [from, to] blocks distance: 10000'))).toBe(10000);
		});

		it('reads a cap stated under any other code, including ones nothing else reads', () => {
			// 1rpc.io/eth, captured 2026-09-08: the cap is the SECOND number, the first being
			// the bottom of the stated interval.
			expect(statedBlockCapFromError(rpcError(-32602, 'eth_getLogs is limited to 0 - 50 blocks range'))).toBe(50);
			// forno.celo.org, captured 2026-09-08: the cap and the refused span in one line.
			expect(
				statedBlockCapFromError(
					rpcError(-32602, 'query exceeds range, retry smaller (max block range 5000, got 16777216)'),
				),
			).toBe(5000);
			// rpc.mantle.xyz, captured 2026-09-08.
			expect(statedBlockCapFromError(rpcError(-32602, 'block range greater than 10000 max'))).toBe(10000);
			// mainnet.base.org, captured 2026-09-08, under -32614 -- a code no other path here
			// accepts. A cap is identified by its TEXT, so the code is not a gate.
			expect(statedBlockCapFromError(rpcError(-32614, 'eth_getLogs is limited to a 10,000 range'))).toBe(10000);
			// eth-mainnet.g.alchemy.com/public, captured 2026-09-08, under -32600.
			expect(
				statedBlockCapFromError(
					rpcError(
						-32600,
						'You can make eth_getLogs requests with up to a 100 block range. Based on your parameters, this block range should work: [0x100000, 0x100063]',
					),
				),
			).toBe(100);
			// eth-mainnet.public.blastapi.io, captured 2026-09-08, under -32600.
			expect(
				statedBlockCapFromError(
					rpcError(
						-32600,
						'You can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x18b0000, 0x18b0009]',
					),
				),
			).toBe(10);
			// cloudflare-eth.com, captured 2026-09-08, under -32047.
			expect(
				statedBlockCapFromError(
					rpcError(-32047, "Invalid eth_getLogs request. 'fromBlock'-'toBlock' range too large. Max range: 800"),
				),
			).toBe(800);
		});

		it('reads a cap out of `data`, as the other two readers do', () => {
			// api.roninchain.com/rpc, captured 2026-09-08: a Nethermind-style refusal whose
			// whole complaint is in `data` behind a bare "Invalid params". The range parser
			// finds nothing machine-readable here; the stated 200 is the whole hint.
			const ronin = rpcError(
				-32602,
				'Invalid params',
				'requested block range 16777217 exceeds the limit of 200; narrow your fromBlock/toBlock',
			);
			expect(statedBlockCapFromError(ronin)).toBe(200);
			// polygon rpc's -32603, whose text is nested one level deeper. It states no
			// number, so it stays what it is today: a ceiling lowered to the span refused.
			expect(statedBlockCapFromError(rpcError(-32603, 'internal error', {message: 'block range is too wide'}))).toBe(
				undefined,
			);
		});

		it('takes the LOWEST cap when a refusal states more than one', () => {
			// CONSTRUCTED from two captured phrasings (rpc.merlinchain.io and 1rpc.io/eth,
			// both 2026-09-08). Reading several and keeping the smallest is what makes the
			// answer independent of the order the patterns happen to be tried in.
			const err = rpcError(-32000, 'block range too large, max range: 2000');
			err.data = 'eth_getLogs is limited to 0 - 50 blocks range';
			expect(statedBlockCapFromError(err)).toBe(50);
		});
	});

	describe('a RESULT cap is never read as a block cap', () => {
		it('reads nothing from a refusal that counts logs rather than blocks', () => {
			// arb1.arbitrum.io/rpc and nova.arbitrum.io/rpc, captured 2026-09-08: 10000 is a
			// RESULT cap. Read as a block span it would be a wrong ceiling, and the block
			// span that endpoint really allows is not stated anywhere in the message.
			expect(statedBlockCapFromError(rpcError(-32000, 'logs matched by query exceeds limit of 10000'))).toBeUndefined();
			// Infura, quoted verbatim in ethers-io/ethers.js#4703: a result cap beside a
			// suggested block range. The suggested range is read by getNewToBlockFromError;
			// the 10000 is not a ceiling on anything this fetcher measures in blocks.
			expect(
				statedBlockCapFromError(
					rpcError(-32005, 'query returned more than 10000 results. Try with this block range [0xBDE5F8, 0x102DBCC].'),
				),
			).toBeUndefined();
			// rpc.gnosischain.com (Nethermind), captured 2026-09-08, hint in `data`.
			expect(
				statedBlockCapFromError(
					rpcError(
						-32602,
						'invalid params',
						'Query returned more than 50000 results. Try with this block range [0x1000000, 0x1080000].',
					),
				),
			).toBeUndefined();
			// rpc.pulsechain.com, captured 2026-09-08: a range complaint with no number in it
			// at all.
			expect(
				statedBlockCapFromError(
					rpcError(-32000, 'query returned more than allowed number of logs, try with smaller block range'),
				),
			).toBeUndefined();
			// bsc-dataseed.bnbchain.org, captured 2026-09-08.
			expect(statedBlockCapFromError(rpcError(-32005, 'limit exceeded'))).toBeUndefined();
		});

		it('reads nothing from a refusal that is not about ranges at all', () => {
			// ethereum-rpc.publicnode.com, captured 2026-09-08. Terminal, and no number in it
			// may become a ceiling.
			expect(
				statedBlockCapFromError(
					rpcError(
						-32602,
						'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode',
					),
				),
			).toBeUndefined();
			// mainnet.base.org answering a malformed filter, captured 2026-09-08.
			expect(statedBlockCapFromError(rpcError(-32602, 'invalid params'))).toBeUndefined();
			// rpc.ankr.com/eth, captured 2026-09-08.
			expect(
				statedBlockCapFromError(
					rpcError(
						-32000,
						'Unauthorized: You must authenticate your request with an API key. Create an account on https://www.ankr.com/rpc/ and generate your personal API key for free.',
					),
				),
			).toBeUndefined();
		});
	});

	describe('a number that cannot be a block count is ignored rather than trusted', () => {
		it('ignores zero and negative caps', () => {
			// CONSTRUCTED, on the captured immutable/ethers#1816 phrasing. A ceiling of zero
			// or less bounds the fetcher to nothing at all, so it is read as a misparse.
			expect(statedBlockCapFromError(rpcError(-32000, 'exceeded maximum block range: 0'))).toBeUndefined();
			expect(statedBlockCapFromError(rpcError(-32000, 'exceeded maximum block range: -5000'))).toBeUndefined();
		});

		it('ignores a number too large to be a block-span cap', () => {
			// CONSTRUCTED, on the captured zkevm phrasing. No provider caps eth_getLogs
			// anywhere near this; a number this size is something else that a pattern
			// happened to sit next to.
			expect(statedBlockCapFromError(rpcError(-32000, 'block range too large, max range: 4294967296'))).toBeUndefined();
			expect(
				statedBlockCapFromError(rpcError(-32000, 'block range too large, max range: 1701411834604692317316873')),
			).toBeUndefined();
		});

		it('ignores a number that is not whole', () => {
			// CONSTRUCTED. Blocks are counted, so a fraction of one is a misparse.
			expect(statedBlockCapFromError(rpcError(-32000, 'exceeded maximum block range: 2.5'))).toBeUndefined();
		});
	});

	describe('malformed errors do not throw', () => {
		it('does not throw on an empty error, a missing message, or nothing at all', () => {
			expect(statedBlockCapFromError({} as any)).toBeUndefined();
			expect(statedBlockCapFromError(rpcError(-32000))).toBeUndefined();
			expect(statedBlockCapFromError(undefined as any)).toBeUndefined();
			expect(statedBlockCapFromError(null as any)).toBeUndefined();
			expect(statedBlockCapFromError(new Error('socket hang up'))).toBeUndefined();
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
 * The same, for a sequence of DIFFERENT refusals: the nth refused request gets the
 * nth body, and the last one repeats. Needed because the only-ever-lower rule is a
 * statement about what a SECOND refusal may do to what a first one established.
 */
function refusingProviderInTurn(refusals: any[], answersUpTo: number) {
	const spans: {fromBlock: number; toBlock: number}[] = [];
	let refused = 0;
	const provider = {
		async request(args: {method: string; params?: any}): Promise<any> {
			if (args.method !== 'eth_getLogs') throw new Error(`unexpected method ${args.method}`);
			const fromBlock = parseInt(args.params[0].fromBlock.slice(2), 16);
			const toBlock = parseInt(args.params[0].toBlock.slice(2), 16);
			spans.push({fromBlock, toBlock});
			if (toBlock - fromBlock + 1 > answersUpTo) {
				throw refusals[Math.min(refused++, refusals.length - 1)];
			}
			return [];
		},
	};
	return {provider: provider as any, spans};
}

/** Reads the discovered ceiling, which is otherwise visible only through arithmetic. */
class CeilingProbe extends RangeLogFetcher {
	get discoveredCeiling(): number | undefined {
		return this.foundNumBlockToHigh;
	}
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

	it('stops on an ARCHIVE refusal instead of halving through the retry budget', async () => {
		// ethereum-rpc.publicnode.com, captured 2026-09-08 and byte-identical to the
		// 2026-06-30 capture. `answersUpTo: 0` is the endpoint's real behaviour for a
		// backfill: it refuses EVERY span, because the complaint is about the history
		// being behind a token and not about the width of the window asked for.
		const {provider, spans} = refusingProvider(
			rpcError(-32602, 'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode'),
			0,
		);
		const fetcher = new RangeLogFetcher(provider, null, null, {numBlocksToFetchAtStart: 1000});

		const failure = await fetcher.getLogs({fromBlock: 1, toBlock: 100000}, passThrough).catch((err) => err);

		// ONE request: the budget is not burned halving 1000 -> 499 -> 249 for a refusal
		// no range size satisfies.
		expect(spans.length).toBe(1);
		expect(failure.name).toBe('ArchiveRefusedError');
		// the operator reads the real cause rather than the last range error
		expect(failure.message).toMatch(/archive/i);
		expect(failure.message).toContain('Archive requests require a personal token');
		// structurally non-retryable, which is what stops the host retrying it with backoff
		expect(failure.retryable).toBe(false);
	});

	it('still halves against an archive mention it cannot classify', async () => {
		// CONSTRUCTED, and the near-miss that decides the width of the classifier: an
		// archive node catching up answers again shortly, so this must keep TODAY's
		// behaviour end to end -- halve, retry, and deliver what the endpoint would serve.
		const {provider, spans} = refusingProvider(rpcError(-32000, 'archive node is syncing, try again later'), 300);
		const fetcher = new RangeLogFetcher(provider, null, null, {numBlocksToFetchAtStart: 1000});

		const result = await fetcher.getLogs({fromBlock: 1, toBlock: 100000}, passThrough);

		expect(spans.map((s) => s.toBlock - s.fromBlock + 1)).toEqual([1000, 499, 249]);
		expect(result.toBlockUsed).toBe(249);
	});

	it('lets a transient NETWORK failure exhaust the budget and stay retryable', async () => {
		// The hazard of this classifier is the opposite one: a false terminal stops an
		// indexer fast and wrongly, where grinding is merely slow and visible. A dropped
		// socket carries no opinion, so it must reach the caller as it always did.
		const spans: number[] = [];
		const provider = {
			async request(args: {method: string; params?: any}): Promise<any> {
				spans.push(args.params[0].fromBlock);
				throw new Error('socket hang up');
			},
		} as any;
		const fetcher = new RangeLogFetcher(provider, null, null, {numBlocksToFetchAtStart: 1000});

		const failure = await fetcher.getLogs({fromBlock: 1, toBlock: 100000}, passThrough).catch((err) => err);

		expect(failure.name).toBe('Error');
		expect(failure.message).toBe('socket hang up');
		// no `retryable` at all, which every reader in this repo takes as "retry it"
		expect((failure as {retryable?: boolean}).retryable).toBeUndefined();
		// the whole budget was spent: one attempt plus the default three retries
		expect(spans.length).toBe(4);
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

	it('holds a STATED cap as a ceiling over the range the same refusal suggested', async () => {
		// Alchemy, quoted verbatim in ethers-io/ethers.js#4703, and the reason a stated cap
		// is worth reading at all: the suggested range honours the 10K LOG cap and ignores
		// the 2K BLOCK one, so following the suggestion alone asks for 13.6M blocks against
		// an endpoint that has just said 2,000 is its maximum. `answersUpTo` is that real cap.
		const {provider, spans} = refusingProvider(rpcError(-32602, ALCHEMY_TWO_CAPS), 2000);
		const fetcher = new CeilingProbe(provider, null, null, {
			numBlocksToFetchAtStart: 10_000_000,
			maxBlocksPerFetch: 10_000_000,
		});

		const result = await fetcher.getLogs({fromBlock: 0, toBlock: 13_649_336}, passThrough);

		// the suggestion alone would have asked for 80% of 13,649,337 blocks; the ceiling
		// bounds it to one block under the cap the same message stated.
		expect(spans.map((s) => s.toBlock - s.fromBlock + 1)).toEqual([10_000_000, 1999]);
		expect(fetcher.discoveredCeiling).toBe(2000);
		expect(result.toBlockUsed).toBe(1998);
	});

	it('never RAISES the ceiling, whatever number a later refusal states', async () => {
		// Two captured bodies of ONE shape with different numbers: rpc.merlinchain.io
		// (2000) then zkevm-rpc.com (10000), both 2026-09-08. The second is what a misparse
		// looks like from the inside -- a bigger number arriving after a smaller one -- and
		// it must not widen what the fetcher asks for, because asking wider only earns
		// another refusal and re-discovers the same limit the slow way.
		const {provider, spans} = refusingProviderInTurn(
			[
				rpcError(-32000, 'block range too large, max range: 2000'),
				rpcError(-32000, 'block range too large, max range: 10000'),
			],
			1500,
		);
		const fetcher = new CeilingProbe(provider, null, null, {
			numBlocksToFetchAtStart: 100_000,
			maxBlocksPerFetch: 100_000,
		});

		await fetcher.getLogs({fromBlock: 1, toBlock: 1_000_000}, passThrough);
		expect(fetcher.discoveredCeiling).toBe(2000);

		// and the NEXT cycle is still bounded by 2000: had the second refusal raised the
		// ceiling to 10000, the bisection above it would have asked for 5,499 blocks here.
		await fetcher.getLogs({fromBlock: 1000, toBlock: 1_000_000}, passThrough);

		expect(spans.map((s) => s.toBlock - s.fromBlock + 1)).toEqual([100_000, 1999, 999, 1499]);
		expect(fetcher.discoveredCeiling).toBe(2000);
	});

	it('leaves a refusal that states NO cap halving exactly as before', async () => {
		// rpc.pulsechain.com, captured 2026-09-08: a range complaint carrying no number,
		// which is the majority case. No ceiling is discovered and the spans are the
		// halving sequence, block for block.
		const {provider, spans} = refusingProvider(
			rpcError(-32000, 'query returned more than allowed number of logs, try with smaller block range'),
			300,
		);
		const fetcher = new CeilingProbe(provider, null, null, {numBlocksToFetchAtStart: 1000});

		const result = await fetcher.getLogs({fromBlock: 1, toBlock: 100000}, passThrough);

		expect(spans.map((s) => s.toBlock - s.fromBlock + 1)).toEqual([1000, 499, 249]);
		expect(result.toBlockUsed).toBe(249);
		expect(fetcher.discoveredCeiling).toBeUndefined();
	});

	it('asks for at least one block, even for a provider that states a one-block cap', async () => {
		// CONSTRUCTED on the captured 1rpc.io/eth phrasing, whose real cap is 50. A cap of
		// one is the edge of the ceiling's arithmetic (it bounds the next range to zero
		// blocks, which inverts it), and an inverted range is a request no node can answer
		// and a bug hunt for whoever meets it.
		const {provider, spans} = refusingProvider(rpcError(-32602, 'eth_getLogs is limited to 0 - 1 blocks range'), 1);
		const fetcher = new CeilingProbe(provider, null, null, {numBlocksToFetchAtStart: 1000});

		const result = await fetcher.getLogs({fromBlock: 1, toBlock: 100000}, passThrough);

		expect(spans.map((s) => s.toBlock - s.fromBlock + 1)).toEqual([1000, 1]);
		expect(result.toBlockUsed).toBe(1);
		expect(fetcher.discoveredCeiling).toBe(1);
	});
});
