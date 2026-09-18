import {describe, expect, it} from 'vitest';
import {processorCodeFingerprint} from '@etherfold/core';
import {VersionedStateEventProcessor, type SQLProcessor} from '../src/index.js';
import {createTestDB} from './utils/db.js';
import {processor, type TestABI} from './utils/fixtures.js';

// ---------------------------------------------------------------------------
// WHAT THIS WRAPPER ANSWERS ABOUT THE FOLD UNDERNEATH IT
// ---------------------------------------------------------------------------
// A processor's identity is DERIVED FROM WHAT IT IS and never declared by its
// author (ADR-0086), so this class states none: a host hands the engine the
// identity its ARRIVAL derived, and nothing here computes one.
//
// The one thing it does answer is `getCodeFingerprint()`, a digest of the
// AUTHOR's handler source. That is not an identity here -- a deployment folding
// through this class arrived as BYTES and is named by their hash -- but it IS the
// identity of the one arrival with none: a module a dev server handed a browser
// tab (`moduleProcessorIdentity`, `@etherfold/browser`).
//
// Which makes the DELEGATION the claim worth pinning, and it is why these cases
// live here rather than only in `@etherfold/core`. A tab is handed an already-built
// fold, so what it fingerprints is whatever this seam answers: a wrapper that
// fingerprinted ITSELF would return a constant no author edit could move, which is
// precisely the silent lie ADR-0086 exists to delete. This file is what goes red
// if that delegation is ever dropped.
//
// It replaces `version.test.ts`, which pinned the author-DECLARED version hash and
// the drift report that sat beside it; both were deleted with the
// declared identity itself.
// ---------------------------------------------------------------------------

/** The same processor with an EDITED handler, which is what a developer's save looks like. */
const editedHandler: SQLProcessor<TestABI> = {
	...processor,
	async onTransfer(state, event) {
		state.set('token', {id: event.args.id.toString()}, {owner: event.args.from});
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
};

describe('the code fingerprint this wrapper answers with', () => {
	it('is the AUTHOR\u2019s, taken through the wrapper rather than of it', () => {
		const wrapped = new VersionedStateEventProcessor(createTestDB(), processor);
		expect(wrapped.getCodeFingerprint()).toBe(processorCodeFingerprint(processor));
	});

	it('moves when a handler is edited, which is the whole reason a tab can be named by it', () => {
		const original = new VersionedStateEventProcessor(createTestDB(), processor);
		const edited = new VersionedStateEventProcessor(createTestDB(), editedHandler);

		expect(original.getCodeFingerprint()).toBeDefined();
		expect(original.getCodeFingerprint()).not.toBe(edited.getCodeFingerprint());
	});

	it('is identical for two instances over the same processor, so a reload names one fold', () => {
		const a = new VersionedStateEventProcessor(createTestDB(), processor);
		const b = new VersionedStateEventProcessor(createTestDB(), processor);
		expect(a.getCodeFingerprint()).toBe(b.getCodeFingerprint());
	});
});
