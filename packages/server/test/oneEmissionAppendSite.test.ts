import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {EMISSION_STREAM_TABLE} from '../src/index.js';

/**
 * THE STORED EMISSION STREAM IS APPENDED IN EXACTLY ONE PLACE (ADR-0052).
 *
 * The defect this closes was not that the rows were wrong; it was that the write
 * belonged to a TRANSPORT. `appendEmissions` was called from the HTTP ingest
 * route and from nowhere else, so `etherfold run` and `etherfold build` -- which
 * fold through `createDirectIngestion` and touch no route -- produced databases
 * whose emission table was EMPTY, on the deployment shape the milestone calls
 * the default and on the artifact `build` exists to publish.
 *
 * The obvious repair is the wrong one, exactly as it was for the reorg counters
 * one task earlier (`packages/core/test/oneReorgWriteSite.test.ts`, whose shape
 * this borrows): adding a second call site for the shapes that stored nothing.
 * Then the shape that both CONCLUDES and RECEIVES has two, and stores every
 * emission twice -- which is not even a loud failure, because `seq` is allocated
 * from the table and a duplicate simply lands at the next number, so both of
 * ADR-0006's views would serve every log twice for ever. So the rule is
 * structural rather than careful: the append is taken once, inside
 * `StreamBuilder.receive`, through an `EmissionAppender` the store's owner
 * supplied, and this is what stops a later change quietly growing the second
 * site back.
 *
 * ## Why it lives in THIS package and not in `@etherfold/core`
 *
 * Its sibling is in core because the durable KEY NAMES it scans for are in core:
 * the writer and the reader of a reorg count are deliberately in different
 * packages. The emission table is the opposite -- this package owns its DDL, both
 * views that read it and the append itself -- so the durable name to scan for is
 * `EMISSION_STREAM_TABLE`, right here, and importing it is what keeps this test
 * and the table from drifting apart. What it scans is still the whole WORKSPACE,
 * because the property is a fact about every shipped package and there is no
 * workspace-level test harness.
 */

const ROOT = new URL('../../../', import.meta.url).pathname;

/** Where SHIPPED code lives. A test may write an emission row to set a scenario up; shipped code may not. */
const GROUPS = ['packages', 'platforms'];

function sourceFilesOf(packageDirectory: string): string[] {
	const src = join(packageDirectory, 'src');
	if (!existsSync(src)) return [];
	const found: string[] = [];
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, {withFileTypes: true})) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith('.ts')) found.push(path);
		}
	};
	walk(src);
	return found;
}

const shippedSources = GROUPS.flatMap((group) =>
	readdirSync(join(ROOT, group), {withFileTypes: true})
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) => sourceFilesOf(join(ROOT, group, entry.name))),
);

/**
 * A file that WRITES the emission stream: it names the table AND inserts into or
 * updates it.
 *
 * The `UPDATE` half is not padding. A retraction is two writes -- the retraction
 * row appended, and `alive = 0` on the emission it takes back -- and a second
 * place flipping that flag would be as damaging as a second place inserting,
 * because the canonical view is defined by it. The one thing that DELETES
 * (pair-compaction, ADR-0006) is deliberately not in scope here: it is a call a
 * host schedules and it is not part of the fold.
 */
const APPENDS = new RegExp(
	`(INSERT\\s+INTO|UPDATE)\\s+(\\$\\{\\s*EMISSION_STREAM_TABLE\\s*\\}|${EMISSION_STREAM_TABLE})`,
	'i',
);

const writeSites = shippedSources
	.map((path) => ({path, text: readFileSync(path, 'utf-8')}))
	.filter(({text}) => APPENDS.test(text))
	.map(({path}) => path.slice(ROOT.length));

describe('a folded emission has ONE writer', () => {
	it('finds the shipped sources to scan at all', () => {
		expect(shippedSources.length).toBeGreaterThan(50);
	});

	it('is written in exactly one module, the one the store owner binds its appender from', () => {
		// `compaction.ts` names the table and DELETES from it, which is a host-scheduled
		// reclaim rather than part of the fold; it appends nothing and flags nothing.
		expect(writeSites).toEqual(['packages/server/src/emissions.ts']);
	});

	it('is not written by the HTTP ingest route, which is a CALLER of the fold and not its owner', () => {
		// the specific regression: this route owned the write, and the deployment shape
		// the milestone calls the default never reaches it
		const route = readFileSync(join(ROOT, 'packages/server/src/api/ingest.ts'), 'utf-8');
		expect(route).not.toMatch(new RegExp(`INSERT\\s+INTO\\s+${EMISSION_STREAM_TABLE}`, 'i'));
		expect(route).not.toMatch(/appendEmissions/);
	});

	it('is not taken by anything that merely RECEIVES an outcome', () => {
		// `IngestionOutcome.emissions` is reported so a caller can log it or answer a
		// sender with the counts. A caller that STORED it would store only on the shape
		// it happens to be, and twice on the shape that is both.
		const callers = ['packages/server/src/api/ingest.ts', 'packages/core/src/directIngestion.ts'];
		for (const caller of callers) {
			expect(readFileSync(join(ROOT, caller), 'utf-8')).not.toMatch(
				new RegExp(`INSERT\\s+INTO\\s+${EMISSION_STREAM_TABLE}`, 'i'),
			);
		}
	});
});
