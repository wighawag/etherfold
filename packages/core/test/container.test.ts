import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import type {EventProcessor, IndexingSource} from '../src/types.js';
import {openIndexer, UnheldGenerationError, type GenerationSpec} from '../src/container.js';
import type {PromotionConfig} from '../src/generation/promotion.js';
import {openMemoryGenerationRegistry} from '../src/generation/memory.js';
import {
	unslottedGenerations,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistry,
} from '../src/generation/registry.js';
import {bundleBytes, identityOf, identityOfBytes, markerOf} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------
// THE GENERATION CONTAINER, which is now the only shape there is.
// ---------------------------------------------------------------------------
// An indexer HOLDS generations and points at the one that answers reads;
// `IndexerGeneration` is ONE of them. Nothing here indexes a chain: what is
// asserted is the container's own claims -- generations are BUILT from
// factories, reads resolve through the canonical pointer INDIRECTLY, a pointer
// move is applied AT A NOTIFICATION, and a DISCARD is published rather than
// merely applied.

const CHAIN_ID_HEX = '0x1';

function makeProvider() {
	return {
		async request(args: {method: string}): Promise<unknown> {
			switch (args.method) {
				case 'eth_chainId':
					return CHAIN_ID_HEX;
				case 'eth_blockNumber':
					return '0x0';
				case 'eth_getLogs':
					return [];
				default:
					throw new Error(`unexpected method ${args.method}`);
			}
		},
	} as never;
}

const SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0}],
};

/** A read HANDLE, like the entity path's: the same object every time, bound to one generation's state. */
type Handle = {read(): string};

/**
 * Which handle belongs to which processor.
 *
 * `stateOf` is asked about a PROCESSOR, and the container re-points the held
 * processor when a swap discards -- so a fixture that answered from a captured
 * variable instead would go on naming the fold that was replaced, which is the
 * one thing these assertions are about.
 */
const handles = new WeakMap<EventProcessor<Abi, Handle>, Handle>();

type Fold = {
	processor: EventProcessor<Abi, Handle>;
	/** The state this generation folds into: a name, so a read says which generation answered. */
	store: {name: string; opened: number};
	handle: Handle;
	calls: {load: number; process: number};
};

function makeFold(name: string): Fold {
	const store = {name, opened: 0};
	const handle: Handle = {read: () => store.name};
	const calls = {load: 0, process: 0};
	const processor: EventProcessor<Abi, Handle> = {
		getCodeFingerprint: () => undefined,
		load: async () => {
			calls.load++;
			return undefined;
		},
		process: async () => {
			calls.process++;
			return handle;
		},
		reset: async () => {},
		clear: async () => {},
	};
	handles.set(processor, handle);
	return {processor, store, handle, calls};
}

/**
 * The two factories, in the order a generation's identity forces: state, then the
 * fold over it -- plus the identity the ARRIVAL supplied.
 *
 * The identity is a hash of BYTES, because that is what an arrival has (ADR-0086)
 * and because nothing in the container parses one: it is compared and rendered.
 * Synthetic bytes are therefore exactly as good as a bundler's, and these
 * assertions are about WHICH generation answered rather than about what any code
 * inside one does.
 */
function specFor(fold: Fold): GenerationSpec<Abi, Handle, {name: string; opened: number}> {
	return {
		createState: () => {
			fold.store.opened++;
			return fold.store;
		},
		createProcessor: () => fold.processor,
		processorIdentity: identityOf(fold.store.name),
		stateOf: (processor) => handles.get(processor) as Handle,
	};
}

/** What each slot holds, as the fold that names it, so an assertion reads as a sentence. */
async function slotsOf(registry: GenerationRegistry) {
	const held = await registry.slots();
	const name = (record: GenerationRecord | undefined) => markerOf(record?.processor);
	return {canonical: name(held.canonical), successor: name(held.successor), predecessor: name(held.predecessor)};
}

/**
 * A container over these folds.
 *
 * `promotion` is how a case says what it is about. This runtime DROPS what a
 * promotion superseded by default (ADR-0090), so a case whose subject is
 * something else -- the read path following the pointer, a slot assignment, the
 * registration path's own guard -- turns the drop off and says so, rather than
 * having its second generation disappear underneath it. The drop itself is
 * asserted where it belongs, in `promotion.test.ts`.
 */
