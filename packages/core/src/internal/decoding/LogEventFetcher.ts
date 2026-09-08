import {EIP1193Account, EIP1193DATA, EIP1193ProviderWithoutEvents} from 'eip-1193';
import {RangeLogFetcher, LogFetcherConfig} from '../engine/RangeLogFetcher.js';
import {resolveFilterRules, type SourceDeclaration} from './filterRules.js';
import {requestableRangesPerTopic} from '../engine/eventRanges.js';
import type {Abi, AbiEvent} from 'abitype';
import type {DecodeEventLogReturnType} from 'viem';
import {decodeEventLog} from 'viem';
import {canonicalSignatureOf, decodingShapeOf, describeEventDeclaration, topic0Of} from './eventIdentity.js';
import {deepEqual} from '../utils/compare.js';
import type {
	BaseLogEvent,
	IncludedEIP1193Log,
	LogEvent,
	LogEventWithParsingFailure,
	LogParseConfig,
	ParsedLogEvent,
	StoredLogEvent,
} from '../../types.js';
import {normalizeAddress} from '../utils/address.js';
import {UnlessCancelledFunction} from '../utils/promises.js';

/**
 * Collapse the events that ARE the same event, and refuse the ones nothing can
 * tell apart. ONE rule, applied identically wherever an ABI list is built.
 *
 * Keyed on the canonical SIGNATURE -- so on `topic0`, which is its hash --
 * because that is what a log carries. Keying on the NAME made two versions of
 * one event across an upgrade, and two contracts declaring same-named events,
 * look like a clash they are not: `Transfer(address,address,uint256)` and
 * `Transfer(address,address,uint256,bytes)` have different topic0s and are
 * trivially told apart on the wire, so both are kept and both are requested.
 *
 * A shared topic0 with a different DEFINITION is the genuine ambiguity, and it
 * is refused here, at construction, naming both declarations -- but ONLY where
 * this list is what DECIDES a decode (`refuseACollision`, ADR-0061). Within one
 * ADDRESS it always is, so the refusal there is unconditional and no block
 * boundary resolves it either: an upgrade transaction sits mid-block, so both
 * meanings share a block. Across the MERGED list of every contract it usually is
 * NOT, because `decodeOnto` picks the ABI by the log's address, and then a
 * shared topic0 is TOLERATED: both declarations are kept, each reachable only at
 * its own address. An ERC-721 and an ERC-20 in one source is that case, and it
 * is ordinary.
 *
 * What this must never do again is DROP one silently. A spliced event's topic0
 * never entered the fetch filter, so its logs were never asked for, and
 * afterwards nothing distinguished "the chain had none" from "we never asked"
 * -- an absence inferred from a request that was never made, the same failure
 * class as `absence` vs `contradiction` in the reorg model. Tolerating is not
 * dropping: both members stay in the list, and the one topic0 they share is
 * still requested (once -- see the topic-filter loop).
 *
 * The shapes already seen for a signature are kept as a LIST rather than as one
 * winner, so that COLLAPSING still works after a tolerate: a third declaration
 * is compared against every shape kept so far, and is collapsed if it matches
 * ANY of them. The conformance workload is exactly that order -- an ERC-721
 * `Approval` followed by TWO identical ERC-20 ones -- and against a single
 * remembered shape the third would have been tolerated as a second copy of the
 * second, making "identical declarations are collapsed" untrue precisely where
 * a collision is tolerated. Under `refuseACollision` the list can never hold
 * more than one shape, so the message below still names the first declaration.
 */
function deleteDuplicateEvents(events: AbiEvent[], refuseACollision: boolean) {
	const declaredPerSignature = new Map<string, AbiEvent[]>();
	for (let i = 0; i < events.length; i++) {
		const event = events[i];
		const signature = canonicalSignatureOf(event);
		const declared = declaredPerSignature.get(signature);
		if (!declared) {
			declaredPerSignature.set(signature, [event]);
			continue;
		}
		const shape = decodingShapeOf(event);
		if (!declared.some((seen) => deepEqual(decodingShapeOf(seen), shape))) {
			if (!refuseACollision) {
				// TOLERATED: nothing here decodes a log, so nothing here has to tell the
				// two apart. Kept rather than collapsed, because collapsing would pick a
				// winner and the loser's address would decode against the wrong shape.
				declared.push(event);
				continue;
			}
			const topic0 = topic0Of(event);
			throw new Error(
				`ambiguous ABI: "${signature}" is declared more than once with different definitions, ` +
					(topic0
						? `so both arrive under topic0 ${topic0} and nothing on the wire tells them apart. `
						: `and being anonymous they carry no topic0 to tell them apart. `) +
					`Declared as \`${describeEventDeclaration(declared[0])}\` and as \`${describeEventDeclaration(event)}\`. ` +
					`Make the two declarations identical, or index only one of them.`,
			);
		}
		// the same event, declared twice: collapse it, which is not a loss
		events.splice(i, 1);
		i--;
	}
}

