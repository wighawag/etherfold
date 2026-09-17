/**
 * The worker half of the measurement, served CONCATENATED behind `mechanisms.js`.
 *
 * It fetches the retained bytes itself and runs every portable mechanism in the WORKER's
 * own realm, under whatever policy the server put on THIS response -- which is the point:
 * a browser indexer folds in a worker (ADR-0082), so "can a tab instantiate bytes" is
 * really "can the worker the tab hosts do it", and the two contexts can have different
 * answers.
 */

async function runInsideWorker() {
	const [bundle, iife, corrupt] = await Promise.all([
		fetch('/artifact/bundle').then((r) => r.arrayBuffer()),
		fetch('/artifact/iife').then((r) => r.arrayBuffer()),
		fetch('/artifact/corrupt').then((r) => r.arrayBuffer()),
	]);
	const results = await runPortableMechanisms({bundle, iife, corrupt});

	// The deployment shape, not a curiosity: the page's service worker is already holding
	// the retained bytes, and a dedicated worker created by a controlled page is controlled
	// too, so this asks whether the FOLD's own realm can import the synthesised URL.
	const retained = new URLSearchParams(self.location.search).get('retained');
	if (retained) {
		results.push(
			await measure('service-worker-same-origin-import', async () => {
				try {
					const namespace = await import(`/retained/${retained}.js`);
					return {ok: true, proof: proveProcessor(namespace)};
				} catch (error) {
					return {ok: false, error: describeError(error, 'rejected-promise')};
				}
			}),
		);
	}
	return results;
}

runInsideWorker().then(
	(results) => self.postMessage({results}),
	(error) => self.postMessage({workerFailed: describeError(error, 'worker')}),
);
