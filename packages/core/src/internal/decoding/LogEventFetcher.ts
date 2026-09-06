import {EIP1193Account, EIP1193DATA, EIP1193ProviderWithoutEvents} from 'eip-1193';
import {ExtraFilters} from '../engine/ethereum.js';
import {RangeLogFetcher, LogFetcherConfig} from '../engine/RangeLogFetcher.js';
import {requestableRangesPerTopic} from '../engine/eventRanges.js';
import type {Abi, AbiEvent} from 'abitype';
import type {DecodeEventLogReturnType} from 'viem';
import {decodeEventLog} from 'viem';
import {canonicalSignatureOf, decodingShapeOf, describeEventDeclaration, topic0Of} from './eventIdentity.js';
import {deepEqual} from '../utils/compare.js';
import type {
	IncludedEIP1193Log,
	LogEvent,
	LogEventWithParsingFailure,
	LogParseConfig,
	ParsedLogEvent,
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
 * is refused here, at construction, naming both declarations. No block boundary
 * resolves it either: an upgrade transaction sits mid-block, so both meanings
 * share a block.
 *
 * What this must never do again is DROP one silently. A spliced event's topic0
 * never entered the fetch filter, so its logs were never asked for, and
 * afterwards nothing distinguished "the chain had none" from "we never asked"
 * -- an absence inferred from a request that was never made, the same failure
 * class as `absence` vs `contradiction` in the reorg model.
 */
function deleteDuplicateEvents(events: AbiEvent[]) {
	const declaredPerSignature = new Map<string, AbiEvent>();
	for (let i = 0; i < events.length; i++) {
		const event = events[i];
		const signature = canonicalSignatureOf(event);
		const declared = declaredPerSignature.get(signature);
		if (!declared) {
			declaredPerSignature.set(signature, event);
			continue;
		}
		if (!deepEqual(decodingShapeOf(event), decodingShapeOf(declared))) {
			const topic0 = topic0Of(event);
			throw new Error(
				`ambiguous ABI: "${signature}" is declared more than once with different definitions, ` +
					(topic0
						? `so both arrive under topic0 ${topic0} and nothing on the wire tells them apart. `
						: `and being anonymous they carry no topic0 to tell them apart. `) +
					`Declared as \`${describeEventDeclaration(declared)}\` and as \`${describeEventDeclaration(event)}\`. ` +
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
	 * by geth >= 1.16.0, reth, besu, erigon and anvil. Optional because it is NOT
	 * universal: Hardhat's EDR does not emit it as of hardhat 3.14.0 / edr 0.3.8,
	 * so a caller that needs a timestamp for every log still needs the
	 * `alwaysFetchTimestamps` fallback for those nodes.
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
	 * can hold two members answering to one `topic0`.
	 *
	 * ANONYMOUS members are absent, because they have no `topic0` to key: their
	 * logs carry an indexed ARGUMENT in `topics[0]`. They miss and fall back, which
	 * is the only correct answer -- the whole-ABI search is also what would find
	 * them, if it found them.
	 */
	private abiEventPerAddressAndTopic: Map<string, AbiEvent>;
	private abiPerAddress: Map<`0x${string}`, AbiEvent[]>;
	private allABIEvents: AbiEvent[];

	constructor(
		readonly provider: EIP1193ProviderWithoutEvents,
		readonly contractsData: ContractList<ABI> | OneABI<ABI>,
		readonly fetcherConfig: LogFetcherConfig = {},
		private readonly parseConfig?: LogParseConfig,
	) {
		const _abiEventPerTopic: Map<`0x${string}`, AbiEvent> = new Map();
		// a NAME can cover several topic0s (two versions of one event, or two
		// contracts declaring the same name differently), and the filter config is
		// keyed by name, so this is a list and not a single topic
		const _topicsPerEventName: Map<string, `0x${string}`[]> = new Map();
		const _abiPerAddress: Map<`0x${string}`, AbiEvent[]> = new Map();
		const _eventNameToContractAddresses: Map<string, `0x${string}`[]> = new Map();
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

				for (const event of contractEventsABI) {
					const list = _eventNameToContractAddresses.get(event.name) || [];
					if (list.length === 0) {
						_eventNameToContractAddresses.set(event.name, list);
					}
					if (list.indexOf(contractAddress) === -1) {
						list.push(contractAddress);
					}
				}
			}
		} else {
			const allContractsData = contractsData as {readonly abi: ABI};
			_allABIEvents.push(...(allContractsData.abi.filter((item) => item.type === 'event') as AbiEvent[]));
		}

		// the SAME rule on every list, so which events exist can never depend on
		// `parseAllEventsIrrespectiveOfAddresses` -- a parse-config flag deciding
		// that was the defect
		for (const abiAtAddress of _abiPerAddress.values()) {
			deleteDuplicateEvents(abiAtAddress);
		}
		deleteDuplicateEvents(_allABIEvents);

		const eventNameTopics: EIP1193DATA[] = [];
		for (const item of _allABIEvents) {
			const topic0 = topic0Of(item);
			if (!topic0) {
				// an anonymous event carries no topic0, so there is nothing to put in
				// the filter and nothing to key a filter list by
				continue;
			}
			if (_abiEventPerTopic.get(topic0)) {
				// unreachable: `deleteDuplicateEvents` already collapsed or refused
				// every shared topic0. Kept because decoding preselects by it.
				throw new Error(`duplicate topics found for \`${describeEventDeclaration(item)}\``);
			}
			_abiEventPerTopic.set(topic0, item);
			eventNameTopics.push(topic0);
			const topicsForThatName = _topicsPerEventName.get(item.name);
			if (topicsForThatName) {
				topicsForThatName.push(topic0);
			} else {
				_topicsPerEventName.set(item.name, [topic0]);
			}
		}

		if (parseConfig?.filters) {
			const filters: ExtraFilters = {};
			for (const eventName of Object.keys(parseConfig.filters)) {
				const filterList = parseConfig.filters[eventName];
				// a filter is configured by NAME, so it applies to EVERY topic0 that
				// name covers. Applying it to one of them would leave the others in
				// the shared, unfiltered request -- the same argument filter meaning
				// two different things for two versions of one event
				for (const signatureTopic of _topicsPerEventName.get(eventName) || []) {
					filters[signatureTopic] = {
						list: filterList,
						contractAddresses: _eventNameToContractAddresses.get(eventName),
					};
				}
			}
			fetcherConfig = {...fetcherConfig, filters};
		}

		// A BLOCK RANGE REQUESTS ONLY THE EVENTS THAT CAN OCCUR IN IT. Declared
		// ranges narrow the topics of each request (and, under argument filters,
		// remove its whole round trip); a source declaring none narrows nothing and
		// requests exactly what it always requested.
		super(provider, contractAddresses, eventNameTopics, fetcherConfig, requestableRangesPerTopic(contractsData));
		this.allABIEvents = _allABIEvents;
		this.abiPerAddress = _abiPerAddress;

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

			if (this.parseConfig?.logValues) {
				const eventWithFilteredValues: LogEvent<ABI> = {} as LogEvent<ABI>;
				if ((event as any).args) {
					(eventWithFilteredValues as any).args = (event as any).args;
				}
				for (const key of Object.keys(this.parseConfig.logValues)) {
					if (typeof (event as any)[key] !== 'undefined') {
						(eventWithFilteredValues as any)[key] = (event as any)[key];
					}
				}
				events.push(eventWithFilteredValues);
			} else {
				events.push(event as LogEvent<ABI>);
			}
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
	 * `undefined` when an event carries no raw log to decode -- which only a
	 * `logValues` projection that dropped `topics` or `data` can cause. The caller
	 * then has a stream it cannot re-read and must not replay on trust.
	 */
	reparse(events: readonly LogEvent<ABI>[]): LogEvent<ABI>[] | undefined {
		const reparsed: LogEvent<ABI>[] = [];
		for (const stored of events) {
			if (!stored.topics || !stored.data || !stored.address) {
				return undefined;
			}
			// the decoded half is dropped rather than overwritten, so a decode that now
			// FAILS cannot leave the previous `args` sitting next to its `decodeError`
			const {
				args: _args,
				eventName: _eventName,
				decodeError: _decodeError,
				...raw
			} = stored as LogEvent<ABI> & {
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
		const useAllABIEvents = this.abiPerAddress.size === 0 || this.parseConfig?.parseAllEventsIrrespectiveOfAddresses;
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
		// rather than growing a second index keyed on something else
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
			parsed = null;
			(event as LogEventWithParsingFailure).decodeError = `decoding error: ${err}`;
		}

		if (parsed) {
			(event as ParsedLogEvent<ABI>).args = parsed.args as any;
			(event as ParsedLogEvent<ABI>).eventName = parsed.eventName as ParsedLogEvent<ABI>['eventName'];
		} else {
			(event as LogEventWithParsingFailure).decodeError = `parsing did not return any results`;
		}
	}
}
