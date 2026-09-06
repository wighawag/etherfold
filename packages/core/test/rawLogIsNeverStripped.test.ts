import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {LogEventFetcher} from '../src/internal/decoding/LogEventFetcher.js';
import type {LogEvent, LogParseConfig, ProvidedStreamConfig} from '../src/types.js';
import {
	fakeChain,
	fakeProcessor,
	idOf,
	indexToTip,
	makeIndexer,
	makeLog,
	memoryStream,
	START_BLOCK,
	SOURCE,
	type ProcessorStore,
} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------
// NO CONFIGURATION CAN STRIP THE RAW LOG
// ---------------------------------------------------------------------------
// `parse` used to apply a PROJECTION over the raw log's own fields
// (`parse.logValues`): an allowlist that kept `args` unconditionally and dropped
// every raw field not named. It preserved the DERIVATION and discarded the
// SOURCE, which is backwards for a stream that stores what the node said -- an
// event whose raw half was projected away has nothing left to decode from. The
// knob is DELETED rather than relocated, so the guarantee is STRUCTURAL: there
// is no setting left that could strip the raw log out of what is stored or sent.
//
// Deleting it does NOT delete the detect-and-clear guard, and both halves of
// that are asserted here:
//
//   - UNREACHABLE for anything newly written: whatever the parse config,
//     every parsed event carries the whole raw log, so the re-decode can always
//     read a stream this version wrote;
//   - STILL REACHABLE for a stream already on disk: a stream an OLDER version
//     wrote under a projecting parse still makes `reparse` answer "cannot
//     re-read", and the load path still CLEARS it instead of replaying it on
//     trust (ADR-0034).
//
// The stream keeper's own unreadable-SEGMENT handling is a different guard on a
// different layer (`streamSegments.test.ts`, `degradingStream.test.ts`): that is
// a keeper that cannot read its bytes BACK, this is a stream that reads back
// fine and has nothing left to decode.
// ---------------------------------------------------------------------------

const ADDRESS = '0x0000000000000000000000000000000000000001';
/** `Transfer(address,address,uint256)`, as viem encodes its selector. */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const abi = [
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
] as const satisfies Abi;

const word = (value: number) => value.toString(16).padStart(64, '0');
const addressTopic = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;

function rawLog(over: Record<string, unknown> = {}) {
	return {
		blockNumber: '0x64',
		blockHash: '0xaaa',
		transactionIndex: '0x2',
		removed: false,
		address: ADDRESS,
		data: `0x${word(7)}`,
		topics: [TRANSFER, addressTopic(ADDRESS), addressTopic(ADDRESS)],
		transactionHash: `0x${'1'.padStart(64, '0')}`,
		logIndex: '0x3',
		...over,
	} as any;
}

const provider = {request: async () => undefined} as any;

// -- the knob is gone from the TYPES -----------------------------------------

/**
 * `pnpm typecheck` is what runs this, not vitest: each `@ts-expect-error` FAILS
 * the typecheck if the line it guards starts compiling, which is the only way to
 * assert that a configuration is NOT accepted.
 */
describe('the parse configuration a deployment may write', () => {
	/**
	 * Exactly the value the deleted allowlist took -- a boolean per raw field, and
	 * every field, so that the ONLY thing left to fail on is the property name
	 * itself. A partial literal would have been refused for being partial, which
	 * would have made the assertion pass for the wrong reason.
	 */
	const everyRawField = {
		blockNumber: true,
		blockHash: true,
		transactionIndex: true,
		removed: true,
		address: true,
		data: true,
		topics: true,
		transactionHash: true,
		logIndex: true,
		blockTimestamp: true,
	};

	it('does not compile a projection over the raw log', () => {
		// Deliberately never CALLED: the assertions are the `@ts-expect-error`
		// comments. Vitest strips types, so running the body would prove nothing.
		function refusals() {
			// @ts-expect-error `logValues` is DELETED: nothing may project the raw log away
			const parse: LogParseConfig = {logValues: everyRawField};
			// @ts-expect-error and it is equally absent through the stream config that carries `parse`
			const stream: ProvidedStreamConfig = {parse: {logValues: everyRawField}};
			return {parse, stream};
		}

		expect(typeof refusals).toBe('function');
	});
});

// -- the guard is UNREACHABLE for anything newly written ----------------------

/** Every shape a parse config can still take, none of which touches what is KEPT. */
const PARSE_CONFIGS: {name: string; parseConfig?: LogParseConfig}[] = [
	{name: 'no parse config at all', parseConfig: undefined},
	{name: 'an empty parse config', parseConfig: {}},
	{name: 'parsing every event irrespective of addresses', parseConfig: {parseAllEventsIrrespectiveOfAddresses: true}},
	{
		name: 'an argument filter',
		parseConfig: {filters: [{event: 'Transfer', match: [[addressTopic(ADDRESS) as `0x${string}`]]}]},
	},
];

describe('what `parse` keeps', () => {
	for (const {name, parseConfig} of PARSE_CONFIGS) {
		it(`carries the whole raw log the node reported, under ${name}`, () => {
			const fetcher = new LogEventFetcher(provider, [{abi, address: ADDRESS}], {}, parseConfig);

			const [event] = fetcher.parse([rawLog()]);

			expect(event.address).toBe(ADDRESS);
			expect(event.topics).toEqual([TRANSFER, addressTopic(ADDRESS), addressTopic(ADDRESS)]);
			expect(event.data).toBe(`0x${word(7)}`);
			expect(event.blockNumber).toBe(100);
			expect(event.blockHash).toBe('0xaaa');
			expect(event.transactionHash).toBe(`0x${'1'.padStart(64, '0')}`);
			expect(event.transactionIndex).toBe(2);
			expect(event.logIndex).toBe(3);
			expect(event.removed).toBe(false);
			// and the decoded half is still there beside it, on the FETCH path
			expect((event as any).eventName).toBe('Transfer');
		});

		it(`leaves a stream this version wrote re-readable, under ${name}`, () => {
			const fetcher = new LogEventFetcher(provider, [{abi, address: ADDRESS}], {}, parseConfig);

			// what `saveNewEvents` is handed is what `parse` produced, so this is the
			// round trip the load path makes over a stream written today
			const stored = fetcher.parse([rawLog(), rawLog({logIndex: '0x4'})]);

			expect(fetcher.reparse(stored)).toHaveLength(2);
		});
	}
});

