/**
 * Cross-origin isolation for a host that cannot set headers, such as GitHub
 * Pages.
 *
 * Purpose: the solver's threads need `SharedArrayBuffer`, which a browser
 * gives only to a cross-origin isolated page. This registers coi-sw.js,
 * which adds the two headers to this site's own responses, and reloads once
 * so the page comes back through it. A browser without service workers, or a
 * page already isolated, is left alone; the solver then runs on one thread.
 */
(() => {
	const KEY = 'flopsolve-coi-reload';
	const storage = {
		get() {
			try {
				return sessionStorage.getItem(KEY);
			} catch {
				return '1';
			}
		},
		set(value) {
			try {
				if (value === null) sessionStorage.removeItem(KEY);
				else sessionStorage.setItem(KEY, value);
			} catch {
				// No storage: reloading is not attempted twice anyway.
			}
		},
	};
	if (window.crossOriginIsolated) {
		storage.set(null);
		return;
	}
	if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
	const reload = () => {
		// Once per tab session, so a browser that ignores the headers cannot loop.
		if (storage.get()) return;
		storage.set('1');
		location.reload();
	};
	navigator.serviceWorker
		.register(new URL('./coi-sw.js', document.baseURI))
		.then(() => {
			if (navigator.serviceWorker.controller) reload();
			else navigator.serviceWorker.addEventListener('controllerchange', reload);
		})
		.catch(() => {});
})();
