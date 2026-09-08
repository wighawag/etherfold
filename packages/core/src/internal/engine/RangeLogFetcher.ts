import {EIP1193Account, EIP1193DATA, EIP1193ProviderWithoutEvents} from 'eip-1193';
import {logs} from 'named-logs';
import {ArchiveRefusedError} from '../../errors.js';
import {IncludedEIP1193Log} from '../../types.js';
import {UnlessCancelledFunction} from '../utils/promises.js';
import {canOccurIn, type TopicBlockRanges} from './eventRanges.js';
import {ExtraFilters, getLogsWithVariousFilters} from './ethereum.js';

const namedLogger = logs('@etherfold/core');

type InternalLogFetcherConfig = {
	numBlocksToFetchAtStart: number;
	maxBlocksPerFetch: number;
	percentageToReach: number;
	maxEventsPerFetch: number;
	numRetry: number;
};

export type LogsResult = {logs: IncludedEIP1193Log[]; toBlockUsed: number};

export type LogFetcherConfig = {
	numBlocksToFetchAtStart?: number;
	maxBlocksPerFetch?: number;
	percentageToReach?: number;
	maxEventsPerFetch?: number;
	numRetry?: number;
	filters?: ExtraFilters;
};

/**
 * Whether a piece of provider text is complaining about a RANGE at all.
 *
 * This gate looks redundant and is not: `-32602` and `-32000` are GENERIC codes,
 * so a refusal arriving under one may be about anything. The case it earns its
 * keep on is a real one -- `ethereum-rpc.publicnode.com` refuses history with
 * `-32602 "Archive requests require a personal token..."`, which mentions
 * neither marker -- and the cost of getting it wrong is not a missed hint but a
 * BOGUS one: a bracketed pair lifted out of an unrelated message becomes a
 * `toBlock` the fetcher then retries against, for a refusal no range size can
 * ever satisfy. Widening the accepted CODES (below) is therefore not a licence
 * to widen these two markers. That same archive refusal is now also RECOGNISED,
 * by {@link archiveRefusalFromError}, and reported as terminal instead of being
 * halved at; this gate is what keeps the two from ever reading it as a range.
 *
 * Pinned by `packages/core/test/rangeLogFetcher.test.ts`.
 */
function looksLikeRangeHint(text: unknown): text is string {
	return typeof text === 'string' && (text.indexOf('results') !== -1 || text.indexOf('block range') !== -1);
}

/**
 * The `toBlock` a provider SUGGESTED in prose, as `[0x..., 0x...]`.
 *
 * `"query returned more than 10000 results. Try with this block range [0xEC23E8, 0xEC23F5]."`
 * -> `0xEC23F5`. Only ever called on text that passed {@link looksLikeRangeHint},
 * or under a code that means nothing else.
 */
function suggestedToBlockFromProse(text: string): number | undefined {
	const regex = /\[.*\]/gm;
	const result = regex.exec(text);
	if (!result || !result[0]) {
		return undefined;
	}
	const values = result[0]
		.slice(1, result[0].length - 1)
		.split(', ')
		.map((v) => parseInt(v.slice(2), 16));
	return isNaN(values[1]) ? undefined : values[1];
}

/**
 * The `toBlock` a provider stated as STRUCTURED data: `{from, to, limit}`.
 *
 * Infura sends exactly this alongside the same information in English
 * (`{"code":-32005,"data":{"from":"0xBDE5F8","limit":10000,"to":"0x102DBCC"},...}`,
 * quoted verbatim in ethers-io/ethers.js#4703), and it is the one shape that says
 * what to do next without a regex over prose.
 *
 * `limit` is REQUIRED even though only `to` is read, and that is the gate of this
 * path rather than a formality: `limit` is the node's own cap, so an object
 * carrying it is DESCRIBING A REFUSAL, while an object carrying a bare `to` might
 * just as well be a provider echoing the request back (some do put the request
 * body in `data`). Reading `to` out of an echo would hand the retry the very
 * range that was refused. `from` is not needed and is not required.
 */
function suggestedToBlockFromStructuredData(data: any): number | undefined {
	if (!data || typeof data !== 'object') {
		return undefined;
	}
	if (typeof data.to !== 'string' || typeof data.limit !== 'number') {
		return undefined;
	}
	const to = parseInt(data.to.slice(0, 2).toLowerCase() === '0x' ? data.to.slice(2) : data.to, 16);
	return isNaN(to) ? undefined : to;
}

