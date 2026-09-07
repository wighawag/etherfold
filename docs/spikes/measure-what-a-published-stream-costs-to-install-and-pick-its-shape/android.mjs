/**
 * The SAME measurement, on a REAL ANDROID PHONE over USB.
 *
 * This exists because desktop Playwright is a proxy for a phone and the source
 * spec says so in as many words: what a throttled laptop cannot show you is real
 * mobile memory pressure, the eviction that follows it, slower storage, and a
 * tab being suspended in the background. So the numbers that decide whether a
 * low-memory device SURVIVES an install are taken on a device.
 *
 * It runs the identical `browser/cut.ts` and the identical prepared assets as
 * the desktop spec, and it measures the heap with the identical driver-side CDP
 * sampler (`sampler.mjs`), so the two sets of numbers are comparable rather than
 * merely adjacent.
 *
 *   node android.mjs                 # every case
 *   ANDROID_CASES=single-stored node android.mjs
 *
 * ## What it needs
 *
 * A phone with USB debugging on, visible to `adb devices`, with Chrome
 * installed. Nothing is installed onto the phone and nothing is left behind but
 * a browsing-data entry for a localhost origin.
 *
 * It ALSO needs one toggle inside Chrome ITSELF, and there is no way around it:
 * Android's USB debugging lets adb talk to the DEVICE, and a second, separate
 * permission lets anything talk to CHROME. Without it both available routes
 * hang, in ways that look like a bug and are not:
 *
 *  - `_android.launchBrowser()` writes `/data/local/tmp/chrome-command-line`
 *    with a debugging socket argument, and Chrome IGNORES that file unless
 *    `chrome://flags/#enable-command-line-on-non-rooted-devices` is on, so
 *    Playwright waits forever for a socket that never appears.
 *  - the CDP route below connects to `@chrome_devtools_remote` (the socket
 *    `chrome://inspect` uses), which EXISTS whenever Chrome runs, but serves no
 *    HTTP at all until Chrome's own developer options allow web debugging. The
 *    connection succeeds and then returns nothing, which is what a timeout with
 *    zero bytes received means.
 *
 * The CDP route is the default here because it is the standard remote-debugging
 * path, needs no file written to the device, and hands back an ordinary
 * Playwright `Page` with a full CDP session, which is what the heap sampler
 * needs. `ANDROID_MODE=launch` selects the other one.
 *
 * ## How the phone reaches the harness
 *
 * The harness serves from the DESKTOP. `adb reverse tcp:<port> tcp:<port>` makes
 * the phone's own `localhost:<port>` resolve to that server, so the page fetches
 * the same bytes over USB rather than over a network whose speed would be part
 * of every number. Transfer time on this run is therefore NOT a mobile network
 * measurement, and is labelled as such: what the phone is here to measure is
 * PARSE, HEAP and STORAGE, which are the parts a desktop flatters.
 *
 * ## The one thing this cannot do
 *
 * `--enable-precise-memory-info` cannot be passed to Chrome on a phone without
 * writing a command-line file to the device, so the IN-PAGE counter is Chrome's
 * quantised one and is ignored here. The CDP sampler needs no flag and is what
 * the heap figures come from, with the floor caveat `sampler.mjs` documents.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {_android as android, chromium} from 'playwright';
import {buildBundle, startServer, mountHarness} from 'playwright-browser-harness';
import {withHeapSampling} from './sampler.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, 'results');
const ASSETS = path.join(HERE, 'assets');
const CUT = path.join(HERE, 'browser/cut.ts');
const ADB = process.env.ADB ?? 'adb';

const CASES = [
	{
		id: 'single-decoded-committed',
		name: 'single, decoded, as committed (indented, parseStreamFixture)',
		params: {mode: 'single', url: './assets/single/stream.json.gz', parse: 'fixture'},
	},
	{
		id: 'single-decoded-compact',
		name: 'single, decoded, compact (parseStreamFixture)',
		params: {mode: 'single', url: './assets/single-compact/stream.json.gz', parse: 'fixture'},
	},
	{
		id: 'single-decoded-json',
		name: 'single, decoded, compact (plain JSON.parse: isolates the revive)',
		params: {mode: 'single', url: './assets/single-compact/stream.json.gz', parse: 'json'},
	},
	{
		id: 'single-stored',
		name: 'single, STORED-only, compact (plain JSON.parse)',
		params: {mode: 'single', url: './assets/single-stored/stream.json.gz', parse: 'json'},
	},
	{id: 'chunked-4000', name: 'chunked 4000, decoded', params: {mode: 'chunked', base: './assets/chunks-4000'}},
	{id: 'chunked-1000', name: 'chunked 1000, decoded', params: {mode: 'chunked', base: './assets/chunks-1000'}},
	{
		id: 'chunked-stored-4000',
		name: 'chunked 4000, STORED-only',
		params: {mode: 'chunked', base: './assets/chunks-stored-4000'},
	},
];

const REPEATS = Number(process.env.SPIKE_REPEATS ?? 3);
/** `cdp` (default) = connect to Chrome's own debugging socket; `launch` = Playwright's Android API. */
const MODE = process.env.ANDROID_MODE ?? 'cdp';
/** Where the forwarded DevTools endpoint lands on this machine. */
const DEVTOOLS_PORT = Number(process.env.ANDROID_DEVTOOLS_PORT ?? 9222);
const only = process.env.ANDROID_CASES?.split(',').map((one) => one.trim());
const selected = only ? CASES.filter((one) => only.includes(one.id)) : CASES;

