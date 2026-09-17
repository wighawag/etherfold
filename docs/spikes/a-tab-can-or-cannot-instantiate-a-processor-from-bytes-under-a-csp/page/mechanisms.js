/**
 * The mechanisms a tab could use to turn RETAINED BYTES into a running processor, written
 * once and run in BOTH scopes that matter -- the document and a worker -- because a
 * browser indexer's fold runs in a worker (ADR-0082) and a worker's policy does not come
 * from the document that created it.
 *
 * This file carries NO `import`/`export` and is CONCATENATED by the server in front of
 * whichever entry is being served. That is deliberate: under a policy strict enough to
 * block the harness's OWN module graph, an imported helper would turn a MEASUREMENT into
 * a timeout, and we would be reporting our instrument rather than the browser.
 *
 * Every mechanism returns the same shaped record, because the finding is a MATRIX and a
 * row that means "blocked" must be distinguishable from a row that means "ran but folded
 * the wrong number".
 */

const SPIKE_STATE = {count: 41};
const SPIKE_EVENT = {name: 'Transfer'};

/** Instantiation is proved by FOLDING, never by the absence of an error. */
function proveProcessor(namespace) {
	const processor = namespace && (namespace.processor ?? namespace.default);
	if (!processor || typeof processor.handleEvent !== 'function') {
		return {ran: false, why: 'no handleEvent on the instantiated namespace'};
	}
	const folded = processor.handleEvent(SPIKE_STATE, SPIKE_EVENT);
	const ran = folded && folded.count === 42 && folded.last === 'Transfer';
	return {ran: !!ran, folded};
}

/**
 * What a failure LOOKS LIKE from inside the page is half the deliverable, so the report is
 * verbatim: the constructor, the `name`, the message, and whether it arrived as a throw or
 * as a rejection. An app that has to tell a CSP refusal from a corrupt bundle has exactly
 * this much to go on.
 */
function describeError(error, arrival) {
	if (error === null || error === undefined) return {arrival, value: String(error)};
	if (!(error instanceof Error)) {
		return {arrival, notAnError: true, type: typeof error, value: String(error)};
	}
	return {
		arrival,
		constructor: error.constructor && error.constructor.name,
		name: error.name,
		message: error.message,
	};
}

/**
 * CSP violations are recorded GLOBALLY and harvested per mechanism, because several of the
 * refusals below report nothing to the caller at all and the violation event is then the
 * only thing the page is told.
 */
const violations = [];

function recordViolation(event) {
	violations.push({
		effectiveDirective: event.effectiveDirective || event.violatedDirective,
		blockedURI: event.blockedURI,
		disposition: event.disposition,
		sourceFile: event.sourceFile,
		statusCode: event.statusCode,
	});
}

// ONE listener, deliberately: in a document the event fires at the document and bubbles to
// the window, so listening on both records every violation twice.
if (typeof document !== 'undefined') {
	document.addEventListener('securitypolicyviolation', recordViolation);
} else if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
	self.addEventListener('securitypolicyviolation', recordViolation);
}

