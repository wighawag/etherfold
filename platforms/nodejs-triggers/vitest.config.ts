import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		// Vitest defaults to 5s, which a suite competing with the whole workspace's gate can
		// blow on a busy machine. A generous timeout costs nothing when tests pass. See ADR-0032.
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
