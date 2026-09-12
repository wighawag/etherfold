import {rm} from 'node:fs/promises';
import {mountHarness as mountUpstream} from 'playwright-browser-harness';

/**
 * `mountHarness`, WITH THE TEMP DIRECTORY ACTUALLY CLEANED UP.
 *
 * `playwright-browser-harness@0.3.0` builds each case's page into a fresh
 * `mkdtemp(join(tmpdir(), 'harness-'))` and its `dispose()` closes the HTTP
 * server WITHOUT removing that directory:
 *
 * ```js
 * async dispose() { if (close) await close(); }
 * ```
 *
 * So every mounted harness leaks its bundle. It is about 4.5 MB a time here
 * (`bundle.js` plus its map, `worker.js` plus its map), and this package mounts
 * one per CASE -- roughly 230 MB for one three-engine run of the suite.
 *
 * ## Why that is not merely untidy
 *
 * On a machine where `/tmp` is a tmpfs, which is the default on most Linux
 * systems, those bytes are RAM. Running this suite repeatedly -- which is
 * exactly what one does while chasing an intermittent failure -- walks a 16 GB
 * `/tmp` to 100% full, and what follows is not a clean error: esbuild starts
 * failing with `no space left on device`, and everything still running gets
 * slower and begins timing out. That looks like a flaky browser and is not one.
 * 3,013 leaked directories holding 11 GB were measured on this machine before
 * this wrapper existed.
 *
 * ## Why it is fixed HERE rather than at each call site
 *
 * The harness returns its own `outdir`, so removing it is three lines -- but
 * three lines in every spec, which is three lines to forget in the next one. A
 * wrapper that keeps the upstream shape means each spec's existing
 * `finally { await harness.dispose(); }` simply starts cleaning up, and the only
 * change a spec makes is which module it imports `mountHarness` from.
 *
 * `force: true` because a failed mount may never have created the directory, and
 * a cleanup that throws would mask the real failure it is running after.
 *
 * ## It removes only a directory this mount OWNS
 *
 * `prebuilt: {outdir, serverUrl}` is how the harness attaches a SECOND page to a
 * build another mount already made -- which is how a multi-tab case gives every
 * tab the same bytes. Those mounts share one directory and did not create it, so
 * removing it on their `dispose` would delete the bundle the others are still
 * being served. Only the mount that built it cleans it up.
 */
export async function mountHarness(
	...args: Parameters<typeof mountUpstream>
): Promise<Awaited<ReturnType<typeof mountUpstream>>> {
	const harness = await mountUpstream(...args);
	// A mount handed a `prebuilt` directory is a guest in it.
	const owned = (args[1] as {prebuilt?: unknown} | undefined)?.prebuilt === undefined;
	return {
		...harness,
		async dispose() {
			try {
				await harness.dispose();
			} finally {
				if (owned && harness.outdir) await rm(harness.outdir, {recursive: true, force: true});
			}
		},
	};
}
