import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import type {EntityProcessor, EntityStateView} from '@etherfold/processor-entities';
import {MemoryStateStore, openForWriting, type WritableStateStore} from '@etherfold/state-store';
import {connectToIndexerHost, createIndexerState, serveIndexerHost} from '../src/index.js';
import {identityOf} from './utils/processorIdentity.js';
import {wire} from './utils/port.js';
import {
	editedProcessorVariant,
	entityProcessorOver,
	fakeChain,
	FINALITY,
	indexToTip,
	processorVariant,
	readState,
	SOURCE,
	type TestABI,
} from '../browser/workload.js';

/**
 * THE ONE ARRIVAL THAT CANNOT HASH BYTES, given an identity of its own.
 *
 * ADR-0086's invariant is that an author cannot STATE a processor's identity and
 * that HOW one is derived belongs to the ARRIVAL. Every other arrival has bytes:
 * a pushed artifact, a bundle read off disk. A dev server does not -- it serves
 * unbundled ESM and hands the page a module OBJECT -- so this arrival derives its
 * identity from the HANDLER SOURCES instead, which is the code fingerprint in a
 * new role: not a second opinion beside a declared identity, but the identity
 * itself where no bytes exist.
 *
 * What it buys is the outcome that would otherwise be lost: a real handler edit
 * moves the identity and registers a successor, and a hot update that changed
 * nothing does not.
 *
 * ## WHY THESE ASSERT AT THE CONTAINER
 *
 * `an-hmr-update-reconfigures-the-tab-it-is-running-in` is blocked on this and
 * builds the three-outcome surface (registered / unchanged / failed) ON TOP of
 * it. So the claims here are made where the generation is actually named -- the
 * registry record the container filed, and the verdict `updateProcessor`
 * answered -- and never through an HMR API, which would invert the dependency.
 *
 * ## THE LIMITS, since they are real
 *
 * The derivation is over handler SOURCE TEXT (`moduleProcessorIdentity`,
 * `src/moduleIdentity.ts`), so it survives reformatting and re-ordering and does
 * NOT survive minification, a change of transpiler, or a change of behaviour that
 * leaves the text alone. `editedProcessorVariant` and `processorVariant` are that
 * pair on purpose: the first is an edit the derivation CAN see, and `countBy` is a
 * captured value it CANNOT.
 */