async function openContainer(folds: Fold[], registry?: GenerationRegistry, promotion?: PromotionConfig) {
	const held = registry ?? (await openMemoryGenerationRegistry({maxGenerations: 4, maxStreams: 2}));
	const indexer = await openIndexer<Abi, Handle>({
		registry: held,
		provider: makeProvider(),
		source: SOURCE,
		...(promotion ? {promotion} : {}),
		generations: folds.map(specFor),
	});
	return {indexer, registry: held};
}

/** What a case says when its subject is NOT the drop: keep what a promotion superseded. */
const RETAINING: PromotionConfig = {dropOnPromotion: false};

describe('the generation container', () => {
	it('BUILDS each generation from its factories: state first, then the fold over it', async () => {
		const order: string[] = [];
		const fold = makeFold('A');
		const registry = await openMemoryGenerationRegistry({maxGenerations: 2, maxStreams: 1});
		const indexer = await openIndexer<Abi, Handle>({
			registry,
			provider: makeProvider(),
			source: SOURCE,
			generations: [
				{
					createState: (context) => {
						order.push(`state:${context.stream}`);
						return fold.store;
					},
					createProcessor: (state, context) => {
						order.push(`processor:${(state as {name: string}).name}:${context.stream}`);
						return fold.processor;
					},
					processorIdentity: identityOf('A'),
					stateOf: (processor) => handles.get(processor) as Handle,
				},
			],
		});

		const stream = indexer.canonical.record.stream;
		expect(order).toEqual([`state:${stream}`, `processor:A:${stream}`]);
		// the fold half of the identity is the one the ARRIVAL supplied, recorded after
		// both factories ran rather than declared twice
		expect(indexer.canonical.record.processor).toBe(identityOf('A'));
		expect(await registry.canonical()).toMatchObject({stream, processor: identityOf('A')});
	});

	it('takes the FOLD HALF of the identity from the ARRIVAL, not from the processor it built', async () => {
		const fold = makeFold('A');
		const registry = await openMemoryGenerationRegistry({maxGenerations: 2, maxStreams: 1});
		const indexer = await openIndexer<Abi, Handle>({
			registry,
			provider: makeProvider(),
			source: SOURCE,
			generations: [
				{
					createState: () => fold.store,
					createProcessor: () => fold.processor,
					// what a deployment that read a BUNDLE off disk would hand over: the hash of
					// those octets, derived from something the processor cannot see
					processorIdentity: identityOfBytes(bundleBytes('A')),
				},
			],
		});

		// ADR-0086: an author cannot STATE a processor's identity, and the engine is
		// HANDED one and never asks where it came from.
		expect(indexer.canonical.record.processor).toBe(identityOfBytes(bundleBytes('A')));
		expect(await registry.canonical()).toMatchObject({
			stream: indexer.canonical.record.stream,
			processor: identityOfBytes(bundleBytes('A')),
		});

		// ...and it is the BYTES that name it: one edited handler, one different
		// generation, with no author action in either case
		expect(identityOfBytes(bundleBytes('A'))).not.toBe(identityOfBytes(bundleBytes('A-edited')));
	});

	it('holds several generations, and only the canonical one ANSWERS', async () => {
		const a = makeFold('A');
		const b = makeFold('B');
		const {indexer} = await openContainer([a, b]);

		expect(indexer.generations.map((held) => held.record.processor)).toEqual([identityOf('A'), identityOf('B')]);
		// the FIRST registered is canonical, which is the registry's rule
		expect(indexer.canonical.record.processor).toBe(identityOf('A'));
		expect(indexer.state.read()).toBe('A');

		await indexer.load();
		// EVERY generation loads, because every generation advances: a fold that
		// never loaded has no state and no cursor to advance from. Which one ANSWERS
		// is still the canonical pointer's decision and nothing else's.
		expect(a.calls.load).toBe(1);
		expect(b.calls.load).toBe(1);
		expect(indexer.state.read()).toBe('A');
		// ...and the second one is a FOLLOWER, because it shares the first's stream
		expect(indexer.generations.map((held) => held.follows)).toEqual([false, true]);
	});

	it('gives each generation its OWN state, built once', async () => {
		const a = makeFold('A');
		const b = makeFold('B');
		await openContainer([a, b]);
		expect(a.store.opened).toBe(1);
		expect(b.store.opened).toBe(1);
	});

	it('refuses to point reads at a generation it does not hold', async () => {
		const a = makeFold('A');
		const {indexer} = await openContainer([a]);
		await expect(
			indexer.promote({stream: indexer.canonical.record.stream, processor: identityOf('B')}),
		).rejects.toThrow(UnheldGenerationError);
	});
});

