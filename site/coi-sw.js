/**
 * Service worker for coi.js: serve this site's responses with the headers
 * that make a page cross-origin isolated. Responses from other origins pass
 * through untouched.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
	if (new URL(request.url).origin !== self.location.origin) return;
	event.respondWith(
		fetch(request).then((response) => {
			if (response.status === 0 || response.type === 'opaque') return response;
			const headers = new Headers(response.headers);
			headers.set('Cross-Origin-Opener-Policy', 'same-origin');
			headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
			headers.set('Cross-Origin-Resource-Policy', 'same-origin');
			return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
		}),
	);
});