/**
 * How far a refused `eth_getLogs` range should shrink, according to the node that
 * refused it, or `undefined` when the node said nothing usable and the caller
 * should fall back to halving.
 *
 * A node REFUSES an oversized query rather than truncating it, and it bounds the
 * method in one of two incompatible ways -- a BLOCK SPAN or a RESULT COUNT -- which
 * is why no fixed page size works and why the caller adapts. What it says while
 * refusing is read from the most reliable place first:
 *
 * 1. `error.data` as a `{from, to, limit}` descriptor (Infura), which is the
 *    answer without a regex;
 * 2. `error.data` as PROSE, which is where Nethermind puts the whole hint while
 *    leaving the message at a bare `"invalid params"` (Gnosis, Fraxtal), so a
 *    reader that only looked at the message discarded it entirely;
 * 3. the message.
 *
 * Three codes are accepted. `-32005` (limit exceeded) means one thing, so it needs
 * no gate. `-32602` (invalid params) and `-32000` (a widely used generic server
 * error, which several providers put range complaints behind: Polygon zkEVM,
 * PulseChain, Merlin, Immutable) are GENERIC, so each piece of text is read only
 * if it passes {@link looksLikeRangeHint} ON ITS OWN -- never on the strength of
 * the other, or a hint in `data` would license lifting a bracketed pair out of an
 * unrelated message. The STRUCTURED path takes no hint gate, because that gate is
 * for disambiguating PROSE and a `{to, limit}` descriptor is not prose; what
 * guards it is the required `limit`, above.
 *
 * Everything here is additive to the caller's halving fallback, which is what
 * makes the fetcher work against an endpoint that says nothing useful at all.
 *
 * Captured refusal shapes, their providers and their dates:
 * `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` and
 * `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/`.
 */
export function getNewToBlockFromError(error: any): number | undefined {
	if (!error) {
		return undefined;
	}
	const code = error.code;
	if (code !== -32005 && code !== -32602 && code !== -32000) {
		return undefined;
	}
	// -32005 says "limit exceeded" and nothing else; the other two are generic codes
	// that carry a range complaint only when the text says so.
	const needsAHint = code !== -32005;

	const message: string | undefined = error.message;
	if (message && message.startsWith('query returned more than 10000 results.')) {
		// query returned more than 10000 results. Try with this block range [0xEC23E8, 0xEC23F5].
		namedLogger.error(message);
	}

	const structured = suggestedToBlockFromStructuredData(error.data);
	if (structured !== undefined) {
		return structured;
	}

	// `data` before `message`: a provider that fills both in says the same thing
	// twice, and a provider that fills in only `data` (Nethermind) says it only there.
	for (const text of [error.data, message]) {
		if (typeof text !== 'string') {
			continue;
		}
		if (needsAHint && !looksLikeRangeHint(text)) {
			continue;
		}
		const toBlock = suggestedToBlockFromProse(text);
		if (toBlock !== undefined) {
			return toBlock;
		}
	}
	return undefined;
}

/**
 * A number token as a provider writes a cap: `5000`, `10,000`, `2K`, `-1`.
 *
 * The sign is CAPTURED rather than excluded so that a negative cap arrives at
 * {@link plausibleBlockCap} and is REFUSED there, instead of a leading `-` being
 * skipped and `-5000` read as `5000`. The unit suffix must END a word, or the `m`
 * of Mantle's "block range greater than 10000 max" reads as a million.
 */
const CAP_NUMBER = String.raw`(-?\d[\d,_.]*(?:\s*[kKmM]\b)?)`;

/**
 * The phrasings in which a provider STATES the block span it will serve, each one
 * taken from a refusal a real endpoint really sent.
 *
 * Every pattern names its own UNIT, and that is the whole safety argument for
 * reading prose at all: providers cap this method by block span OR by result
 * count, the two differ by orders of magnitude, and the sentences look alike
 * (`exceeded maximum block range: 5000` against `logs matched by query exceeds
 * limit of 10000`). So a number is read only where the words next to it say
 * BLOCKS -- never on proximity to a bare `limit`, which is how Arbitrum states a
 * RESULT cap, and never from a `Try with this block range [0x.., 0x..]`
 * suggestion, which is {@link getNewToBlockFromError}'s job.
 *
 * The patterns are deliberately tight rather than general. A false positive is
 * not free: the ceiling only ever LOWERS, so a number lifted out of an unrelated
 * sentence pins the fetcher to a small range for the rest of the process, which
 * is slow and invisible. A MISS costs nothing but the halving path we would have
 * taken anyway, which is why shapes whose unit is unstated are left unread
 * (`range 16777216 exceeds limit of 10000`, Linea; `GetLogs query must be smaller
 * than size 1024`, Harmony).
 *
 * Captured 2026-09-08 unless noted:
 * `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/`.
 */
