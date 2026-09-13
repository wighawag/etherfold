import {describe, it} from 'vitest';
import {stateMovedConformanceCases} from './suite.js';
import type {ConformanceCase, StateMovedTransportFactory} from './types.js';

/**
 * Register the whole suite as vitest tests. One factory, one call:
 *
 * ```ts
 * await describeStateMovedConformance('the state-moved signal across a tab\u2019s port', () => openThePortTransport());
 * ```
 *
 * It is awaited at the top level of the test file, because the case list depends
 * on what the transport OFFERS and that can only be read from one. Vitest
 * collects a test file as an ES module, so the top-level await finishes before
 * collection does, and each case is registered as its own `it` -- which is the
 * point of the adapter: a divergence is reported as the BEHAVIOUR that broke, on
 * the TRANSPORT that broke it, rather than as one opaque red suite.
 *
 * The label is what names the transport, so put the transport in it: the failure
 * a reader of CI output wants is "the cross-tab channel replays to a late
 * joiner", not "case 4 failed".
 */
export async function describeStateMovedConformance(label: string, factory: StateMovedTransportFactory): Promise<void> {
	const list = await stateMovedConformanceCases(factory);

	describe(label, () => {
		for (const [group, entries] of byGroup(list)) {
			describe(group, () => {
				for (const one of entries) it(one.name, one.run);
			});
		}
	});
}

/** Cases in the order they were declared, gathered under their group. */
function byGroup(list: readonly ConformanceCase[]): Map<string, ConformanceCase[]> {
	const groups = new Map<string, ConformanceCase[]>();
	for (const one of list) {
		const entries = groups.get(one.group) ?? [];
		if (entries.length === 0) groups.set(one.group, entries);
		entries.push(one);
	}
	return groups;
}
