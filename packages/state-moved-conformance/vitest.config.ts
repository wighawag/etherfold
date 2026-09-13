import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		// The same generous bound every package in this repository sets, and for the
		// same reason (ADR-0032): the gate runs the whole workspace at once, so a
		// normally-fast case competes with everything else and a 5s default reddens
		// the gate for a reason that has nothing to do with the code. A timeout is
		// only reached on failure, so a generous one costs nothing when tests pass.
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