describe('the state handle is INDIRECT', () => {
	it('keeps answering across a pointer move, from the newly canonical generation', async () => {
		const a = makeFold('A');
		const b = makeFold('B');
		const {indexer} = await openContainer([a, b]);

		// story 6: a reader holds the handle ACROSS the move and never re-reads it
		const handle = indexer.state;
		expect(handle.read()).toBe('A');

		await indexer.promote(indexer.generations[1].record);

		expect(handle.read()).toBe('B');
		// ...and it is the same object, because a handle whose identity changed on
		// every publication would defeat exactly the callers who keep one
		expect(indexer.state).toBe(handle);
	});

	it('follows the pointer BACK, which is what makes a promotion revertible', async () => {
		const a = makeFold('A');
		const b = makeFold('B');
		// RETAINING, because what is asserted is the HANDLE following the pointer in
		// both directions, and a move back needs a generation to move back to
		const {indexer} = await openContainer([a, b], undefined, RETAINING);
		const handle = indexer.state;

		await indexer.promote(indexer.generations[1].record);
		expect(handle.read()).toBe('B');
		await indexer.promote(indexer.generations[0].record);
		expect(handle.read()).toBe('A');
	});
});

/**
 * A DISCARD IS PUBLISHED, and the container is what publishes it.
 *
 * `onStateUpdated` fires when a state is ADOPTED or PRODUCED, and a discard is
 * neither (`ReconfigureOutcome`), so a subscriber holding the state the fold
 * just lost is told by nothing -- and on the reconfigure this exists for (a
 * contract redeployed behind its proxy, which has emitted nothing yet) the next
 * publication never comes at all.
 *
 * The browser hook used to fill that silence itself. It is HERE now, because the
 * container is what knows a verb discarded, and because a consumer that drives
 * the container without that hook (a server, a CLI, a test) was never told at
 * all.
 */
describe('a discard is PUBLISHED and not merely applied', () => {
	it('tells subscribers when a processor swap discarded the fold', async () => {
		const a = makeFold('A');
		const b = makeFold('B');
		const {indexer} = await openContainer([a]);

		const published: string[] = [];
		indexer.onStateUpdated = (state) => published.push(state.read());

		// the identity comes from the ARRIVAL that produced the new processor, the same
		// way the spec that registered the running one supplied its own
		expect(await indexer.updateProcessor(b.processor, {processorIdentity: identityOf('B')})).toEqual({
			stateDiscarded: true,
		});

		// the NEW fold's handle, because the old one no longer exists: a subscriber
		// that kept what it was handed is now reading the generation that is folding
		expect(published).toEqual(['B']);
		expect(indexer.state.read()).toBe('B');
	});

	it('tells subscribers when an explicit reset discarded the fold', async () => {
		const a = makeFold('A');
		const {indexer} = await openContainer([a]);

		const published: string[] = [];
		indexer.onStateUpdated = (state) => published.push(state.read());

		expect(await indexer.reset()).toEqual({stateDiscarded: true});
		expect(published).toEqual(['A']);
	});

	it('says nothing when the reconfigure kept the fold', async () => {
		const a = makeFold('A');
		const {indexer} = await openContainer([a]);

		const published: string[] = [];
		indexer.onStateUpdated = (state) => published.push(state.read());

		// the same identity, unforced: the core skips the swap, so there is nothing to
		// say -- and a store blanked on every save would be its own bug
		expect(await indexer.updateProcessor(a.processor, {processorIdentity: identityOf('A')})).toEqual({
			stateDiscarded: false,
		});
		expect(published).toEqual([]);
	});
});

/**
 * A GENERATION IS HELD BY A DURABLE NAMED SLOT (ADR-0084), in the chain-facing
 * twin.
 *
 * The slots themselves -- what they mean, what `create` and `moveCanonicalTo`
 * write -- are pinned in `generationRegistry.test.ts`, and the receiving twin's
 * application of them in `receivingContainer.test.ts`. What is asserted here is
 * this container's half: `add` registers into `successor`, so a generation added
 * beside the live one REPLACES the pending one rather than piling up, and the
 * replacement can never reach the generation that answers reads.
 *
 * **A move HERE assigns no `predecessor` (ADR-0089)**, which is the one place the
 * two containers differ about slots: in a browser the code a superseded fold needs
 * is absent from the build, so the slot would name something this runtime cannot
 * instantiate. The receiving twin's half -- where the assignment is exactly as it
 * always was, because an operator reverts there without redeploying -- is asserted
 * in `receivingContainer.test.ts`.
 *
 * The runtime the rule was written FOR is a browser tab, and the claims that are
 * only observable there -- a RELOAD over the same IndexedDB, the state keyspace
 * really going, and what a cap of two means under three slots -- are in
 * `@etherfold/browser`'s `aTabHoldsItsGenerationsInSlots.test.ts`.
 */
