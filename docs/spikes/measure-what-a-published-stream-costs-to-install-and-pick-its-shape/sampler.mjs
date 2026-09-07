/**
 * A DRIVER-SIDE heap sampler, over CDP, shared by the desktop and phone runs.
 *
 * The in-page instrument (`performance.memory`) needs Chromium's
 * `--enable-precise-memory-info` to report anything but a rounded constant, and
 * that flag is not something you can hand to Chrome on a phone without a rooted
 * command-line file. `Runtime.getHeapUsage` is measured by the inspector, needs
 * no flag, and is available over the same CDP transport on both, so the desktop
 * proxy and the real device are measured by the SAME instrument. That is what
 * makes the two comparable at all.
 *
 * ## What it can and cannot catch, said plainly
 *
 * It polls from OUTSIDE the page, so it keeps sampling while the page's main
 * thread is busy. What it cannot do is force a sample at an arbitrary instant
 * INSIDE a synchronous `JSON.parse`: the inspector answers when it can. The peak
 * it reports is therefore a floor, not a ceiling, and the true peak can only be
 * higher. It is reported as `peakSampledHeapBytes` rather than as "the peak" for
 * exactly that reason.
 */

/** Poll `Runtime.getHeapUsage` while `body` runs, and report the largest reading seen. */
export async function withHeapSampling(client, intervalMs, body) {
	if (!client) {
		const value = await body();
		return {value, samples: [], peakSampledHeapBytes: null, sampleCount: 0, intervalMs};
	}
	const samples = [];
	let running = true;
	const poll = (async () => {
		while (running) {
			try {
				const usage = await client.send('Runtime.getHeapUsage');
				samples.push({at: Date.now(), usedSize: usage.usedSize});
			} catch {
				// A stalled or closed inspector is not a measurement failure; it is a
				// gap in the samples, and a gap is what the floor caveat is about.
			}
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
	})();
	try {
		const value = await body();
		return {
			value,
			samples,
			peakSampledHeapBytes: samples.length > 0 ? Math.max(...samples.map((one) => one.usedSize)) : null,
			sampleCount: samples.length,
			intervalMs,
		};
	} finally {
		running = false;
		await poll;
	}
}
