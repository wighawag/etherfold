/**
 * A service worker standing in for the thing a retention path would really have: a holder
 * of stored bytes that can answer a SAME-ORIGIN URL with them.
 *
 * It invents nothing about the policy question. `script-src 'self'` matches on the URL a
 * script is fetched from, so if a worker-synthesised response is admitted, an app whose CSP
 * forbids `blob:` and `data:` can still instantiate what it retained. If it is refused, the
 * last plausible mechanism is gone and the answer for strict policies is NO.
 *
 * The bytes arrive by `postMessage` and are held in memory, which is the spike's stand-in
 * for reading them out of IndexedDB: what is being measured is the SERVING, not the store.
 */

const retained = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
	const message = event.data;
	if (!message || message.type !== 'retain') return;
	retained.set(message.name, message.bytes);
	if (event.ports && event.ports[0]) event.ports[0].postMessage({ok: true});
});

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	const match = url.pathname.match(/^\/retained\/(.+)\.js$/);
	if (!match) return;
	const bytes = retained.get(match[1]);
	if (!bytes) return;
	event.respondWith(
		new Response(bytes, {
			status: 200,
			headers: {'content-type': 'text/javascript', 'cache-control': 'no-store'},
		}),
	);
});