// -- the guard is STILL REACHABLE for a stream already on disk ----------------

/**
 * A stored event as an OLDER version wrote it, under a parse that projected the
 * raw log away.
 *
 * Constructed DIRECTLY, because the configuration that produced it no longer
 * exists: nothing this version can be told to do writes one of these, which is
 * the whole point, and a guard against bytes on disk has to be driven by bytes.
 */
function asAnOlderVersionWrote<Event>(event: Event, dropped: ('topics' | 'data' | 'address')[]): Event {
	const projected = {...event} as Record<string, unknown>;
	for (const field of dropped) {
		delete projected[field];
	}
	// `args` survived the projection unconditionally, which is what left the event
	// with a derivation and no source
	projected.args = {stale: true};
	projected.eventName = 'FromAnOlderAbi';
	return projected as unknown as Event;
}

describe('a stream an older version wrote under a projecting parse', () => {
	const fetcher = new LogEventFetcher(provider, [{abi, address: ADDRESS}]);
	const written = () => fetcher.parse([rawLog()]);

	for (const dropped of [['topics'], ['data'], ['address'], ['topics', 'data']] as const) {
		it(`cannot be re-read when the projection dropped ${dropped.join(' and ')}`, () => {
			const stored = written().map((event) => asAnOlderVersionWrote(event, [...dropped]));

			expect(fetcher.reparse(stored)).toBeUndefined();
		});
	}

	it('is re-read normally when nothing was dropped, so the verdict is about the RAW half and not the decoded one', () => {
		const stored = written().map((event) => asAnOlderVersionWrote(event, []));

		const reparsed = fetcher.reparse(stored);

		expect(reparsed).toHaveLength(1);
		// the stale decoded half is REPLACED rather than trusted
		expect((reparsed![0] as any).eventName).toBe('Transfer');
		expect((reparsed![0] as any).args).not.toEqual({stale: true});
	});
});

// -- and the LOAD PATH clears it rather than replaying it ---------------------

const LOGS = [makeLog(100, '0xa100'), makeLog(102, '0xa102'), makeLog(104, '0xa104')];
const TIP = 105;

/** Index once with a real keeper, so what comes back is a stream the engine itself wrote. */
async function streamOnDisk() {
	const store: ProcessorStore = {};
	const stream = memoryStream();
	const chain = fakeChain([...LOGS], TIP);
	const subject = fakeProcessor(store);
	const indexer = makeIndexer(chain, subject.processor, stream.keeper);
	await indexer.load();
	await indexToTip(indexer);
	return {events: stream.events.map((event) => ({...event})), cursor: stream.cursor!};
}

/**
 * The real re-decode, over the stream-cache world's fake chain.
 *
 * That world replaces the log fetcher wholesale and its `reparse` is a
 * pass-through, so the branch under test is unreachable through it: the RULE
 * (`LogEventFetcher.reparse`) is what decides "cannot re-read", and it is what
 * the load path must be driven with here.
 */
function withRealReparse(indexer: any, chain: ReturnType<typeof fakeChain>) {
	const decoder = new LogEventFetcher<Abi>(chain.provider, SOURCE.contracts as any);
	indexer.logEventFetcher = {
		...chain.fetcher,
		reparse: (events: LogEvent<Abi>[]) => decoder.reparse(events),
	};
	return indexer;
}

describe('the load path, over a stream it cannot re-read', () => {
	it('CLEARS it instead of replaying it on trust, and re-fetches from the start block', async () => {
		const {events, cursor} = await streamOnDisk();
		const stream = memoryStream({
			lastSync: cursor,
			eventStream: events.map((event) => asAnOlderVersionWrote(event, ['topics', 'data'])),
		});

		const chain = fakeChain([...LOGS], TIP);
		const reloaded = fakeProcessor({});
		const indexer = withRealReparse(makeIndexer(chain, reloaded.processor, stream.keeper), chain);
		await indexer.load();

		expect(stream.clears).toBe(1);
		expect(stream.events).toEqual([]);
		// nothing was replayed out of it: the stale `args` never reached the processor
		expect(reloaded.state).toEqual([]);
		expect(chain.ranges).toHaveLength(0);

		// and the re-index starts from the start block, out of the node
		await indexToTip(indexer);
		expect(chain.ranges[0].from).toBe(START_BLOCK);
		expect(reloaded.state).toEqual(LOGS.map(idOf));
	});

	it('replays the SAME stream untouched when the raw half is there, which is every stream this version writes', async () => {
		const {events, cursor} = await streamOnDisk();
		const stream = memoryStream({lastSync: cursor, eventStream: events});

		const chain = fakeChain([...LOGS], TIP);
		const reloaded = fakeProcessor({});
		const indexer = withRealReparse(makeIndexer(chain, reloaded.processor, stream.keeper), chain);
		await indexer.load();

		expect(stream.clears).toBe(0);
		expect(stream.events.map(idOf)).toEqual(LOGS.map(idOf));
		expect(reloaded.state).toEqual(LOGS.map(idOf));
		// out of the cache: the node was asked for nothing at all
		expect(chain.ranges).toHaveLength(0);
	});
});