export interface NumberifiedLog {
	blockNumber: number;
	blockHash: `0x${string}`;
	transactionIndex: number;
	removed: boolean;
	address: `0x${string}`;
	data: `0x${string}`;
	topics: Array<`0x${string}`>;
	transactionHash: `0x${string}`;
	logIndex: number;
	/**
	 * Seconds since the epoch, when the node put it on the log itself.
	 *
	 * Standardised by `ethereum/execution-apis#639` (merged 2025-08-25) and served
	 * by geth >= 1.16.0, reth, besu, erigon, anvil and EDR >= 0.20.0. Optional
	 * because it is still not universal IN PRACTICE: the holdout is now a release
	 * lag rather than a missing implementation (hardhat 3.16.0 bundles edr 0.19.0),
	 * and a node being forked that predates the change yields a log without it.
	 *
	 * What the ENGINE does about such a node is REFUSE it at the fetch boundary,
	 * naming it (`assertLogsCarryTimestamps` / `TimestamplessLogError`, ADR-0073) --
	 * unless `alwaysFetchTimestamps` is set, which is the legacy fallback that pays
	 * a request per event-bearing block for what the log should have carried. The
	 * field stays optional at the TYPE level either way, because the wire genuinely
	 * does not guarantee it and this type says what the wire does.
	 */
	blockTimestamp?: number;
}

const HEX_QUANTITY = /^0[xX][0-9a-fA-F]+$/;
const DECIMAL_QUANTITY = /^[0-9]+$/;

/**
 * Read a log's `blockTimestamp` into seconds, or `undefined` if it is absent or
 * unreadable.
 *
 * The parameter is `unknown` rather than `EIP1193QUANTITY` on purpose, and the
 * gap between the two is the point. The spec says QUANTITY, so 0x-prefixed hex,
 * and `eip-1193` types it that way; but at least one client has served it in
 * decimal, and the prefix is the ONLY signal that separates the two:
 * `'1705366720'` is valid hex as well as valid decimal and the readings are
 * millennia apart. The type says what the spec says, this says what the wire
 * does.
 *
 * Anything that is neither is dropped rather than coerced, because a wrong
 * timestamp is worse than a missing one: the caller can fall back on a missing
 * one and cannot detect a wrong one.
 */
