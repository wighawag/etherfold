/**
 * The whole point of the spike: a server that ACTUALLY SETS the header.
 *
 * A bundler dev server sends no Content-Security-Policy at all, so a spike run under
 * `vite dev` reports success and means nothing. Every page here is served with a real
 * `Content-Security-Policy` response header, chosen by the URL path, and every worker
 * script is served with its own (separately chosen) header, because a worker's policy
 * comes from ITS OWN response and not from the document that created it -- which is a
 * measurement this spike makes rather than an assumption it rests on.
 *
 *   GET /p/<policy>/            the page, carrying POLICIES[policy] as a HEADER
 *   GET /m/<policy>/            the same page, carrying it as a <meta http-equiv> instead,
 *                               which is the only instrument an IPFS-delivered app has
 *   GET /harness.js             the page-side runner (same-origin, so 'self' admits it)
 *   GET /worker.js?csp=<policy> the worker host, carrying POLICIES[policy] itself
 *   GET /sw.js                  a service worker that serves retained BYTES same-origin
 *   GET /artifact/bundle        the retained artifact, as opaque octets (never a script)
 *   GET /artifact/iife          the same processor as an IIFE, for the eval mechanism
 *   GET /artifact/corrupt       the same bundle TRUNCATED, the control that says whether a
 *                               refusal is distinguishable from a damaged artifact
 */
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `{NONCE}` is substituted per response; a policy containing it also puts that nonce on
 * the page's own script tag, which is what a real nonce deployment does.
 *
 * `pinata-gateway` is not invented: it is the header `gateway.pinata.cloud` actually
 * returned on 2026-09-17, recorded here verbatim so the matrix contains one policy no
 * app chose for itself.
 */
export const POLICIES = {
	none: null,
	'default-self': "default-src 'self'",
	'script-self': "script-src 'self'",
	'script-self-blob': "script-src 'self' blob:",
	'script-self-data': "script-src 'self' data:",
	'script-self-unsafe-eval': "script-src 'self' 'unsafe-eval'",
	'nonce-strict-dynamic': "script-src 'nonce-{NONCE}' 'strict-dynamic'",
	'pinata-gateway': "default-src 'self'; img-src * data: blob: 'unsafe-inline'; style-src * 'unsafe-inline'",
};

const page = (nonce, policyKey, metaPolicy) => `<!doctype html>
<html data-policy="${policyKey}"><head><meta charset="utf-8"><title>csp spike</title>
${metaPolicy ? `<meta http-equiv="Content-Security-Policy" content="${metaPolicy}">` : ''}</head>
<body><pre id="out">running</pre>
<script type="module" src="/harness.js" nonce="${nonce}"></script>
</body></html>`;

/**
 * `mechanisms.js` is CONCATENATED in front of each entry rather than imported by it: a
 * policy strict enough to block the harness's own module graph would otherwise turn a
 * measurement into a timeout, and the spike would be reporting its instrument.
 */
function entryScript(name) {
	const shared = readFileSync(join(here, 'page/mechanisms.js'), 'utf8');
	return `${shared}\n${readFileSync(join(here, `page/${name}`), 'utf8')}`;
}

function policyHeader(key, nonce) {
	const raw = POLICIES[key];
	if (raw === undefined) return undefined;
	if (raw === null) return null;
	return raw.replace('{NONCE}', nonce);
}

export function createSpikeServer() {
	return createServer((req, res) => {
		const url = new URL(req.url, 'http://localhost');
		const nonce = randomBytes(16).toString('base64');
		const send = (status, type, body, csp) => {
			const headers = {'content-type': type, 'cache-control': 'no-store'};
			if (csp) headers['content-security-policy'] = csp;
			res.writeHead(status, headers);
			res.end(body);
		};

		const pageMatch = url.pathname.match(/^\/p\/([a-z0-9-]+)\/?$/);
		if (pageMatch) {
			const csp = policyHeader(pageMatch[1], nonce);
			if (csp === undefined) return send(404, 'text/plain', 'no such policy');
			return send(200, 'text/html; charset=utf-8', page(nonce, pageMatch[1], null), csp);
		}

		// The META delivery. An app on an IPFS gateway does not control a response header, so
		// the only policy it can impose on itself is this one; whether it binds the same way
		// is a measurement rather than an assumption.
		const metaMatch = url.pathname.match(/^\/m\/([a-z0-9-]+)\/?$/);
		if (metaMatch) {
			const csp = policyHeader(metaMatch[1], nonce);
			if (csp === undefined) return send(404, 'text/plain', 'no such policy');
			return send(200, 'text/html; charset=utf-8', page(nonce, metaMatch[1], csp), null);
		}

		if (url.pathname === '/harness.js') {
			return send(200, 'text/javascript', entryScript('harness.js'));
		}

		if (url.pathname === '/worker.js') {
			const csp = policyHeader(url.searchParams.get('csp') ?? 'none', nonce);
			if (csp === undefined) return send(404, 'text/plain', 'no such policy');
			return send(200, 'text/javascript', entryScript('worker.js'), csp);
		}

		if (url.pathname === '/sw.js') {
			return send(200, 'text/javascript', readFileSync(join(here, 'page/sw.js')));
		}

		// The retained bytes arrive as DATA. Serving them as `text/javascript` at a
		// same-origin URL would be a different (and much easier) question than the one
		// retention poses, so they are octets and the page has to turn them into code.
		if (url.pathname === '/artifact/bundle') {
			return send(200, 'application/octet-stream', readFileSync(join(here, 'fixture/processor.bundle.js')));
		}
		if (url.pathname === '/artifact/iife') {
			return send(200, 'application/octet-stream', readFileSync(join(here, 'fixture/processor.iife.js')));
		}
		// A CORRUPT artifact, produced by cutting the real bundle off mid-token -- which is
		// what a partially written retained artifact would be. It is the control for the one
		// question an app has to answer at runtime: was I refused, or are my bytes damaged?
		if (url.pathname === '/artifact/corrupt') {
			const whole = readFileSync(join(here, 'fixture/processor.bundle.js'));
			return send(200, 'application/octet-stream', whole.subarray(0, 40));
		}

		return send(404, 'text/plain', 'not found');
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const port = Number(process.argv[2] ?? 8099);
	createSpikeServer().listen(port, () => {
		console.log(`spike server on http://localhost:${port}`);
		for (const key of Object.keys(POLICIES)) {
			console.log(`  header: http://localhost:${port}/p/${key}/    meta: http://localhost:${port}/m/${key}/`);
		}
	});
}