if (!fs.existsSync(path.join(ASSETS, 'single', 'stream.json.gz'))) {
	throw new Error('assets are missing: run `node prepare.mjs` first');
}

const devices = await android.devices();
if (devices.length === 0) {
	console.error(
		'No Android device found.\n' +
			'  - plug the phone in over USB\n' +
			'  - enable Developer options, then USB debugging\n' +
			'  - accept the "Allow USB debugging?" prompt on the phone\n' +
			`  - check it appears in \`${ADB} devices\``,
	);
	process.exit(1);
}

const device = devices[0];
const model = device.model();
const serial = device.serial();
console.log(`device: ${model} (${serial})`);

/** What the phone IS, recorded with the numbers: a model name alone is not a spec. */
function deviceFacts() {
	const shell = (command) => {
		try {
			return execFileSync(ADB, ['-s', serial, 'shell', command], {encoding: 'utf-8'}).trim();
		} catch {
			return 'unknown';
		}
	};
	const meminfo = shell('cat /proc/meminfo');
	const totalKb = /MemTotal:\s+(\d+)/.exec(meminfo)?.[1];
	return {
		model,
		serial,
		androidRelease: shell('getprop ro.build.version.release'),
		sdk: shell('getprop ro.build.version.sdk'),
		hardware: shell('getprop ro.hardware'),
		soc: shell('getprop ro.soc.model') || shell('getprop ro.board.platform'),
		memTotalBytes: totalKb ? Number(totalKb) * 1024 : null,
		chromeVersion: shell('dumpsys package com.android.chrome | grep versionName | head -1').replace(/.*versionName=/, ''),
	};
}

/**
 * Keep the screen on while the cable is in, and wake it now.
 *
 * Learned by losing a full pass to it: the phone slept between cases, Chrome
 * stopped servicing navigations, and the run died with a Playwright timeout on
 * `waiting until "load"` that says nothing about the cause. `svc power stayon
 * usb` reverts when the cable comes out, so it leaves the device as it was.
 */
try {
	execFileSync(ADB, ['-s', serial, 'shell', 'svc', 'power', 'stayon', 'usb'], {stdio: 'ignore'});
	execFileSync(ADB, ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], {stdio: 'ignore'});
} catch {
	console.warn('could not set stay-awake; if the run dies on a navigation timeout, the phone went to sleep');
}

const facts = deviceFacts();
console.log(
	`  android ${facts.androidRelease} (sdk ${facts.sdk}), soc ${facts.soc}, ` +
		`${facts.memTotalBytes ? `${(facts.memTotalBytes / 1073741824).toFixed(1)} GB RAM` : 'RAM unknown'}, chrome ${facts.chromeVersion}`,
);