const STATED_BLOCK_CAP_PATTERNS: RegExp[] = [
	// Alchemy "up to a 2K block range" (ethers-io/ethers.js#4703), and the same
	// sentence live on eth-mainnet.g.alchemy.com/public (100) and
	// eth-mainnet.public.blastapi.io (10).
	new RegExp(String.raw`up to (?:a |an )?${CAP_NUMBER}[ -]?blocks? range`, 'i'),
	// rpc.immutable.com "exceeded maximum block range: 5000", ethers-io/ethers.js#1816
	// "Exceed maximum block range: 5000", forno.celo.org "max block range 5000, got
	// 16777216", zkevm-rpc.com and rpc.merlinchain.io "block range too large, max
	// range: 10000", cloudflare-eth.com "'fromBlock'-'toBlock' range too large. Max
	// range: 800".
	new RegExp(String.raw`max(?:imum)?(?: block)? range[:=]?\s*${CAP_NUMBER}`, 'i'),
	// rpc.mantle.xyz "block range greater than 10000 max".
	new RegExp(String.raw`blocks? range (?:greater|larger|more|bigger) than ${CAP_NUMBER}`, 'i'),
	// api.roninchain.com/rpc "requested block range 16777217 exceeds the limit of 200",
	// where the number BEFORE `exceeds` is the refused span, so the one after it is a
	// span too. Arbitrum's "logs matched by query exceeds limit of 10000" has no such
	// span in front of it and is deliberately not matched.
	new RegExp(String.raw`blocks? range \d[\d,_]*\s*exceeds (?:the )?limit of ${CAP_NUMBER}`, 'i'),
	// 1rpc.io/eth "eth_getLogs is limited to 0 - 50 blocks range", mainnet.base.org
	// "eth_getLogs is limited to a 10,000 range", QuickNode "eth_getLogs is limited to
	// a 5 range, upgrade from discover plan...". Anchored on the METHOD NAME, which is
	// what makes the unit unambiguous in the two that do not say `block`.
	new RegExp(
		String.raw`eth_?getlogs is limited to (?:a |an )?(?:\d[\d,_]*\s*-\s*)?${CAP_NUMBER}[ -]?(?:blocks? )?range`,
		'i',
	),
	// evm.cronos.org and evm.kava.io "maximum [from, to] blocks distance: 2000".
	new RegExp(String.raw`blocks? distance:?\s*${CAP_NUMBER}`, 'i'),
	// api.avax.network "requested too many blocks from 50331648 to 51380224, maximum is
	// set to 2048", flare-api.flare.network (30). Anchored at BOTH ends, because
	// "maximum is set to" alone says nothing about what is being counted.
	new RegExp(String.raw`too many blocks[\s\S]*?maximum is set to ${CAP_NUMBER}`, 'i'),
	// rpc.soniclabs.com "too wide blocks range, the limit is 100".
	new RegExp(String.raw`too wide blocks? range,? the limit is ${CAP_NUMBER}`, 'i'),
];

/**
 * A block-span cap is a COUNT OF BLOCKS, so anything a provider could not have
 * meant as one is dropped rather than believed.
 *
 * The upper bound is what a cap of this kind is FOR: the widest span any endpoint
 * in the 2026-09-08 sweep allowed was 10,000, the whole corpus fits in four
 * digits, and this fetcher's own default ceiling is 100,000 -- so a seven-figure
 * "cap" is not a cap being stated, it is a block number, a byte count or a result
 * total that a pattern happened to sit next to. Zero and negatives bound the
 * fetcher to nothing at all, and a fraction is not a count.
 */
const MIN_PLAUSIBLE_BLOCK_CAP = 1;
const MAX_PLAUSIBLE_BLOCK_CAP = 10_000_000;

/**
 * One cap TOKEN as a number: `10,000` -> 10000, `2K` -> 2000, `-1` -> -1.
 *
 * Reads the notation and judges nothing, because a number that is implausible as
 * a BLOCK span is not the same number that is implausible as a RESULT count. Each
 * caller applies its own bounds to what comes back.
 */
function capToken(token: string): number | undefined {
	const trimmed = token.trim();
	const suffix = trimmed.slice(-1);
	const multiplier = suffix === 'k' || suffix === 'K' ? 1000 : suffix === 'm' || suffix === 'M' ? 1_000_000 : 1;
	const digits = (multiplier === 1 ? trimmed : trimmed.slice(0, -1)).replace(/[,_\s]/g, '');
	const value = parseFloat(digits) * multiplier;
	return isNaN(value) ? undefined : value;
}

function plausibleBlockCap(token: string): number | undefined {
	const value = capToken(token);
	if (
		value === undefined ||
		!Number.isInteger(value) ||
		value < MIN_PLAUSIBLE_BLOCK_CAP ||
		value > MAX_PLAUSIBLE_BLOCK_CAP
	) {
		return undefined;
	}
	return value;
}

/** The lowest plausible cap stated anywhere in one piece of provider text. */
function statedBlockCapFromText(text: unknown): number | undefined {
	if (typeof text !== 'string') {
		return undefined;
	}
	let lowest: number | undefined;
	for (const pattern of STATED_BLOCK_CAP_PATTERNS) {
		const match = pattern.exec(text);
		if (!match) {
			continue;
		}
		const cap = plausibleBlockCap(match[1]);
		if (cap !== undefined && (lowest === undefined || cap < lowest)) {
			lowest = cap;
		}
	}
	return lowest;
}

