/**
 * The page-side runner. Served CONCATENATED behind `mechanisms.js` (see its header), so it
 * has no imports of its own and cannot be silenced by the very policy it is measuring.
 *
 * It runs every portable mechanism in the DOCUMENT, then the two a document alone can do:
 * hand the bytes to a SERVICE WORKER that re-serves them at a same-origin URL, and hand
 * them to a same-origin DEDICATED WORKER, twice -- once with the worker's own response
 * carrying no policy (what a static host sends) and once carrying the page's policy.
 */

async function fetchArtifacts() {
	const [bundle, iife, corrupt] = await Promise.all([
		fetch('/artifact/bundle').then((r) => r.arrayBuffer()),
		fetch('/artifact/iife').then((r) => r.arrayBuffer()),
		fetch('/artifact/corrupt').then((r) => r.arrayBuffer()),
	]);
	return {bundle, iife, corrupt};
}

/**
 * The mechanism that is interesting precisely because it is NOT a special scheme: a
 * service worker holds the retained bytes and answers a same-origin URL with them, so what
 * the module loader sees is an ordinary script from the app's own origin. If `'self'`
 * admits it, then a policy that forbids `blob:` and `data:` has not forbidden retention.
 */
function serviceWorkerImport(bytes, state) {
	return measure('service-worker-same-origin-import', async () => {
		if (!('serviceWorker' in navigator)) return {ok: false, error: {arrival: 'unsupported', message: 'no navigator.serviceWorker'}};
		let registration;
		try {
			registration = await navigator.serviceWorker.register('/sw.js');
		} catch (error) {
			return {ok: false, error: describeError(error, 'rejected-promise'), stage: 'register'};
		}
		state.registration = registration;
		await navigator.serviceWorker.ready;

		const controller = await new Promise((resolve) => {
			if (navigator.serviceWorker.controller) return resolve(navigator.serviceWorker.controller);
			const done = setTimeout(() => resolve(navigator.serviceWorker.controller), 4000);
			navigator.serviceWorker.addEventListener('controllerchange', () => {
				clearTimeout(done);
				resolve(navigator.serviceWorker.controller);
			});
		});
		if (!controller) {
			return {ok: false, error: {arrival: 'no-controller', message: 'the page was never claimed by the worker'}, stage: 'claim'};
		}

		const name = 'retained-' + bytes.byteLength;
		const acked = await new Promise((resolve) => {
			const channel = new MessageChannel();
			const done = setTimeout(() => resolve(false), 4000);
			channel.port1.onmessage = () => {
				clearTimeout(done);
				resolve(true);
			};
			controller.postMessage({type: 'retain', name, bytes}, [channel.port2]);
		});
		if (!acked) return {ok: false, error: {arrival: 'no-ack', message: 'the worker never acknowledged the bytes'}, stage: 'retain'};
		// Kept registered until the WORKERS below have had their turn: the fold runs in a
		// worker, so whether a worker can import the same synthesised URL is the question the
		// deployment actually asks.
		state.retainedName = name;

		try {
			const namespace = await import(`/retained/${name}.js`);
			return {ok: true, proof: proveProcessor(namespace), servedFrom: `/retained/${name}.js`};
		} catch (error) {
			return {ok: false, error: describeError(error, 'rejected-promise'), stage: 'import'};
		}
	});
}

/**
 * A same-origin worker. Its CSP comes from ITS OWN response, which is the thing most likely
 * to be got wrong by reasoning instead of measuring, so the worker's policy is a parameter
 * and both values are run.
 */
function sameOriginWorker(cspKey, retainedName) {
	return measure(`same-origin-worker[csp=${cspKey}]`, async () => {
		const retained = retainedName ? `&retained=${encodeURIComponent(retainedName)}` : '';
		let worker;
		try {
			worker = new Worker(`/worker.js?csp=${encodeURIComponent(cspKey)}${retained}`, {type: 'module'});
		} catch (error) {
			return {ok: false, error: describeError(error, 'sync-throw'), stage: 'construct'};
		}
		const outcome = await new Promise((resolve) => {
			const done = setTimeout(() => resolve({ok: false, silent: true, stage: 'no-reply'}), 20000);
			worker.onmessage = (event) => {
				clearTimeout(done);
				resolve({ok: true, inside: event.data});
			};
			worker.onerror = (event) => {
				clearTimeout(done);
				resolve({ok: false, error: {arrival: 'worker-onerror', message: event.message || '(empty)', filename: event.filename}});
			};
		});
		worker.terminate();
		return outcome;
	});
}

async function main() {
	const report = {
		href: location.href,
		userAgent: navigator.userAgent,
		document: [],
		serviceWorker: null,
		workers: [],
	};
	const artifacts = await fetchArtifacts();
	const state = {registration: null, retainedName: null};

	report.document = await runPortableMechanisms(artifacts);
	report.serviceWorker = await serviceWorkerImport(artifacts.bundle, state);

	const pagePolicy = new URLSearchParams(location.search).get('policy') || document.documentElement.dataset.policy || 'none';
	report.workers = [
		// What a static host (or an IPFS gateway) sends for a worker script: nothing.
		await sameOriginWorker('none', state.retainedName),
		// And the same worker with the page's own policy on ITS response, which is what a
		// deployment would have to arrange deliberately.
		await sameOriginWorker(pagePolicy, state.retainedName),
	];

	if (state.registration) await state.registration.unregister();
	return report;
}

main().then(
	(report) => {
		window.__spikeResults = report;
		window.__spikeDone = true;
		document.getElementById('out').textContent = JSON.stringify(report, null, 2);
	},
	(error) => {
		window.__spikeResults = {harnessFailed: describeError(error, 'harness')};
		window.__spikeDone = true;
	},
);
