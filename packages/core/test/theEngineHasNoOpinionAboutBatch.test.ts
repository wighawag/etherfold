import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import type {ProvidedLogFetcherConfig} from '../src/logFetcher.js';
import type {ProvidedIndexerConfig} from '../src/types.js';

// ---------------------------------------------------------------------------
// THE ENGINE HAS NO OPINION ABOUT BATCH SUPPORT, BECAUSE IT ASKS NOTHING TWICE
// ---------------------------------------------------------------------------
// `providerSupportsETHBatch` existed for one reason: the per-hash block and
// transaction fetchers issued N requests in a `for` loop, and a provider that
// answered `eth_batch` could be sent one instead. Those fetchers are DELETED
// (ADR-0073), so the engine's whole chain-facing surface is one `eth_getLogs`
// per range, one `eth_blockNumber` for the tip and one `eth_chainId` for the
// identity guard. There is no request left to batch, so there is nothing for a
// deployment to tell the engine about batching.
//
// The correction that matters is what this is NOT: batch RPC is not prohibited
// and never was. A caller's provider may batch whatever it likes, transparently,
// and the engine neither knows nor cares -- it simply no longer asks a question
// a batch could answer. ADR-0002's consequence bullet says exactly that, and it
// says it because a bullet that merely disappeared would read as a reversal.
//
// Two properties, failing differently:
//
//   1. TYPE -- the flag is GONE from BOTH deployment shapes of ADR-0003 rather
//      than defaulted off, with no alias and no deprecated stub, so a config
//      still setting it does not compile. `pnpm typecheck` is what runs this
//      half; vitest strips types.
//   2. STRUCTURAL -- no source file in the package names it. That covers the
//      thing a deleted knob usually leaves behind: a field nothing reads, which
//      looks like a supported option to the next person to read the type.
//
// Nothing here is an identity change. The flag was a sibling of `stream` rather
// than a member of it, so it was never in the resolved stream config and never
// in the digest taken over it: no stream forks and no history is re-fetched.
// ---------------------------------------------------------------------------

describe('the batch flag is gone from the config of both deployment shapes', () => {
	it('has no flag to set on the single-process indexer', () => {
		// Deliberately never CALLED: the assertion is the `@ts-expect-error`, and it
		// FAILS if the line starts compiling again.
		function refusal() {
			// @ts-expect-error the flag is DELETED, with no alias and no deprecated stub behind it
			const config: ProvidedIndexerConfig<Abi> = {stream: {finality: 12}, providerSupportsETHBatch: true};
			return config;
		}
		expect(typeof refusal).toBe('function');
	});

	it('has no flag to set on the split log-fetcher either', () => {
		function refusal() {
			// @ts-expect-error the flag is DELETED, with no alias and no deprecated stub behind it
			const config: ProvidedLogFetcherConfig = {stream: {finality: 12}, providerSupportsETHBatch: true};
			return config;
		}
		expect(typeof refusal).toBe('function');
	});

	it('names the flag nowhere in the package', () => {
		// A knob whose readers went away is worse standing than deleted: it is
		// indistinguishable, to a reader of the type, from one that works.
		const root = fileURLToPath(new URL('../src/', import.meta.url));
		const offenders = filesUnder(root).filter((file) => /providerSupportsETHBatch/.test(readFileSync(file, 'utf-8')));
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