/**
 * The number of blocks a provider SAID it will serve, written out in its refusal,
 * or `undefined` when it stated no such number.
 *
 * The third reader of one refusal, beside {@link getNewToBlockFromError} (how far
 * to shrink THIS retry) and {@link archiveRefusalFromError} (stop, this endpoint
 * serves no history). What this one produces is neither: it is a CEILING on every
 * range the fetcher will ask this provider for from now on, fed to the same field
 * a too-wide-range refusal already lowers, and it is emphatically not the size of
 * the next request -- a block-span cap says nothing about how many LOGS those
 * blocks hold, which is what the requested size is computed from.
 *
 * Two rules shape it, and they are the design rather than defensive dressing.
 *
 * **Only the words decide, and only where they name the unit.** Every pattern in
 * {@link STATED_BLOCK_CAP_PATTERNS} carries its own BLOCK anchor, because the
 * hazard is not failing to find a number, it is finding the WRONG KIND: a result
 * cap read as a block cap. The LOWEST plausible candidate wins, so the answer
 * does not depend on the order the patterns are tried in, and a message stating
 * two caps (Alchemy states a 2K block span and a 10K log count in one sentence)
 * yields the block one and not whichever matched first.
 *
 * **No error CODE gates this**, for the reason {@link archiveRefusalFromError}
 * takes no code either: the sweep found stated caps under `-32000`, `-32602`,
 * `-32614`, `-32600` and `-32047`, and the identifying evidence is the text. That
 * is affordable HERE, where it would not be for a suggested `toBlock`, because
 * the value can only ever LOWER a ceiling: a wrong read costs round trips, and
 * the caller (see {@link RangeLogFetcher.lowerBlockCeilingTo}) makes raising one
 * unexpressible.
 *
 * Read from `data` before the message, like both of its siblings, because that is
 * where a Nethermind-style node puts its whole complaint (api.roninchain.com
 * states its 200-block cap there behind a bare `"Invalid params"`).
 *
 * Captured refusal shapes, their providers and their dates:
 * `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` and
 * `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/`.
 */
export function statedBlockCapFromError(error: any): number | undefined {
	if (!error) {
		return undefined;
	}
	let lowest: number | undefined;
	for (const text of [error.data, error.data?.message, error.message]) {
		const cap = statedBlockCapFromText(text);
		if (cap !== undefined && (lowest === undefined || cap < lowest)) {
			lowest = cap;
		}
	}
	return lowest;
}

/**
 * The phrasings in which a provider REPORTS the number of logs it will return,
 * each one taken from a refusal a real endpoint really sent.
 *
 * The mirror image of {@link STATED_BLOCK_CAP_PATTERNS}, and the reason the two
 * lists exist separately rather than as one: providers cap this method by block
 * SPAN or by RESULT COUNT, the two differ by orders of magnitude, and the
 * sentences look alike. Every pattern here anchors on the word for what is being
 * COUNTED (`results`, `logs`), so `exceeded maximum block range: 5000` cannot
 * reach this reader and `logs matched by query exceeds limit of 10000` -- which
 * {@link STATED_BLOCK_CAP_PATTERNS} deliberately refuses -- is exactly what does.
 *
 * Captured 2026-09-08 unless noted:
 * `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/`.
 */
const REPORTED_RESULT_CAP_PATTERNS: RegExp[] = [
	// Infura (ethers-io/ethers.js#4703) "query returned more than 10000 results", and
	// the same sentence live on rpc.gnosischain.com (50000), rpc.chiadochain.net,
	// rpc.frax.com (20000), mainnet.era.zksync.io and api.mainnet.abs.xyz (10000).
	// rpc.pulsechain.com's "more than allowed number of logs" names no number, and
	// therefore matches nothing.
	new RegExp(String.raw`more than ${CAP_NUMBER}\s*(?:results|logs)\b`, 'i'),
	// arb1.arbitrum.io/rpc and nova.arbitrum.io/rpc "logs matched by query exceeds
	// limit of 10000". Anchored on the LOGS in front of the verb, which is what tells
	// this apart from Ronin's "block range 16777217 exceeds the limit of 200".
	new RegExp(String.raw`logs matched by query exceeds (?:the )?limit of ${CAP_NUMBER}`, 'i'),
	// Alchemy (ethers-io/ethers.js#4703) "you can request any block range with a cap of
	// 10K logs in the response", stated in the same sentence as its 2K BLOCK cap.
	new RegExp(String.raw`cap of ${CAP_NUMBER}\s*logs`, 'i'),
];

/**
 * A result cap is a COUNT OF LOGS, so a number a provider could not have meant as
 * one is dropped rather than believed -- and LOUDLY, because what it would have
 * become is the sharpest correctness knob in the fetcher.
 *
 * Zero and negatives would make every answer suspect (and a single block holding
 * any log at all unfetchable), a fraction is not a count, and the upper bound is
 * the same order-of-magnitude sanity check the block cap takes: the largest
 * result cap in the whole captured corpus is 50,000.
 */
