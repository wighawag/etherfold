import type {Abi} from '@etherfold/core';
import {MemoryStateStore, openForWriting} from '@etherfold/state-store';
import type {BrowserGenerationSpec, EntityEventProcessorLike} from '../../src/IndexerState.js';

/**
 * A generation SPEC around a processor a test already hand-rolled.
 *
 * The hook takes the two factories a generation is built from -- its state, then
 * the fold over it -- because an indexer holds any number of generations and
 * each folds into its OWN state, so neither can be a value handed over once.
 * These suites are about the hook's own wiring (dispose, error routing,
 * reconfigure serialization, tx reconciliation) and their processors are fakes
 * that persist nothing, so there is nothing for `createState` to open: it hands
 * back an EMPTY memory store, CLAIMED, which is a real store that the fold never
 * touches.
 *
 * Deliberately not a cast over `undefined`: a generation HAS a
 * state even when the fold under test ignores it, and a fixture that lied about
 * that would be the one place a real requirement could go unnoticed.
 *
 * The IDENTITY is SUPPLIED rather than computed, because an author cannot state
 * one (ADR-0086): the caller passes what an arrival would have derived, which in
 * these suites is `identityOf(marker)` over synthetic bytes. The processors here
 * still ANSWER `getVersionHash()` -- it is on the seam until the contract task
 * removes it -- and nothing reads what they answer, which is why those fakes
 * return a `declared-version-...` value no assertion mentions.
 *
 * OMITTING it is a deliberate choice and not an un-migrated site. The cases that
 * do are the ones driving `updateProcessor`, where what arrives is a MODULE a dev
 * server handed the tab: there are no bytes to hash, and the identity for that
 * one arrival is derived from the handler sources by
 * `a-module-handed-to-a-tab-is-identified-by-its-handler-sources`. Until it
 * lands, those cases keep the author-declared fallback -- which this batch must
 * leave working anyway, and which they are the witness for inside this package.
 */
export function generationOf<ABI extends Abi, ProcessResultType>(
	processor: EntityEventProcessorLike<ABI, ProcessResultType, undefined>,
	processorIdentity?: string,
): BrowserGenerationSpec<ABI, ProcessResultType, undefined> {
	return {
		createState: () => openForWriting(new MemoryStateStore([])),
		createProcessor: () => processor,
		...(processorIdentity === undefined ? {} : {processorIdentity}),
	};
}
