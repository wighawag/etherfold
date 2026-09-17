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
 *   GET /p/<policy>/            the page, carrying POLICIES[policy]
 *   GET /harness.js             the page-side runner (same-origin, so 'self' admits it)
 *   GET /worker.js?csp=<policy> the worker host, carrying POLICIES[policy] itself
 *   GET /sw.js                  a service worker that serves retained BYTES same-origin
 *   GET /artifact/bundle        the retained artifact, as opaque octets (never a script)
 *   GET /artifact/iife          the same processor as an IIFE, for the eval mechanism
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

const page = (nonce) => `<!doctype html>
<html><head><meta charset="utf-8"><title>csp spike</title></head>
<body><pre id="out">running</pre>
<script type="module" src="/harness.js" nonce="${nonce}"></script>
</body></html>`;

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
			return send(200, 'text/html; charset=utf-8', page(nonce), csp);
		}

		if (url.pathname === '/harness.js') {
			return send(200, 'text/javascript', readFileSync(join(here, 'page/harness.js')));
		}

		if (url.pathname === '/worker.js') {
			const csp = policyHeader(url.searchParams.get('csp') ?? 'none', nonce);
			if (csp === undefined) return send(404, 'text/plain', 'no such policy');
			return send(200, 'text/javascript', readFileSync(join(here, 'page/worker.js')), csp);
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

		return send(404, 'text/plain', 'not found');
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const port = Number(process.argv[2] ?? 8099);
	createSpikeServer().listen(port, () => {
		console.log(`spike server on http://localhost:${port}`);
		for (const key of Object.keys(POLICIES)) console.log(`  http://localhost:${port}/p/${key}/`);
	});
}
