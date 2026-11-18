import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		// Vitest defaults to 5s, which a suite competing with the whole workspace's gate can
		// blow on a busy machine. A generous timeout costs nothing when tests pass. See ADR-0032.
		testTimeout: 60_000,
		hookTimeout: 60_000,
		server: {
			deps: {
				// The tests run `@etherfold/server` (and so `@etherfold/graphql`) from this
				// workspace through vite, which hands it graphql's ESM build while Node loads
				// Pothos's `import 'graphql'` as CJS: two instances, and graphql-js refuses a
				// schema one built inside the other. The same setting as `@etherfold/server`'s.
				inline: [/@pothos\/core/],
			},
		},
	},
});
