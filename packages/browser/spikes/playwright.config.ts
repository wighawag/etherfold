import {defineConfig, devices} from '@playwright/test';

/**
 * The probe behind
 * `work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`.
 *
 * Three engines, because the whole finding is that they DISAGREE: the answer is
 * only meaningful as a comparison. Deliberately NOT part of any package's
 * `test:browser`, and not in the acceptance gate -- it is evidence for a
 * finding, re-runnable on demand, and it deliberately wedges a database, which
 * is not a thing to do on every commit.
 */
export default defineConfig({
	testDir: '.',
	timeout: 2 * 60 * 1000,
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	projects: [
		{name: 'chromium', use: {...devices['Desktop Chrome']}},
		{name: 'firefox', use: {...devices['Desktop Firefox']}},
		{name: 'webkit', use: {...devices['Desktop Safari']}},
	],
});