const MIN_PLAUSIBLE_RESULT_CAP = 1;
const MAX_PLAUSIBLE_RESULT_CAP = 10_000_000;

function plausibleResultCap(value: number): number | undefined {
	if (!Number.isInteger(value) || value < MIN_PLAUSIBLE_RESULT_CAP || value > MAX_PLAUSIBLE_RESULT_CAP) {
		namedLogger.error(
			`a provider reported an eth_getLogs result cap of ${value}, which cannot be a count of logs: the report is ` +
				`IGNORED and the fetcher keeps the suspect count it already had. If that number is real, configure ` +
				`suspectResultCount, which wins over anything read off a refusal.`,
		);
		return undefined;
	}
	return value;
}

/**
 * The result cap a provider stated as STRUCTURED data: the `limit` of a
 * `{from, to, limit}` descriptor.
 *
 * `to` is REQUIRED here for the same reason `limit` is required by
 * {@link suggestedToBlockFromStructuredData}, with the roles swapped: the two
 * fields identify a REFUSAL DESCRIPTOR together, and neither is safe alone. A
 * bare `limit` is the field a provider ALSO uses for a request-rate allowance,
 * and reading a rate limit as a result cap would make the fetcher suspect every
 * answer holding that many logs and stop outright on a block that holds exactly
 * that many.
 */
function reportedResultCapFromStructuredData(data: any): number | undefined {
	if (!data || typeof data !== 'object') {
		return undefined;
	}
	if (typeof data.to !== 'string' || typeof data.limit !== 'number') {
		return undefined;
	}
	return plausibleResultCap(data.limit);
}

/** The lowest plausible result cap reported anywhere in one piece of provider text. */
function reportedResultCapFromText(text: unknown): number | undefined {
	if (typeof text !== 'string') {
		return undefined;
	}
	let lowest: number | undefined;
	for (const pattern of REPORTED_RESULT_CAP_PATTERNS) {
		const match = pattern.exec(text);
		if (!match) {
			continue;
		}
		const token = capToken(match[1]);
		const cap = token === undefined ? undefined : plausibleResultCap(token);
		if (cap !== undefined && (lowest === undefined || cap < lowest)) {
			lowest = cap;
		}
	}
	return lowest;
}

/**
 * The number of LOGS a provider said it will return, read off its own refusal, or
 * `undefined` when it reported no such number.
 *
 * The fourth reader of one refusal, and the only one whose answer is not about a
 * range at all. What it produces is a candidate for `suspectResultCount`, the
 * count at which the log-fetcher treats a result set as SUSPECT rather than
 * complete -- the knob that decides whether a SILENT truncation is noticed, since
 * a capped answer and a complete one differ in nothing but their size. An
 * operator has had to guess that number by hand while some providers report it in
 * every refusal.
 *
 * Two shapes are read, structured before prose as everywhere else in this file:
 * the `limit` of a `{from, to, limit}` descriptor (Infura), and a count written
 * out in words next to what it counts ({@link REPORTED_RESULT_CAP_PATTERNS}). The
 * LOWEST plausible candidate wins, which makes the answer independent of pattern
 * order and lands on the safe side of an asymmetric mistake: a suspect count
 * BELOW the node's real cap costs a re-fetched half-range, while one ABOVE it
 * misses the truncation entirely, and the receiver reads the missing logs as an
 * absence, concludes a reorg and deletes state (ADR-0004).
 *
 * No error CODE gates it, exactly as none gates {@link statedBlockCapFromError}
 * or {@link archiveRefusalFromError}: the sweep found result caps under `-32005`,
 * `-32602`, `-32000` and `-32600`, and what identifies one is the descriptor or
 * the words beside the number.
 *
 * Captured refusal shapes, their providers and their dates:
 * `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` and
 * `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/`.
 */
export function reportedResultCapFromError(error: any): number | undefined {
	if (!error) {
		return undefined;
	}
	let lowest = reportedResultCapFromStructuredData(error.data);
	for (const text of [error.data, error.data?.message, error.message]) {
		const cap = reportedResultCapFromText(text);
		if (cap !== undefined && (lowest === undefined || cap < lowest)) {
			lowest = cap;
		}
	}
	return lowest;
}

/**
 * The ENTITLEMENT half of an archive refusal: the words a provider uses when it
 * is saying that history is behind a credential or a plan, rather than that its
 * archive is having a bad day.
 *
 * Required IN ADDITION to the word `archive`, and that conjunction is the whole
 * width of the classifier. `archive` alone is too eager: "archive node is
 * syncing" and "archive backend temporarily unavailable" are TRANSIENT, and
 * calling either terminal stops an indexer for a blip -- which is a worse
 * failure than the grinding this exists to fix, because grinding is slow and
 * visible while a false terminal is fast and wrong. An entitlement word alone is
 * too eager in the other direction: `rpc.ankr.com` refuses an unauthenticated
 * request with "You must authenticate your request with an API key", which is
 * about the endpoint rather than about serving history, and every deployment
 * that briefly loses its key would become terminal.
 */
