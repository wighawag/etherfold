/**
 * The narrowest real processor: a fold that RUNS, so "instantiated" can be proved by
 * calling it rather than by the absence of an error.
 *
 * It is deliberately dependency-free apart from a sibling module, because the question
 * is CSP and not bundling; what matters is that the artifact is a self-contained ESM
 * bundle produced by the documented command, which is what a retained generation stores.
 */
import {bump} from './counter.js';

export const processor = {
	name: 'spike-counter',
	handleEvent(state, event) {
		return {count: bump(state.count ?? 0), last: event.name};
	},
};

export default processor;
