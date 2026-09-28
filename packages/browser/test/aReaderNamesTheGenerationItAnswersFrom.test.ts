import {describe, expect, it} from 'vitest';
import {generationDigestOf} from '@etherfold/core';
import {readerGenerationOf} from '../src/tabElection.js';

/**
 * A READER under the tab election answers queries from the shared store (ADR-0097,
 * ADR-0099), and every answer names the generation it came from. A reader holds
 * no container, so it names the one its LEADER last named on the state-moved
 * signal, or, before that, the one its own spec names, and refuses rather than
 * invent one. The end-to-end run is `@etherfold/graphql`'s worker conformance.
 */
describe('the generation a reader names', () => {
	const context = {stream: 'stream-digest'};

	it('is the one the leader last named, when it has named one', async () => {
		expect(await readerGenerationOf('leader-generation', context, {processorIdentity: 'mine'})).toBe(
			'leader-generation',
		);
	});

	it('before the leader has said anything, is the one its own spec names', async () => {
		expect(await readerGenerationOf(undefined, context, {processorIdentity: 'mine'})).toBe(
			generationDigestOf({stream: 'stream-digest', processor: 'mine'}),
		);
	});

	it('is refused, not invented, when neither the leader nor the spec names it', async () => {
		await expect(readerGenerationOf(undefined, context, {})).rejects.toThrow(/cannot name the generation/);
	});
});