const ARCHIVE_ACCESS_GATE = /\b(tokens?|api ?keys?|plans?|upgrade|unsupported|not supported|not enabled)\b/;

/** Whether one piece of provider text says history is GATED rather than unavailable. */
function looksLikeArchiveRefusal(text: unknown): text is string {
	if (typeof text !== 'string') {
		return false;
	}
	const lowered = text.toLowerCase();
	return lowered.indexOf('archive') !== -1 && ARCHIVE_ACCESS_GATE.test(lowered);
}

/**
 * The provider's own words, when it refused because the HISTORY asked for needs
 * an archive node it will not give this connection -- and `undefined` for every
 * refusal that is anything else, including every refusal we merely cannot
 * classify.
 *
 * The companion of {@link getNewToBlockFromError}, and the two never overlap by
 * construction: this reads a refusal that is not about a range at all, which is
 * why `looksLikeRangeHint` already REJECTS the captured archive body (a `-32602`
 * mentioning neither `results` nor `block range`). A hit here is TERMINAL for the
 * endpoint -- `RangeLogFetcher.getLogs` stops rather than halving, and
 * `ArchiveRefusedError` says so with `retryable: false` -- so the bar for a hit
 * is a refusal that IDENTIFIES ITSELF (see {@link ARCHIVE_ACCESS_GATE}) and
 * everything ambiguous is left to the halving path it has always taken.
 *
 * The text is read from `data` before the message, exactly as the range hint is,
 * because that is where a Nethermind-style node puts its whole complaint while
 * leaving the message at a bare `"invalid params"`. It is returned rather than
 * merely detected so the refusal can be quoted back to the operator verbatim,
 * instead of the fetcher paraphrasing a node.
 *
 * No error CODE is required, and that is deliberate: the captured refusal is a
 * `-32602`, but the codes providers put this behind are as inconsistent as the
 * ones they put range complaints behind (the spike found range refusals under
 * seven different codes), and the identifying evidence here is the text.
 *
 * Captured refusal shapes, their providers and their dates:
 * `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` and
 * `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/`.
 */
export function archiveRefusalFromError(error: any): string | undefined {
	if (!error) {
		return undefined;
	}
	for (const text of [error.data, error.data?.message, error.message]) {
		if (looksLikeArchiveRefusal(text)) {
			return text;
		}
	}
	return undefined;
}

/**
 * `eth_getLogs` over a block range, adapting the range to what the node will
 * actually answer.
 *
 * Named for what it is (ONE range, fetched adaptively) rather than for the
 * component: the **log-fetcher** of ADR-0003 is the public `LogFetcher`, which
 * is a deployable that asks a receiver where to start, fetches and pushes. This
 * is the primitive underneath it, shared with the single-process
 * `IndexerGeneration`.
 *
 * The property both of them are built on is `toBlockUsed`: when a node caps a
 * result set, the range SHRINKS and the answer says how far it really got. A
 * caller that ignored it would treat a short answer as a complete one, which on
 * the wire means a receiver reading missing logs as a reorg and deleting state.
 */
export class RangeLogFetcher {
	protected readonly config: InternalLogFetcherConfig;
	protected numBlocksToFetch: number;
	protected foundNumBlockToHigh: number | undefined;
	protected safeNumBlock: number | undefined;
	private lowestReportedResultCap: number | undefined;
	constructor(
		protected provider: EIP1193ProviderWithoutEvents,
		protected contractAddresses: EIP1193Account[] | null,
		protected eventNameTopics: EIP1193DATA[] | null,
		readonly conf: LogFetcherConfig = {},
		/**
		 * The DECLARED live ranges of each topic, so a block range asks only for the
		 * events that can occur in it. Empty (the default) narrows nothing.
		 */
		protected readonly topicBlockRanges: TopicBlockRanges = new Map(),
	) {
		this.config = Object.assign(
			{
				numBlocksToFetchAtStart: 50,
				percentageToReach: 80,
				maxEventsPerFetch: 10000,
				maxBlocksPerFetch: 100000,
				numRetry: 3,
			},
			conf,
		);
		this.numBlocksToFetch = Math.min(this.config.numBlocksToFetchAtStart, this.config.maxBlocksPerFetch);
	}

	/**
	 * The topics that can occur in `[fromBlock, toBlock]`, or `null` when nothing
	 * narrows and the fetcher must ask for exactly what it has always asked for.
	 *
	 * This is the ONE place a topic is REMOVED from a request, and an unrequested
	 * topic produces no error, no log and no fetch: afterwards a chain that had
	 * none and a request nobody made look identical. So an omission may follow
	 * from a DECLARED range and nothing else -- not an observed first appearance,
	 * not a contract's `startBlock`, not the fact that an event has never been
	 * seen. An event with no `lastBlock` is open-ended and is never dropped above
	 * its `firstBlock`.
	 */
	protected topicsThatCanOccurIn(fromBlock: number, toBlock: number): EIP1193DATA[] | null {
		if (!this.eventNameTopics || this.topicBlockRanges.size === 0) {
			return null;
		}
		return this.eventNameTopics.filter((topic) =>
			canOccurIn(this.topicBlockRanges.get(topic as `0x${string}`), fromBlock, toBlock),
		);
	}

