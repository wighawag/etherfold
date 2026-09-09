import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';

/**
 * Does ONE multiEntry index over computed `[field, value]` subkeys work, on the
 * three engines this ships in?
 *
 * The spec says it must. This says whether it does. The probes are in `cut.ts`;
 * this file mounts them, records what each engine answered, and fails on any
 * probe that did not hold, so a partial answer is a red run rather than a
 * footnote in a results file.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '../results');
const CUT = path.join(HERE, 'cut.ts');

test('a multiEntry index over computed field keys serves where and orderBy', async ({page}, testInfo) => {
	const harness = await mountHarness(page, {cut: CUT, coi: false});
	try {
		const run = await harness.run({phase: 'once', params: {tag: `multientry-${Date.now()}`}});

		fs.mkdirSync(RESULTS, {recursive: true});
		fs.writeFileSync(
			path.join(RESULTS, `${testInfo.project.name}.json`),
			JSON.stringify(
				{
					project: testInfo.project.name,
					ranAt: new Date().toISOString(),
					userAgent: run.env.userAgent,
					...run.results,
					errors: run.errors,
				},
				null,
				2,
			),
		);

		expect(run.errors).toEqual([]);
		// named individually so a failure says WHICH property the engine broke
		expect(run.results.failed).toEqual([]);
		expect(run.results.passed).toBe(run.results.total);
	} finally {
		await harness.dispose().catch(() => undefined);
	}
});
