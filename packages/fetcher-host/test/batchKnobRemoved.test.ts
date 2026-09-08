import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';
import {resolveFetcherHostConfig, type FetcherHostConfigOverrides} from '../src/index.js';
import {SOURCE, type TestABI} from './harness.js';

// ---------------------------------------------------------------------------
// `PROVIDER_SUPPORTS_ETH_BATCH` IS NOT READ, AND IS NOT DOCUMENTED EITHER
// ---------------------------------------------------------------------------
// The knob told the engine it could send one batched request instead of N. The
// requests it batched -- the per-hash block and transaction fetches -- are
// DELETED (ADR-0073), so it buys nothing, and this host carried it purely to
// pass it through.
//
// It is deleted rather than left unread, because this one was OPERATOR-FACING:
// `platforms/nodejs-fetcher` documented it as a deployment variable, and a
// documented variable that is read and ignored is indistinguishable from one
// that works. So the removal spans the environment, the resolved config and the
// README together, and this file pins the first two.
//
// A deployment that still sets the variable is not warned and not aliased:
// nothing is published yet (CONTEXT.md), so it is simply ignored like any other
// unrecognised variable, exactly as `STREAM_ALWAYS_FETCH_TIMESTAMPS` is.
// ---------------------------------------------------------------------------

const ENV = {
	INDEXING_SOURCE: JSON.stringify(SOURCE),
	ETH_NODE_URI: 'https://eth-mainnet.example/v2/AN-API-KEY',
};

describe('the resolved config carries no opinion about batch support', () => {
	it('ignores `PROVIDER_SUPPORTS_ETH_BATCH` however it is spelled in the environment', () => {
		for (const value of ['true', '1', 'yes', 'false']) {
			const config = resolveFetcherHostConfig<TestABI>({...ENV, PROVIDER_SUPPORTS_ETH_BATCH: value});
			// the KEY and not merely a falsy value: a resolved config still carrying
			// the field would be handed straight to a `LogFetcher` that no longer
			// declares it
			expect(Object.keys(config)).not.toContain('providerSupportsETHBatch');
		}
	});

	it('has no override to pass either', () => {
		// Deliberately never CALLED: the assertion is the `@ts-expect-error`, which
		// `pnpm typecheck` runs and which FAILS if the line compiles again.
		function refusal() {
			// @ts-expect-error the knob is DELETED, with no alias and no deprecated stub behind it
			const overrides: FetcherHostConfigOverrides<TestABI> = {providerSupportsETHBatch: true};
			return overrides;
		}
		expect(typeof refusal).toBe('function');
	});

	it('names neither spelling anywhere in the package', () => {
		// Searched in BOTH spellings, because a config key and its environment
		// variable do not grep alike: scoping the check to one of them is how the
		// first draft of this removal concluded the flag had no readers left.
		const root = fileURLToPath(new URL('../src/', import.meta.url));
		const offenders = filesUnder(root).filter((file) =>
			/providerSupportsETHBatch|PROVIDER_SUPPORTS_ETH_BATCH/.test(readFileSync(file, 'utf-8')),
		);
		expect(offenders.map((file) => file.slice(root.length))).toEqual([]);
	});
});

/** Every `.ts` under a directory, in a stable order. */
function filesUnder(directory: string): string[] {
	return readdirSync(directory, {withFileTypes: true})
		.sort((a, b) => (a.name < b.name ? -1 : 1))
		.flatMap((entry) =>
			entry.isDirectory()
				? filesUnder(join(directory, entry.name, '/'))
				: entry.name.endsWith('.ts')
					? [join(directory, entry.name)]
					: [],
		);
}