	/**
	 * The ONLY writer of `foundNumBlockToHigh`, and the reason a discovered ceiling
	 * can never be widened by anything -- a parsed number, a later refusal, or a
	 * future caller.
	 *
	 * The ceiling is the upper bound the fetcher has been REFUSED at, learned two
	 * ways: a span that was actually refused (a `-32603` "block range too wide"),
	 * and a cap the provider WROTE OUT ({@link statedBlockCapFromError}). The second
	 * is a guess, so the asymmetry of a wrong one is what shapes this method:
	 * guessing LOW costs a few extra round trips and corrects itself as the fetcher
	 * succeeds and bisects back up; guessing HIGH produces a request the provider
	 * refuses, and the same limit is then discovered again the slow way. Making that
	 * structural rather than merely intended is why every write goes through one
	 * `Math.min` instead of each site remembering to compare.
	 *
	 * A stated cap becomes the ceiling DIRECTLY rather than the cap plus one, so the
	 * fetcher asks for one block less than a provider says it allows. That one block
	 * buys not having to know whether a provider's "up to a 2K block range" is
	 * inclusive, which no message says.
	 */
	protected lowerBlockCeilingTo(cap: number | undefined): void {
		if (cap === undefined || cap < 1) {
			// a ceiling below one block bounds nothing that can be asked for
			return;
		}
		this.foundNumBlockToHigh = Math.min(this.foundNumBlockToHigh ?? this.config.maxBlocksPerFetch, cap);
	}

	/**
	 * The `eth_getLogs` RESULT cap this provider has reported about itself, or
	 * `undefined` while it has reported none.
	 *
	 * Read by the log-fetcher above as a candidate `suspectResultCount`, which is a
	 * question this class deliberately holds no opinion about: a result cap says
	 * nothing about how many BLOCKS to ask for (the only thing sizing here is
	 * measured in), and what to do with a count landing exactly on the cap is a
	 * sending decision under ADR-0004 rather than a fetching one.
	 */
	get reportedResultCap(): number | undefined {
		return this.lowestReportedResultCap;
	}

	/**
	 * The ONLY writer of the reported result cap, and the reason a report can never
	 * RAISE what an earlier one established.
	 *
	 * The same only-ever-lower rule as {@link RangeLogFetcher.lowerBlockCeilingTo},
	 * with a sharper asymmetry behind it. A suspect count BELOW the node's real cap
	 * costs a re-fetched half-range; one ABOVE it means a silently capped answer is
	 * never noticed, so a short range is delivered as a complete one, and the
	 * receiver reads the missing logs as an absence, concludes a reorg and DELETES
	 * state. One URL can also front several backends with different caps, and the
	 * smallest of those is the only number that is safe against all of them.
	 */
	protected recordReportedResultCap(cap: number | undefined): void {
		if (cap === undefined || (this.lowestReportedResultCap !== undefined && cap >= this.lowestReportedResultCap)) {
			return;
		}
		namedLogger.info(`this provider reported an eth_getLogs result cap of ${cap} logs`);
		this.lowestReportedResultCap = cap;
	}