describe('a generation is held by a durable named SLOT', () => {
	/** A registry that records what it was asked to drop the state of. */
	async function registryRecordingDrops(caps = {maxGenerations: 4, maxStreams: 2}) {
		const dropped: GenerationId[] = [];
		const registry = await openMemoryGenerationRegistry(caps, {
			dropState: async (id) => {
				dropped.push(id);
			},
		});
		return {registry, dropped};
	}

	it('registers a generation added beside the live one INTO `successor`', async () => {
		const {registry} = await registryRecordingDrops();
		const {indexer} = await openContainer([makeFold('A')], registry);

		// the first generation of an empty registry takes `canonical` whatever slot
		// was asked for, because a registry holding generations and pointing at none
		// of them answers nothing
		expect(await slotsOf(registry)).toEqual({canonical: 'A', successor: undefined, predecessor: undefined});

		await indexer.add(specFor(makeFold('B')));

		expect(await slotsOf(registry)).toEqual({canonical: 'A', successor: 'B', predecessor: undefined});
	});

	it('REPLACES what `successor` held, and drops it: the slot holds AT MOST ONE', async () => {
		const {registry, dropped} = await registryRecordingDrops();
		const {indexer} = await openContainer([makeFold('A')], registry);
		const b = await indexer.add(specFor(makeFold('B')));

		const c = await indexer.add(specFor(makeFold('C')));

		expect(await slotsOf(registry)).toEqual({canonical: 'A', successor: 'C', predecessor: undefined});
		// the row, the state, and this container's driving of it: all three go
		expect(dropped).toEqual([{stream: b.record.stream, processor: b.record.processor}]);
		expect((await registry.list()).map((record) => record.processor)).toEqual([identityOf('A'), identityOf('C')]);
		expect(indexer.generations.map((held) => held.record)).toEqual([indexer.canonical.record, c.record]);
	});

	it('assigns NO `predecessor` on a promotion, leaving the superseded generation UNSLOTTED (ADR-0089)', async () => {
		const {registry, dropped} = await registryRecordingDrops();
		// RETAINING, because the subject is the SLOT and not the drop: with this
		// runtime's own default the superseded generation also GOES (ADR-0090), which
		// would leave nothing to observe the assignment on. What ADR-0089 decides is
		// that no slot names it, whatever then happens to it.
		const {indexer} = await openContainer([makeFold('A')], registry, RETAINING);
		const b = await indexer.add(specFor(makeFold('B')));

		await indexer.promote(b.record);

		// the pointer moved and NOTHING is slotted behind it: a tab can never run the
		// fold a `predecessor` would name, because that code is not in the build
		expect(await slotsOf(registry)).toEqual({canonical: 'B', successor: undefined, predecessor: undefined});
		// ...and it is COLLECTABLE rather than collected: no deleter is added here, and
		// the row and the state are exactly where the promotion found them
		expect(
			unslottedGenerations(await registry.list(), await registry.slots()).map((r) => markerOf(r.processor)),
		).toEqual(['A']);
		expect(dropped).toEqual([]);
		expect((await registry.list()).map((record) => record.processor)).toEqual([identityOf('A'), identityOf('B')]);
	});

	it('never displaces what `canonical` names, and keeps the superseded generation that FETCHES the stream', async () => {
		const {registry, dropped} = await registryRecordingDrops();
		// RETAINING, so that the superseded generation is still here for a REGISTRATION
		// to be refused against: that guard is the subject, and it is untouched by the
		// hand-over a promotion does (ADR-0090 narrows the PROMOTION's decline, not this
		// one)
		const {indexer} = await openContainer([makeFold('A')], registry, RETAINING);
		const b = await indexer.add(specFor(makeFold('B')));
		await indexer.promote(b.record);

		const c = await indexer.add(specFor(makeFold('C')));
		await indexer.add(specFor(makeFold('D')));

		// the replacement reached the PENDING successor and nothing else: "not canonical
		// right now" would have taken the generation that answers reads with it
		expect(await slotsOf(registry)).toEqual({canonical: 'B', successor: 'D', predecessor: undefined});
		expect(dropped).toEqual([{stream: c.record.stream, processor: c.record.processor}]);
		// A is named by no slot and survives anyway, and the reason is worth stating: it
		// is the FETCHER of the stream every one of these folds is on (ADR-0044), so
		// dropping it would leave them folding a stream nothing appends to. What keeps it
		// is the strand rule and no longer a slot.
		expect((await registry.list()).map((record) => record.processor)).toContain(identityOf('A'));
		expect(await registry.fetcherOf(b.record.stream)).toMatchObject({processor: identityOf('A')});
		// ...so a move back to it is still a move to a registered generation this
		// container holds a fold for, and it still answers from its own state
		await indexer.promote({stream: c.record.stream, processor: identityOf('A')});
		expect(indexer.state.read()).toBe('A');
	});

	it('replaces what a PREVIOUS container left in the slot, having remembered nothing', async () => {
		const {registry, dropped} = await registryRecordingDrops();
		const before = await openContainer([makeFold('A')], registry);
		const abandoned = await before.indexer.add(specFor(makeFold('B')));

		// a container that registered nothing and saw nothing, over the same records:
		// this is the RESTART, and no in-memory rule could reach it
		await openContainer([makeFold('A'), makeFold('C')], registry);

		expect(await slotsOf(registry)).toEqual({canonical: 'A', successor: 'C', predecessor: undefined});
		expect(dropped).toEqual([{stream: abandoned.record.stream, processor: abandoned.record.processor}]);
		expect((await registry.list()).map((record) => record.processor)).toEqual([identityOf('A'), identityOf('C')]);
	});
});