// BUILD then SERVE ourselves, so the port is known before the phone is told to
// reach it: `adb reverse` has to be in place before the page navigates.
const outdir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'seed-install-android-'));
await buildBundle({cut: CUT, outdir});
fs.cpSync(ASSETS, path.join(outdir, 'assets'), {recursive: true});
const server = await startServer({root: outdir, coi: true});
const port = new URL(server.url).port;
execFileSync(ADB, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
console.log(`serving ${outdir} at ${server.url}, reversed onto the phone`);

/**
 * A page on the phone, whichever route is in force.
 *
 * The CDP route drives the Chrome the user already has: it starts it on the
 * harness URL, forwards the debugging socket, attaches, and takes the page that
 * is already there rather than opening another. It also FAILS FAST with the
 * exact toggle to flip, because the raw symptom (a connect that returns no
 * bytes) says nothing about the cause.
 */
async function openPage() {
	if (MODE === 'launch') {
		await device.shell('am force-stop com.android.chrome');
		const launched = await device.launchBrowser();
		return {context: launched, page: await launched.newPage(), close: () => launched.close()};
	}

	await device.shell(
		`am start -a android.intent.action.VIEW -n com.android.chrome/com.google.android.apps.chrome.Main -d '${server.url}/'`,
	);
	await new Promise((resolve) => setTimeout(resolve, 3000));
	try {
		execFileSync(ADB, ['-s', serial, 'forward', '--remove', `tcp:${DEVTOOLS_PORT}`], {stdio: 'ignore'});
	} catch {
		// nothing was forwarded yet, which is the ordinary first run
	}
	execFileSync(ADB, ['-s', serial, 'forward', `tcp:${DEVTOOLS_PORT}`, 'localabstract:chrome_devtools_remote']);

	const endpoint = `http://127.0.0.1:${DEVTOOLS_PORT}`;
	const reachable = await fetch(`${endpoint}/json/version`, {signal: AbortSignal.timeout(8000)}).catch(() => null);
	if (!reachable) {
		throw new Error(
			`Chrome's debugging socket is present but serving nothing at ${endpoint}.\n` +
				`That is Chrome's own web-debugging permission, which is SEPARATE from Android USB debugging.\n` +
				`On the phone: Chrome > Settings > About Chrome > tap the version 7 times to reveal\n` +
				`"Developer options", then enable USB web debugging there. (On some builds the equivalent\n` +
				`switch is chrome://flags/#enable-command-line-on-non-rooted-devices, which instead unblocks\n` +
				`ANDROID_MODE=launch.) Then re-run.`,
		);
	}
	const browser = await chromium.connectOverCDP(endpoint);
	const attached = browser.contexts()[0];
	const page = attached.pages()[0] ?? (await attached.newPage());
	return {context: attached, page, close: () => browser.close()};
}

fs.mkdirSync(RESULTS, {recursive: true});
const file = path.join(RESULTS, `install-cost-android-${model.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}.json`);

const rows = [];

/**
 * Written after EVERY run, not once at the end.
 *
 * The first full pass on the phone completed all 21 runs and then hung in
 * teardown, so nothing was saved and the device had to be driven again for data
 * that had already been collected. A measurement that only persists if the
 * process exits cleanly is a measurement you lose.
 */
function save() {
	fs.writeFileSync(
		file,
		`${JSON.stringify({device: model, deviceFacts: facts, ranAt: new Date().toISOString(), throttle: 'none (real device)', rows}, null, 2)}\n`,
	);
}

let opened;
try {
	opened = await openPage();
	const {context, page} = opened;

	for (const one of selected) {
		for (let repeat = 0; repeat < REPEATS; repeat++) {
			const harness = await mountHarness(page, {prebuilt: {outdir, serverUrl: server.url}});
			try {
				const client = await context.newCDPSession(page);
				const sampled = await withHeapSampling(client, 25, () => harness.run({phase: 'once', params: one.params}));
				const run = sampled.value;
				if (run.errors.length > 0) {
					console.error(`  ${one.name} [${repeat}] FAILED: ${run.errors[0].split('\n')[0]}`);
				}
				rows.push({
					case: one.name,
					repeat,
					throttle: 'none (real device)',
					device: model,
					...run.results,
					peakSampledHeapBytes: sampled.peakSampledHeapBytes,
					heapSampleCount: sampled.sampleCount,
					timings: run.timings,
					env: run.env,
					errors: run.errors,
				});
				const total = run.timings.filter((t) => !/^chunks: /.test(t.label)).reduce((n, t) => n + t.ms, 0);
				save();
				console.log(
					`  ${one.name} [${repeat}]: ${total.toFixed(0)} ms, ` +
						`peak ${sampled.peakSampledHeapBytes ? (sampled.peakSampledHeapBytes / 1048576).toFixed(1) : '-'} MB (cdp)`,
				);
			} finally {
				await harness.reset?.();
				await harness.dispose();
			}
		}
	}
} finally {
	await opened?.close();
	await server.close();
	try {
		execFileSync(ADB, ['-s', serial, 'reverse', '--remove', `tcp:${port}`]);
	} catch {
		// the reverse dies with the adb connection anyway
	}
	fs.rmSync(outdir, {recursive: true, force: true});
}

save();
console.log(`\nwritten to ${path.relative(HERE, file)} (${rows.length} runs)`);
// The teardown above can hang on a device that has gone to sleep, and every row
// is already on disk by now, so do not let it hold the process open.
process.exit(0);