	async getLogs(
		options: {fromBlock: number; toBlock: number; retry?: number},
		unlessCancelled: UnlessCancelledFunction,
	): Promise<LogsResult> {
		let retry = options.retry !== undefined ? options.retry : this.config.numRetry;
		let logs: IncludedEIP1193Log[];

		const fromBlock = options.fromBlock;
		let toBlock = Math.min(options.toBlock, fromBlock + this.numBlocksToFetch - 1);
		// on the range actually REQUESTED, which the line above may have shrunk
		const narrowedTopics = this.topicsThatCanOccurIn(fromBlock, toBlock);
		const topicsToRequest = narrowedTopics ?? this.eventNameTopics;
		try {
			if (narrowedTopics && narrowedTopics.length === 0) {
				// No DECLARED event is live anywhere in this range, so there is nothing to
				// ask for -- and asking with an empty topic list would ask for EVERY log,
				// since a node reads an empty position as a wildcard. This branch must
				// survive every refactor of the planner below it: it is the ONE case where
				// the right number of calls is zero.
				logs = [];
			} else {
				// ONE path, filters or not. The planner decides how many requests that is,
				// and with nothing filtered it is the single call it has always been.
				logs = await getLogsWithVariousFilters(
					this.provider,
					this.contractAddresses,
					topicsToRequest,
					this.conf.filters || null,
					{
						fromBlock,
						toBlock,
					},
					unlessCancelled,
				);
			}
		} catch (err: any) {
			const archiveRefusal = archiveRefusalFromError(err);
			if (archiveRefusal !== undefined) {
				// Checked BEFORE the retry budget and before any hint is read: this is the one
				// refusal a smaller range cannot answer, so halving into it burns the budget and
				// then reports the wrong cause. It is checked on the LAST attempt too, so an
				// endpoint that starts gating history mid-backfill still names the real reason.
				throw new ArchiveRefusedError(fromBlock, toBlock, archiveRefusal);
			}
			// BEFORE the retry budget is consulted, unlike every other hint here: what the
			// node said about its own result cap is true whether or not this call has an
			// attempt left, it is not a hint about the range to ask for next, and it outlives
			// this call -- so a refusal arriving on the LAST attempt still teaches the fetcher
			// the number instead of making the next cycle rediscover it.
			this.recordReportedResultCap(reportedResultCapFromError(err));

			if (retry <= 0) {
				throw err;
			}
			// A cap the provider STATED lowers the ceiling before any branch below runs,
			// because it bounds all of them: the halving fallback AND a suggested range,
			// which providers do compute against a DIFFERENT cap than the one they state
			// (Alchemy's suggestion honours its 10K log cap and ignores the 2K block one).
			this.lowerBlockCeilingTo(statedBlockCapFromError(err));

			let numBlocksToFetchThisTime = this.numBlocksToFetch;
			// ----------------------------------------------------------------------
			// compute the new number of block to fetch this time:
			// ----------------------------------------------------------------------
			const toBlockClue = getNewToBlockFromError(err);
			if (toBlockClue) {
				const totalNumOfBlocksToFetch = toBlockClue - fromBlock + 1;
				if (totalNumOfBlocksToFetch > 1) {
					numBlocksToFetchThisTime = Math.floor((totalNumOfBlocksToFetch * this.config.percentageToReach) / 100);
				}
			} else {
				const totalNumOfBlocksThatWasFetched = toBlock - fromBlock;
				// "block range too large"
				if (err.code === -32603 && err.data && err.data.message) {
					if (err.data.message.indexOf('block range is too wide') !== -1) {
						// found on polygon rpc
						this.lowerBlockCeilingTo(totalNumOfBlocksThatWasFetched);
					} else if (err.data.message.indexOf('block range too large') !== -1) {
						// found on base rpc
						this.lowerBlockCeilingTo(totalNumOfBlocksThatWasFetched);
					}
				}

				if (totalNumOfBlocksThatWasFetched > 1) {
					numBlocksToFetchThisTime = Math.floor(totalNumOfBlocksThatWasFetched / 2);
				} else {
					numBlocksToFetchThisTime = 1;
				}
			}
			// ----------------------------------------------------------------------

			this.numBlocksToFetch = numBlocksToFetchThisTime;
			if (this.foundNumBlockToHigh && this.foundNumBlockToHigh < this.numBlocksToFetch) {
				// never below ONE block: a ceiling of 1 (a provider that states a one-block cap,
				// or a one-block span that was itself refused) otherwise computes a zero-width,
				// BACKWARDS range, which is a request no node can answer.
				if (this.safeNumBlock) {
					this.numBlocksToFetch = Math.max(
						1,
						Math.min(Math.floor((this.foundNumBlockToHigh - this.safeNumBlock) / 2), this.foundNumBlockToHigh - 1),
					);
				} else {
					this.numBlocksToFetch = Math.max(1, this.foundNumBlockToHigh - 1);
				}
			}

			toBlock = fromBlock + this.numBlocksToFetch - 1;
			const result = await this.getLogs(
				{
					fromBlock,
					toBlock,
					retry: retry - 1,
				},
				unlessCancelled,
			);
			logs = result.logs;
			toBlock = result.toBlockUsed;
		}

		const targetNumberOfLog = Math.max(
			1,
			Math.floor((this.config.maxEventsPerFetch * this.config.percentageToReach) / 100),
		);
		const totalNumOfBlocksThatWasFetched = toBlock - fromBlock + 1;

		this.safeNumBlock = Math.max(this.safeNumBlock || 0, totalNumOfBlocksThatWasFetched);

		if (this.foundNumBlockToHigh) {
			// as above, never below ONE block
			if (this.safeNumBlock) {
				this.numBlocksToFetch = Math.max(
					1,
					Math.min(
						this.safeNumBlock + Math.floor((this.foundNumBlockToHigh - this.safeNumBlock) / 2),
						this.foundNumBlockToHigh - 1,
					),
				);
			} else {
				this.numBlocksToFetch = Math.max(1, this.foundNumBlockToHigh - 1);
			}
		} else {
			if (logs.length === 0) {
				this.numBlocksToFetch = this.config.maxBlocksPerFetch;
			} else {
				this.numBlocksToFetch = Math.min(
					this.config.maxBlocksPerFetch,
					Math.max(1, Math.floor((targetNumberOfLog * totalNumOfBlocksThatWasFetched) / logs.length)),
				);
			}
		}

		return {logs, toBlockUsed: toBlock};
	}
}