export function parseLogBlockTimestamp(value: unknown): number | undefined {
	if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	if (typeof value !== 'string') return undefined;
	const text = value.trim();
	const seconds = HEX_QUANTITY.test(text)
		? parseInt(text, 16)
		: DECIMAL_QUANTITY.test(text)
			? Number(text)
			: Number.NaN;
	return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

export type ParsedLogsResult<ABI extends Abi> = {events: LogEvent<ABI>[]; toBlockUsed: number};
export type ParsedLogsPromise<ABI extends Abi> = Promise<ParsedLogsResult<ABI>> & {stopRetrying(): void};

type OneABI<ABI extends Abi> = {readonly abi: ABI};
type ContractList<ABI extends Abi> = readonly {readonly address: `0x${string}`; readonly abi: ABI}[];

/**
 * The key preselection is done on: WHICH ABI applies (the address) and WHICH
 * member of it the log names (its `topic0`), which are exactly the two things
 * `decodeOnto` decides.
 *
 * A string key rather than a nested map because the pair is looked up together,
 * once per log, and never enumerated per address.
 */
function preselectionKey(address: `0x${string}`, topic0: `0x${string}` | undefined): string {
	return `${address}:${topic0}`;
}

/**
 * A decode failure, as the ONE LINE that says which failure it was.
 *
 * `decodeError` is STORED on the event (`LogEventWithParsingFailure`), so what
 * goes in it is persisted rather than logged once. A stringified viem error is
 * several lines carrying a docs URL and `Version: viem@x.y.z`, which would put a
 * dependency's version number into stored data and churn it on every bump -- so
 * the first line is taken, which is exactly `<ErrorName>: <what went wrong>` and
 * is the half that identifies the fault:
 *
 * - `AbiEventSignatureNotFoundError` -- this ABI declares no member with that
 *   `topic0` (an anonymous event lands here too: its `topics[0]` is an indexed
 *   ARGUMENT, so it names no member);
 * - `DecodeLogDataMismatch` / `DecodeLogTopicsMismatch` -- the member was found
 *   and the log's data or topics do not fit it;
 * - `AbiEventSignatureEmptyTopicsError` -- the log carries no topics at all.
 *
 * Those are three different faults with three different fixes, which is the whole
 * reason not to collapse them into one constant.
 */
function decodeErrorOf(err: unknown): string {
	const [firstLine] = String(err).split('\n');
	return `decoding error: ${firstLine}`;
}

export class LogEventFetcher<ABI extends Abi> extends RangeLogFetcher {
	/**
	 * The event a log names, preselected by ADDRESS and `topic0`, built ONCE.
	 *
	 * `decodeEventLog` finds the member a log names by walking the ABI it is
	 * handed and re-deriving each candidate's event selector -- a keccak per
	 * candidate, per CALL, memoised by nothing. Over a replay that search, and not
	 * the decoding, is where most of the decode time goes: 57 us/event against 18
	 * us/event preselected, for a map that costs 0.24 ms to build
	 * (`work/notes/findings/decoding-is-3x-faster-with-a-memoised-topic0-map.md`).
	 *
	 * It is a memoised LOOKUP and not a cache of a derivation: nothing is stored,
	 * it is rebuilt from the source on every construction, and there is no
	 * identity to guard.
	 *
	 * Built from the SAME de-duplicated per-address lists `decodeOnto` decodes
	 * against, which is what makes a hit interchangeable with the whole-ABI
	 * search: ADR-0031 collapses two declarations of one `topic0` that decode
	 * identically and REFUSES a genuine collision at construction, so no address
	 * can hold two members answering to one `topic0`. That per-address refusal is
	 * UNCONDITIONAL and ADR-0061 leaves it exactly as it was; what ADR-0061
	 * tolerates is a collision across DIFFERENT addresses, which this map keys
	 * apart by construction.
	 *
	 * ANONYMOUS members are absent, because they have no `topic0` to key: their
	 * logs carry an indexed ARGUMENT in `topics[0]`. They miss and fall back, which
	 * is the only correct answer -- the whole-ABI search is also what would find
	 * them, if it found them.
	 */
	private abiEventPerAddressAndTopic: Map<string, AbiEvent>;
	private abiPerAddress: Map<`0x${string}`, AbiEvent[]>;
	/**
	 * May hold two members answering to ONE `topic0` (ADR-0061), so it is read
	 * ONLY where `mergedListDecodes` is false -- which is to say, never.
	 */
	private allABIEvents: AbiEvent[];
	/**
	 * Whether the MERGED list is what decodes a log, decided ONCE.
	 *
	 * The construction-time refusal and the per-log route must ask the SAME
	 * question, or the merged list is decoded against on a path that never checked
	 * it for a `topic0` collision -- and that failure is silent, since
	 * `decodeEventLog` would simply return the first member matching the `topic0`
	 * and write another address's `args` onto the event with no `decodeError`. It
	 * was two separately written copies of one expression 190 lines apart, which
	 * nothing would have caught drifting.
	 *
	 * Storing it also FREEZES the verdict at the instant the refusal was evaluated.
	 * `parseConfig` is the caller's object, held by reference, so re-reading the
	 * flag per log let a mutation after construction flip the route onto a list
	 * that was deliberately tolerated as ambiguous.
	 */
	private readonly mergedListDecodes: boolean;

	constructor(
		readonly provider: EIP1193ProviderWithoutEvents,
		readonly contractsData: ContractList<ABI> | OneABI<ABI>,
		readonly fetcherConfig: LogFetcherConfig = {},
		private readonly parseConfig?: LogParseConfig,
	) {
		const _abiEventPerTopic: Map<`0x${string}`, AbiEvent> = new Map();
		const _abiPerAddress: Map<`0x${string}`, AbiEvent[]> = new Map();
		const _allABIEvents: AbiEvent[] = [];
		let contractAddresses: EIP1193Account[] | null = null;
		if (Array.isArray(contractsData)) {
			contractAddresses = [];
			for (const contract of contractsData as ContractList<ABI>) {
				const contractAddress = normalizeAddress(contract.address);
				const contractEventsABI: AbiEvent[] = contract.abi.filter((item) => item.type === 'event') as AbiEvent[];
				const abiAtThatAddress = _abiPerAddress.get(contractAddress);
				if (!abiAtThatAddress) {
					_abiPerAddress.set(contractAddress, contractEventsABI);
					contractAddresses.push(contractAddress);
				} else {
					abiAtThatAddress.push(...contractEventsABI);
				}
				_allABIEvents.push(...contractEventsABI);
			}
		} else {
			const allContractsData = contractsData as {readonly abi: ABI};
			_allABIEvents.push(...(allContractsData.abi.filter((item) => item.type === 'event') as AbiEvent[]));
		}

		// WHICH EVENTS EXIST is the same on every path and never depends on
		// `parseAllEventsIrrespectiveOfAddresses` -- a parse-config flag deciding that
		// was the defect ADR-0031 fixed, and every topic0 below still enters the
		// filter either way. What is conditional is only the REFUSAL, and it follows
		// the DECODE path (ADR-0061).
		//
		// PER ADDRESS: unconditional. One address holding two shapes under one topic0
		// is undecidable, and it is what the preselection map rests on.
		for (const abiAtAddress of _abiPerAddress.values()) {
			deleteDuplicateEvents(abiAtAddress, true);
		}
		// MERGED: only where this list is the one that decodes, which is exactly
		// `decodeOnto`'s `useAllABIEvents`. Otherwise the address tells the two apart
		// and the collision is tolerated -- an ERC-721 and an ERC-20 in one source
		// share `Transfer(address,address,uint256)` and differ only in `indexed`.
		const _mergedListDecodes = _abiPerAddress.size === 0 || !!parseConfig?.parseAllEventsIrrespectiveOfAddresses;
		deleteDuplicateEvents(_allABIEvents, _mergedListDecodes);

		const eventNameTopics: EIP1193DATA[] = [];
		for (const item of _allABIEvents) {
			const topic0 = topic0Of(item);
			if (!topic0) {
				// an anonymous event carries no topic0, so there is nothing to put in
				// the filter and nothing to key a filter list by
				continue;
			}
			if (_abiEventPerTopic.get(topic0)) {
				// A shared topic0 belongs in the fetch filter ONCE, and this is a DEDUPE
				// rather than a refusal (ADR-0061). It used to be unreachable, because
				// `deleteDuplicateEvents` collapsed or refused every shared topic0; the
				// merged list now TOLERATES one whose two shapes live at different
				// addresses, so this is reached whenever it does.
				//
				// Nothing about WHICH EVENTS ARE REQUESTED changes: the topic0 is already
				// in `eventNameTopics` and already filed under its name (a shared topic0 is
				// a shared canonical SIGNATURE, so it is a shared name too), and logs are
				// filtered by ADDRESS as well as by topic. Asking for it twice would just
				// be the same request written down twice.
				continue;
			}
			_abiEventPerTopic.set(topic0, item);
			eventNameTopics.push(topic0);
		}

		if (parseConfig?.filters && parseConfig.filters.length > 0) {
			// EVERY declaration in the source, at its address, which is what a rule is
			// resolved against: which `topic0`s a name covers, which addresses declare
			// each of them, and how deep a positional filter may go. The per-address
			// lists are already de-duplicated, so a declaration appears once per
			// address it is really at.
			const declarations: SourceDeclaration[] =
				_abiPerAddress.size === 0
					? _allABIEvents.map((event) => ({address: null, event}))
					: [..._abiPerAddress].flatMap(([address, events]) => events.map((event) => ({address, event})));
			fetcherConfig = {...fetcherConfig, filters: resolveFilterRules(parseConfig.filters, declarations)};
		}

		// A BLOCK RANGE REQUESTS ONLY THE EVENTS THAT CAN OCCUR IN IT. Declared
		// ranges narrow the topics of each request (and, under argument filters,
		// remove its whole round trip); a source declaring none narrows nothing and
		// requests exactly what it always requested.
		super(provider, contractAddresses, eventNameTopics, fetcherConfig, requestableRangesPerTopic(contractsData));
		this.allABIEvents = _allABIEvents;
		this.abiPerAddress = _abiPerAddress;
		// the SAME value the refusal above was decided on, never a second reading of it
		this.mergedListDecodes = _mergedListDecodes;

		// ONCE, from the lists decoding actually uses, and after they have been
		// de-duplicated -- so what is preselected is what the whole-ABI search would
		// have found, member for member
		const _abiEventPerAddressAndTopic: Map<string, AbiEvent> = new Map();
		for (const [address, abiAtAddress] of _abiPerAddress) {
			for (const event of abiAtAddress) {
				const topic0 = topic0Of(event);
				if (!topic0) {
					// anonymous: nothing to key it by, so it stays on the whole-ABI route
					continue;
				}
				_abiEventPerAddressAndTopic.set(preselectionKey(address, topic0), event);
			}
		}
		this.abiEventPerAddressAndTopic = _abiEventPerAddressAndTopic;
	}

	async getLogEvents(
		options: {fromBlock: number; toBlock: number; retry?: number},
		unlessCancelled: UnlessCancelledFunction,
	): Promise<ParsedLogsResult<ABI>> {
		const {logs, toBlockUsed} = await this.getLogs(options, unlessCancelled);
		const events = this.parse(logs);
		return {events, toBlockUsed};
	}

	parse(logs: IncludedEIP1193Log[]): LogEvent<ABI>[] {
		const events: LogEvent<ABI>[] = [];
		for (let i = 0; i < logs.length; i++) {
			const log = logs[i];
			const eventAddress = normalizeAddress(log.address);
			const blockTimestamp = parseLogBlockTimestamp(log.blockTimestamp);
			const event: NumberifiedLog = {
				blockNumber: parseInt(log.blockNumber.slice(2), 16),
				blockHash: log.blockHash,
				transactionIndex: parseInt(log.transactionIndex.slice(2), 16),
				removed: log.removed ? true : false,
				address: eventAddress,
				data: log.data,
				topics: log.topics,
				transactionHash: log.transactionHash,
				logIndex: parseInt(log.logIndex.slice(2), 16),
				// kept when the node provides it, so no second round-trip is needed
				...(blockTimestamp === undefined ? {} : {blockTimestamp}),
			};
			this.decodeOnto(event);
			// the WHOLE raw log the node reported, always: no configuration projects a
			// field out of it, so an event can never reach storage or the wire with
			// nothing left to decode from
			events.push(event as LogEvent<ABI>);
		}
		return events;
	}

	/**
	 * DECODE a cached stream again, because its decoded half is a CACHE and this
	 * ABI is the authority.
	 *
	 * A stored event is two things at once: the raw log (`topics`, `data`,
	 * `address`), which is what the node said and is true forever, and `args` /
	 * `eventName`, which is what SOME ABI made of it. Keeping a stream across a
	 * source change keeps the first; the second has to be recomputed, because a
	 * change can move the decode without moving the fetch at all. A renamed
	 * non-indexed parameter is the case: `topic0` hashes types and not names, so
	 * every cached log is still exactly the right log and every cached `args` is
	 * filed under a key the handler no longer reads.
	 *
	 * Unconditional rather than "only when the shape moved": the stream file
	 * carries ONE context for events appended across several sources, so "was this
	 * event decoded under the current ABI" is not a question it can answer per
	 * event. Decoding is what the fetch path pays anyway.
	 *
	 * `undefined` when an event carries no raw log to decode. Nothing this version
	 * writes can be in that state -- `parse` keeps the whole raw log and no
	 * configuration can project it away -- so what it guards is a stream ALREADY ON
	 * DISK, written by an OLDER version whose parse config could strip `topics` or
	 * `data`. The caller then has a stream it cannot re-read and must not replay on
	 * trust (ADR-0034).
	 *
	 * Pinned by `test/rawLogIsNeverStripped.test.ts`, both halves: unreachable for
	 * anything written now, still reachable for those bytes.
	 *
	 * It takes a STORED event as readily as a decoded one, and that is the seam
	 * "decoding happens on read" rests on: what a keeper hands back is the raw log
	 * plus the reorg flag (`StoredLogEvent`), which belongs to neither member of
	 * the `LogEvent` union by construction. Accepting both costs nothing at
	 * runtime, since the decoded half is dropped below either way; what it returns
	 * is decoded events in both cases, because a READ produces `LogEvent`s.
	 */
	reparse(events: readonly (LogEvent<ABI> | StoredLogEvent)[]): LogEvent<ABI>[] | undefined {
		const reparsed: LogEvent<ABI>[] = [];
		for (const stored of events) {
			if (!stored.topics || !stored.data || !stored.address) {
				return undefined;
			}
			// the decoded half is dropped rather than overwritten, so a decode that now
			// FAILS cannot leave the previous `args` sitting next to its `decodeError`
			// (and a stored event, which declares all three away, simply has none to drop)
			const {
				args: _args,
				eventName: _eventName,
				decodeError: _decodeError,
				...raw
			} = stored as BaseLogEvent & {
				args?: unknown;
				eventName?: unknown;
				decodeError?: unknown;
			};
			const event = raw as unknown as NumberifiedLog;
			this.decodeOnto(event);
			reparsed.push(event as LogEvent<ABI>);
		}
		return reparsed;
	}

	/**
	 * What ONE raw log means under THIS ABI, written onto the event.
	 *
	 * Extracted so that the fetch path and the cached-stream replay decode through
	 * the same rule rather than through two copies of it: which ABI applies at an
	 * address, the `topic0` keying of ADR-0031, and how a failure is recorded are
	 * all decisions this must make identically wherever the log came from.
	 *
	 * The member is PRESELECTED by `topic0` where one can be
	 * (`abiEventPerAddressAndTopic`), and the lookup FALLS BACK to the whole ABI
	 * where it cannot: an anonymous event has no `topic0`, and a log naming an
	 * event this address does not declare has one that is in no map. The fallback
	 * is what keeps this a pure optimisation rather than a behaviour change --
	 * every input still reaches a call that existed before, and a hit reaches the
	 * same member with the same decoder.
	 */
	private decodeOnto(event: NumberifiedLog): void {
		// the predicate the CONSTRUCTOR refused on, not a second reading of the same
		// question: the merged list is only unambiguous where this is true (ADR-0061)
		const useAllABIEvents = this.mergedListDecodes;
		const correspondingABI: AbiEvent[] | undefined = useAllABIEvents
			? this.allABIEvents
			: this.abiPerAddress.get(event.address);
		if (!correspondingABI) {
			(event as LogEventWithParsingFailure).decodeError = `event triggered at a different address`;
			return;
		}
		// deliberately NOT on the address-agnostic route: ADR-0031 is that
		// `parseAllEventsIrrespectiveOfAddresses` decides which ABI decodes a log and
		// must never decide which events exist, so it keeps the one list it has
		// rather than growing a second index keyed on something else. It is also why
		// the merged list must be UNAMBIGUOUS whenever this branch is live, which is
		// the condition ADR-0061 makes the global refusal follow.
		const preselected = useAllABIEvents
			? undefined
			: this.abiEventPerAddressAndTopic.get(preselectionKey(event.address, event.topics[0]));
		let parsed: DecodeEventLogReturnType<AbiEvent[]> | null = null;
		try {
			parsed = decodeEventLog({
				abi: preselected ? [preselected] : correspondingABI,
				data: event.data,
				topics: event.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
			});
		} catch (err) {
			// The REAL reason, and it RETURNS rather than falling through.
			//
			// This used to assign the error and then fall into the block below, whose
			// `else` overwrote it with a constant because `parsed` was null -- so the
			// informative branch was unreachable in the OUTPUT and every failure recorded
			// the same uninformative string. A `topic0` this ABI does not declare, data
			// that does not match the member its `topic0` names, and a log with no topics
			// at all are three different faults with three different fixes, and an
			// operator reading a stored `decodeError` could tell none of them apart.
			(event as LogEventWithParsingFailure).decodeError = decodeErrorOf(err);
			return;
		}

		if (parsed) {
			(event as ParsedLogEvent<ABI>).args = parsed.args as any;
			(event as ParsedLogEvent<ABI>).eventName = parsed.eventName as ParsedLogEvent<ABI>['eventName'];
		} else {
			// Only reachable if the decoder RETURNS something falsy without throwing,
			// which it does not do today. Kept as the honest answer for a decoder that
			// someday does, rather than deleted and rediscovered as an `undefined` args.
			(event as LogEventWithParsingFailure).decodeError = `parsing did not return any results`;
		}
	}
}