/**
 * A GENERATION THIS CONTAINER HOLDS NO FOLD FOR IS COLLECTED WHEN A REGISTRATION
 * NEEDS ROOM (ADR-0090, point 3).
 *
 * The shape is a PROMOTION followed by a RELOAD. A save registers the edited fold,
 * the policy promotes it, and the superseded generation is left named by no slot
 * (ADR-0089). The next page load holds exactly ONE fold, because that is all a tab
 * can supply -- the previous processor's code is not in the bundle -- so the
 * superseded generation's row survives as something that can never answer a read
 * and can never fetch, and nothing on this runtime collects it: there is no
 * `reclaim` verb here (ADR-0084). Measured, the developer's next save then met
 * `maxGenerations` and no page reload could clear it.
 *
 * **The two cases below differ in ONE fact and it is the whole decision**: whether
 * this container holds a fold for the superseded generation. Held, it is retained,
 * because it is what FETCHES the stream the arriving fold is on and dropping it
 * would leave that fold folding a stream nothing appends to (ADR-0044). Unheld,
 * there is no fold to strand and nothing to keep it for, so it goes. Neither case
 * touches `dropOnPromotion`, the promotion path or the caps: this collects at a
 * REGISTRATION and at no other moment.
 *
 * The receiving twin's answer to the same question is the opposite one and is
 * asserted in `receivingContainer.test.ts` (a registration leaves it alone) and in
 * `@etherfold/cli`'s `aGenerationNoSlotNamesIsReclaimed.test.ts` (an operator's
 * verb takes it).
 */
