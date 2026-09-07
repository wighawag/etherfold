import {defineConfig, devices} from '@playwright/test';

export default defineConfig({
	testDir: './browser',
	timeout: 15 * 60 * 1000,
	expect: {timeout: 2 * 60 * 1000},
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				// `--enable-precise-memory-info` is what makes `performance.memory` a
				// MEASUREMENT rather than a rounded constant: without it every sample in
				// this spike read exactly 10,000,000 bytes and never moved. It changes
				// only the reporting granularity, and the driver cross-checks the same
				// moments over CDP so no number rests on the flag alone.
				launchOptions: {args: ['--enable-precise-memory-info']},
			},
		},
		{name: 'firefox', use: {...devices['Desktop Firefox']}},
		{name: 'webkit', use: {...devices['Desktop Safari']}},
	],
});
