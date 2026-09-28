import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		// Vitest defaults to 5s. That is fine on an idle box and wrong on a machine
		// someone is using: the gate runs the whole workspace at once, so a heavy
		// suite competes with everything else and a normally-fast test blows the
		// limit. It reddened the gate three times in one session, in three
		// unrelated packages, each time blocking a task that had nothing to do
		// with the test that failed. A generous timeout costs nothing when tests
		// pass, since it is only reached on failure. See ADR-0032.
		testTimeout: 60_000,
		hookTimeout: 60_000,
		server: {
			deps: {
				// graphql 16 ships CJS (`main`) and ESM (`module`) with no `exports` map, so
				// Node loads Pothos's `import 'graphql'` as CJS while vite hands this
				// package's source the ESM build: two instances, and graphql-js refuses a
				// schema built by one inside the other. Inlining Pothos puts its import
				// through vite's resolution too, which is what a bundler does anyway.
				inline: [/@pothos\/core/],
			},
		},
	},
});