describe('a generation this container holds NO FOLD for is COLLECTED when a registration needs room', () => {
	/** A registry at the browser's own arithmetic -- two generations -- recording what it dropped. */
	async function registryAtTheTightCap(maxGenerations = 2) {
		const dropped: GenerationId[] = [];
		const registry = await openMemoryGenerationRegistry(
			{maxGenerations, maxStreams: 2},
			{
				dropState: async (id) => {
					dropped.push(id);
				},
			},
		);
		return {registry, dropped};
	}

	/**
	 * Session one: index on A, save B beside it, and let the pointer move to B.
	 *
	 * RETAINING, which is what leaves a superseded generation to be collected LATER
	 * at all. With this runtime's default the promotion drops it there and then
	 * (ADR-0090, points 1 and 2) and there is no row for a reload to inherit -- so
	 * this is the embedder that turned the drop off, which is the configuration the
	 * rule below still has to be right for.
	 */
	async function aContainerThatSavedAndPromoted(registry: GenerationRegistry) {
		const session = await openContainer([makeFold('A')], registry, RETAINING);
		const promoted = await session.indexer.add(specFor(makeFold('B')));
		await session.indexer.promote(promoted.record);
		return session;
	}

	it('collects it on the SAVE after a reload, and the save lands where it was REFUSED', async () => {
		const {registry, dropped} = await registryAtTheTightCap();
		await aContainerThatSavedAndPromoted(registry);

		// THE RELOAD: a container holding the one fold the bundle carries, over records
		// the previous session left. Opening collects NOTHING -- the fold it arrives with
		// is the one `canonical` already names, so it takes nobody's place -- which is
		// what keeps this a registration rather than a sweep.
		const reloaded = await openContainer([makeFold('B')], registry, RETAINING);
		expect((await registry.list()).map((record) => markerOf(record.processor))).toEqual(['A', 'B']);
		expect(dropped).toEqual([]);

		// THE SAVE THAT USED TO BE REFUSED: `A` is named by no slot, this container holds
		// no fold for it, and it is not canonical, so it goes and the registration lands.
		const saved = await reloaded.indexer.add(specFor(makeFold('C')));

		expect((await registry.list()).map((record) => markerOf(record.processor))).toEqual(['B', 'C']);
		expect(dropped.map((id) => markerOf(id.processor))).toEqual(['A']);
		// ...the pointer never moved, so the generation answering reads is untouched...
		expect(await slotsOf(registry)).toEqual({canonical: 'B', successor: 'C', predecessor: undefined});
		expect(reloaded.indexer.state.read()).toBe('B');
		// ...and the STREAM they are all on is KEPT, because no drop reaps one (ADR-0087):
		// the new fold re-folds bytes already on disk rather than asking a node for
		// history it may refuse
		expect(await registry.keptStreams()).toEqual([saved.record.stream]);
	});

	it('RETAINS it in-session, because a fold here follows the stream it fetches', async () => {
		const {registry, dropped} = await registryAtTheTightCap(3);
		const session = await aContainerThatSavedAndPromoted(registry);

		// the same records, the same slots and the same arriving save -- and this container
		// HOLDS the superseded fold, which is the one difference
		await session.indexer.add(specFor(makeFold('C')));

		// it is the FETCHER of the stream the arriving fold is on, so dropping it would
		// leave that fold folding a stream nothing appends to (ADR-0044). A REGISTRATION
		// has nothing that has provably reached this writer's cursor, which is exactly
		// what a PROMOTION has and what lets that one hand the stream over instead
		// (ADR-0090, points 1 and 2): the guard is narrowed there and untouched here.
		expect((await registry.list()).map((record) => markerOf(record.processor))).toEqual(['A', 'B', 'C']);
		expect(dropped).toEqual([]);
		expect(await registry.fetcherOf(session.indexer.canonical.record.stream)).toMatchObject({
			processor: identityOf('A'),
		});
		expect(session.indexer.generations.map((held) => markerOf(held.record.processor))).toEqual(['A', 'B', 'C']);
	});
});

describe('the read unit of work is the interval between notifications', () => {
	it('applies a pointer move AT a notification, and not when the registry records it', async () => {
		const a = makeFold('A');
		const b = makeFold('B');
		const {indexer, registry} = await openContainer([a, b]);

		const log: string[] = [];
		indexer.onStateUpdated = (state) => log.push(`notify:${state.read()}`);

		log.push(`read:${indexer.state.read()}`);
		// the DECISION is recorded durably here...
		await registry.moveCanonicalTo(indexer.generations[1].record);
		// ...and the READ PATH has not moved with it, because nothing was notified:
		// every read in this interval still answers from ONE generation
		log.push(`read:${indexer.state.read()}`);
		log.push(`read:${indexer.state.read()}`);

		await indexer.promote(indexer.generations[1].record);
		log.push(`read:${indexer.state.read()}`);

		expect(log).toEqual(['read:A', 'read:A', 'read:A', 'notify:B', 'read:B']);
	});

	it('publishes the INDIRECT handle to the notification, not the generation it came from', async () => {
		const a = makeFold('A');
		const b = makeFold('B');
		// RETAINING: the case moves the pointer back at the end, so it needs the
		// generation it moves back to
		const {indexer} = await openContainer([a, b], undefined, RETAINING);

		let published: Handle | undefined;
		indexer.onStateUpdated = (state) => {
			published = state;
		};
		await indexer.promote(indexer.generations[1].record);

		// a subscriber that KEEPS what it was handed keeps something that follows
		// the pointer, rather than a reference to the generation that was canonical
		// at the moment it was told
		expect(published).toBe(indexer.state);
		expect(published?.read()).toBe('B');
		await indexer.promote(indexer.generations[0].record);
		expect(published?.read()).toBe('A');
	});
});
