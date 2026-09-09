import {defineConfig, devices} from '@playwright/test';

/**
 * Three engines, because the corner this probes (multiEntry with ARRAY subkeys)
 * is exactly where engine behaviour has historically diverged from the spec, and
 * an answer from one engine would not be an answer.
 */
export default defineConfig({
	testDir: './browser',
	timeout: 5 * 60 * 1000,
	expect: {timeout: 30 * 1000},
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	projects: [
		{name: 'chromium', use: {...devices['Desktop Chrome']}},
		{name: 'firefox', use: {...devices['Desktop Firefox']}},
		{name: 'webkit', use: {...devices['Desktop Safari']}},
	],
});