function tick(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A violation event can land just after the rejection, so every mechanism yields once
 * before its violations are taken. 60ms is empirically enough and costs nothing.
 */
async function harvestViolations(before) {
	await tick(60);
	return violations.slice(before);
}

async function measure(mechanism, run) {
	const before = violations.length;
	let record;
	try {
		record = await run();
	} catch (error) {
		record = {ok: false, error: describeError(error, 'sync-throw')};
	}
	return {mechanism, ...record, violations: await harvestViolations(before)};
}

function toDataUrl(bytes) {
	let binary = '';
	const view = new Uint8Array(bytes);
	for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
	return 'data:text/javascript;base64,' + btoa(binary);
}

function blobUrl(bytes) {
	return URL.createObjectURL(new Blob([bytes], {type: 'text/javascript'}));
}

function decode(bytes) {
	return new TextDecoder().decode(bytes);
}

/** `import(blob:)` -- the retained bytes handed to the module loader through an object URL. */
function blobImport(bytes) {
	return measure('blob-import', async () => {
		const url = blobUrl(bytes);
		try {
			const namespace = await import(/* webpackIgnore: true */ /* @vite-ignore */ url);
			return {ok: true, proof: proveProcessor(namespace)};
		} catch (error) {
			return {ok: false, error: describeError(error, 'rejected-promise')};
		}
	});
}

/** `import(data:)` -- the same, with the bytes inline in the URL and no object URL at all. */
function dataImport(bytes) {
	return measure('data-import', async () => {
		const url = toDataUrl(bytes);
		try {
			const namespace = await import(/* webpackIgnore: true */ /* @vite-ignore */ url);
			return {ok: true, proof: proveProcessor(namespace)};
		} catch (error) {
			return {ok: false, error: describeError(error, 'rejected-promise')};
		}
	});
}

/**
 * `new Function` over the IIFE build. An ESM bundle cannot be passed to `new Function` at
 * all (a top-level `export` is a syntax error there), so testing the eval family against
 * the ESM artifact would measure the wrong refusal.
 */
function evalFunction(iifeBytes) {
	return measure('new-function', async () => {
		try {
			const factory = new Function(decode(iifeBytes) + '\nreturn __spikeProcessor;');
			return {ok: true, proof: proveProcessor(factory())};
		} catch (error) {
			return {ok: false, error: describeError(error, 'sync-throw')};
		}
	});
}

/**
 * A DEDICATED WORKER whose script IS the retained bytes: the shape a browser indexer would
 * actually want, since the fold belongs off the UI thread. The bundle is reached from the
 * worker through a second object URL, so this row measures worker CREATION from `blob:`
 * and the import inside it together -- which is honest, because a `blob:` worker INHERITS
 * the creator's policy and the two cannot be separated in a deployment either.
 */
function blobWorker(bytes) {
	return measure('blob-worker', async () => {
		const bundle = blobUrl(bytes);
		// The second import inside the shim is the INHERITANCE probe: a `blob:` worker has no
		// response of its own to carry a policy, so it is said to inherit its creator's. If
		// that is true, a page allowing `blob:` but not `data:` will see this one refused
		// INSIDE a worker it was allowed to create, and the two rows say so separately.
		const shim = `import * as m from ${JSON.stringify(bundle)};
const p = m.processor ?? m.default;
let inherited = 'allowed';
try { await import(${JSON.stringify(toDataUrl(bytes))}); } catch (e) { inherited = e.name + ': ' + e.message; }
self.postMessage({folded: p.handleEvent({count: 41}, {name: 'Transfer'}), dataImportInsideBlobWorker: inherited});`;
		let worker;
		try {
			worker = new Worker(blobUrl(shim), {type: 'module'});
		} catch (error) {
			return {ok: false, error: describeError(error, 'sync-throw')};
		}
		const outcome = await new Promise((resolve) => {
			const done = setTimeout(() => resolve({ok: false, silent: true}), 4000);
			worker.onmessage = (event) => {
				clearTimeout(done);
				resolve({
					ok: true,
					proof: {ran: event.data.folded.count === 42, folded: event.data.folded},
					dataImportInsideBlobWorker: event.data.dataImportInsideBlobWorker,
				});
			};
			worker.onerror = (event) => {
				clearTimeout(done);
				resolve({
					ok: false,
					error: {arrival: 'worker-onerror', message: event.message || '(empty)', filename: event.filename},
				});
			};
		});
		worker.terminate();
		return outcome;
	});
}

/** The whole page-or-worker matrix, minus the two mechanisms only a document can run. */
async function runPortableMechanisms(artifacts) {
	return [
		await blobImport(artifacts.bundle),
		await dataImport(artifacts.bundle),
		await evalFunction(artifacts.iife),
		await blobWorker(artifacts.bundle),
		// The CONTROL: the same mechanism on bytes that are a truncated bundle, so the
		// finding can say whether an app could tell a refusal from a corrupt artifact.
		{...(await blobImport(artifacts.corrupt)), mechanism: 'blob-import-corrupt-bytes'},
	];
}
