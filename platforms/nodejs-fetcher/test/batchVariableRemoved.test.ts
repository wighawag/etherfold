import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

// ---------------------------------------------------------------------------
// THE DEPLOYMENT DOCUMENTS NO VARIABLE THAT SETS A KNOB THAT IS GONE
// ---------------------------------------------------------------------------
// `PROVIDER_SUPPORTS_ETH_BATCH` set `providerSupportsETHBatch`, which let the
// per-hash block and transaction fetches go out as one batched request. Those
// fetches are DELETED (ADR-0073), so the knob is deleted with them, in
// `@etherfold/core`, in `@etherfold/fetcher-host` and here.
//
// HERE is the half that is easy to leave behind, and the more damaging one to
// leave: the code half fails loudly when a reader survives a deleted field,
// while a README row simply keeps promising a knob. An operator sets it, the
// deployment behaves no differently, and there is no way to tell that from a
// variable that works. So this file guards the DOCUMENTED surface, which is the
// one this package owns.
// ---------------------------------------------------------------------------

const here = fileURLToPath(new URL('../', import.meta.url));

const surfaces = ['README.md', 'src/index.ts'].map((path) => ({
	path,
	text: readFileSync(`${here}${path}`, 'utf-8'),
}));

describe('the batch variable is gone from the deployment surface', () => {
	it('reads the files it claims to check', () => {
		expect(surfaces.every((surface) => surface.text.length > 500)).toBe(true);
		// the env table is what the README half is really about, so fail loudly if
		// it is ever renamed out from under this check
		expect(surfaces[0].text).toContain('| `ETH_NODE_URI` |');
	});

	it('names neither spelling of the knob', () => {
		const offenders = surfaces.filter((surface) =>
			/PROVIDER_SUPPORTS_ETH_BATCH|providerSupportsETHBatch/.test(surface.text),
		);
		expect(offenders.map((surface) => surface.path)).toEqual([]);
	});
});
