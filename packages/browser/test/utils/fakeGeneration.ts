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
 * these suites is `identityOf(marker)` over synthetic bytes.
 *
 * OMITTING it is a deliberate choice and still not an un-migrated site, but the
 * reason has changed now that
 * `a-module-handed-to-a-tab-is-identified-by-its-handler-sources` has landed. The
 * cases that omit it are the ones driving `updateProcessor`, where what arrives is
 * a MODULE a dev server handed the tab: there are no bytes to hash, so the hook
 * derives that arrival's identity ITSELF from the handler sources
 * (`moduleProcessorIdentity`, which is `getCodeFingerprint()`) and accepts none
 * from a caller. A fake in those suites therefore REPORTS a fingerprint, and
 * passing an identity here would override the derivation under test rather than
 * supply a missing one.
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