let counter = 0;
const freshName = () => `module-identity-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

async function memoryStore(definition: EntityProcessor<TestABI>): Promise<WritableStateStore> {
	return openForWriting(new MemoryStateStore(definition.entities));
}

/**
 * A TAB RUNNING A MODULE ITS DEV SERVER HANDED IT: the factories, and NOTHING
 * supplied.
 *
 * `processorIdentity` is deliberately absent, which is how an app says "no bytes
 * describe this fold". An app that passed one here would be declaring an
 * identity, which is the one door ADR-0086 leaves open and the thing this arrival
 * must never take.
 */
async function aTabRunning(definition: EntityProcessor<TestABI>, chain = fakeChain()) {
	const store = await memoryStore(definition);
	const indexer = createIndexerState<TestABI, EntityStateView>({
		createState: () => store,
		createProcessor: (state) => entityProcessorOver(state, definition),
	});
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
	await indexToTip(indexer);
	return {
		indexer,
		store,
		chain,
		/** What the registry FILED for the generation answering reads. */
		named: () => indexer.canonical?.record.processor,
		/** What the processor DECLARES, which must name nothing. */
		declared: () => entityProcessorOver(store, definition).getVersionHash(),
	};
}

describe('a module handed to a tab is identified by its handler sources', () => {
	/**
	 * The declared field names NOTHING and the handler sources name EVERYTHING,
	 * asserted as the pair, because either half alone is satisfiable by accident.
	 *
	 * DECLARED-PATH WITNESS. `declared()` asks a fold built with no identity for its
	 * `getVersionHash()`, which is the author-declared computation ADR-0086 moves off
	 * -- deliberately, because "the generation is not named by the declared hash" is a
	 * claim that needs that hash to exist and still work. It is one of the two cases
	 * in this package that `the-declared-version-and-the-drift-report-are-deleted`
	 * retires: when the declared half goes, the last assertion here goes with it and
	 * the two above it stand on their own.
	 */
	it('names the generation by its handler sources, with nothing declared and nothing supplied', async () => {
		const one = await aTabRunning(processorVariant({version: '1.0.0'}));
		// the SAME handlers under a different declared version: still one fold
		const declaredDifferently = await aTabRunning(processorVariant({version: '9.9.9'}));
		// the same declared version with an EDITED handler: a different fold, with no
		// author action at all
		const edited = await aTabRunning(editedProcessorVariant({version: '1.0.0'}));

		expect(declaredDifferently.named()).toBe(one.named());
		expect(edited.named()).not.toBe(one.named());
		// and it is not the declared hash wearing a different name
		expect(one.named()).not.toBe(one.declared());

		one.indexer.dispose();
		declaredDifferently.indexer.dispose();
		edited.indexer.dispose();
	});

	/**
	 * THE SAVE, and THE SAVE THAT CHANGED NOTHING, at the container that names
	 * them.
	 *
	 * A hot update hands the page a NEW module object every time, so "the same
	 * module again" is a second object over the same source -- which is why these
	 * build the definition twice rather than passing one object twice.
	 */
	it('registers a successor for an edited handler, and resolves to the held generation for the same one', async () => {
		const app = await aTabRunning(processorVariant());
		const running = app.named();

		const saved = await app.indexer.addGeneration({
			createState: () => memoryStore(processorVariant()),
			createProcessor: (state) => entityProcessorOver(state, editedProcessorVariant()),
		});
		expect(saved.record.processor).not.toBe(running);
		expect(app.indexer.generations.length).toBe(2);

		// saved again with nothing changed: the same fold, so the container resolves to
		// the generation it already holds rather than adding a second engine over it
		const again = await app.indexer.addGeneration({
			createState: () => memoryStore(processorVariant()),
			createProcessor: (state) => entityProcessorOver(state, editedProcessorVariant()),
		});
		expect(again.record.processor).toBe(saved.record.processor);
		expect(app.indexer.generations.length).toBe(2);

		app.indexer.dispose();
	});

	/**
	 * The same claim on the call that takes a module DIRECTLY, which is what a hot
	 * update has in its hand.
	 */
	it('discards for an edited handler and says nothing changed for a save that changed nothing', async () => {
		const app = await aTabRunning(processorVariant());
		expect((await readState(app.indexer.state.$state)).transfers).toBe(5);

		// the developer saved a file they had not changed
		const unchanged = await app.indexer.updateProcessor(entityProcessorOver(app.store, processorVariant()));
		expect(unchanged.stateDiscarded).toBe(false);
		expect((await readState(app.indexer.state.$state)).transfers).toBe(5);

		// and then edited a handler, without touching `version`
		const edited = await app.indexer.updateProcessor(
			entityProcessorOver(app.store, editedProcessorVariant({countBy: 10})),
		);
		expect(edited.stateDiscarded).toBe(true);

		await indexToTip(app.indexer);
		expect((await readState(app.indexer.state.$state)).transfers).toBe(50);

		app.indexer.dispose();
	});

	/**
	 * THE BYTES ARRIVALS ARE UNTOUCHED: an identity the arrival supplied is what
	 * names the generation, and this derivation never runs beside it.
	 *
	 * The second half is ADR-0086's stated consequence rather than a wart: the SAME
	 * code has a different identity as a MODULE than as a BUNDLE, because a dev
	 * iteration and a deployed build are different generations anyway, and
	 * conflating them would be the lie the ADR exists to remove.
	 */
	it('never overrides a supplied identity, so the same code is named differently as bytes', async () => {
		const definition = processorVariant();
		const chain = fakeChain();
		const store = await memoryStore(definition);
		const fromBytes = createIndexerState<TestABI, EntityStateView>({
			createState: () => store,
			createProcessor: (state) => entityProcessorOver(state, definition),
			// a tab that FETCHED a self-contained bundle and hashed those octets
			processorIdentity: identityOf(freshName()),
		});
		await fromBytes.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
		await indexToTip(fromBytes);

		const asModule = await aTabRunning(definition);

		expect(fromBytes.canonical?.record.processor).toBe(fromBytes.generations[0].record.processor);
		expect(fromBytes.canonical?.record.processor).toMatch(/^sha256:/);
		expect(asModule.named()).not.toBe(fromBytes.canonical?.record.processor);

		fromBytes.dispose();
		asModule.indexer.dispose();
	});

	/**
	 * DECLARED-PATH WITNESS, and the SECOND of the two this package keeps.
	 *
	 * `moduleProcessorIdentity` answers `undefined` for a processor whose handlers
	 * have no readable source -- all `bind`-ed, or behind a proxy -- and says so in as
	 * many words: hashing `[native code]` would be a constant no edit could move, so
	 * the caller falls back to the declared hash "exactly as it did before this
	 * arrival had a derivation of its own". That fallback is PRODUCTION code in
	 * `@etherfold/browser`, it is the last place the declared path is reachable here,
	 * and this case exists to prove it still works. It is
	 * `the-declared-version-and-the-drift-report-are-deleted` that retires it: that
	 * task has to decide what an unnameable module is called once there is no declared
	 * hash left to fall back to, and this is the case that goes red when it does not.
	 *
	 * Asserted at the CONTAINER, like every other case here: what a generation is
	 * FILED as is the only thing that matters, and the point is that such a module
	 * still gets a name rather than none.
	 */
	it('falls back to the declared hash for a module whose handlers have no readable source', async () => {
		// The AUTHOR'S object with every handler `bind`-ed, which is what a module put
		// behind a wrapper looks like and the one shape `processorCodeFingerprint`
		// refuses to name: `Function.prototype.toString` answers `[native code]` for all
		// of them, so there is no source text to hash. It is the author's object and not
		// the fold built over it, because that is what `getCodeFingerprint()` reads.
		const bound = {...processorVariant()} as EntityProcessor<TestABI>;
		for (const [name, value] of Object.entries(bound)) {
			if (typeof value === 'function') {
				(bound as Record<string, unknown>)[name] = value.bind(bound);
			}
		}

		const store = await memoryStore(bound);
		const chain = fakeChain();
		const indexer = createIndexerState<TestABI, EntityStateView>({
			createState: () => store,
			createProcessor: (state) => entityProcessorOver(state, bound),
		});
		await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});

		// the derivation really did decline, which is what makes the rest of this a
		// statement about the FALLBACK rather than about a hash that happened to differ
		expect(entityProcessorOver(store, bound).getCodeFingerprint()).toBeUndefined();
		// so the generation is named by what the author DECLARED -- which is the whole of
		// the fallback, and the whole of what goes dark when it is removed
		expect(indexer.canonical?.record.processor).toBe(entityProcessorOver(store, bound).getVersionHash());

		indexer.dispose();
	});

	/**
	 * The WORKER hosts build a generation through their own driver
	 * (`serveIndexerHost`), so the derivation is asserted there too: an app must not
	 * be named differently for having moved its fold off the UI thread, which is what
	 * "the three hosting shapes run one implementation" means about identity.
	 */
	it('names a generation a host built the same way, so moving the fold off the UI thread renames nothing', async () => {
		const definition = processorVariant();
		const inTheTab = await aTabRunning(definition);
		const ends = wire();
		const chain = fakeChain();
		const host = serveIndexerHost<TestABI, EntityStateView>(
			{
				// THE HOST IS THE WRITER, so the store is opened in here (ADR-0077)
				createState: () => memoryStore(definition),
				createProcessor: (store) => entityProcessorOver(store, definition),
				provider: chain.provider,
				source: SOURCE,
				config: {stream: {finality: FINALITY}},
				tipIntervalInSeconds: 0.05,
			},
			ends.host,
		);
		const port = connectToIndexerHost(ends.tab);
		try {
			const generations = await port.generations();
			expect(generations).toHaveLength(1);
			expect(generations[0].record.processor).toBe(inTheTab.named());
		} finally {
			await host.dispose();
			ends.close();
			inTheTab.indexer.dispose();
		}
	});
});
