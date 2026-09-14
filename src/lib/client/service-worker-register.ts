/** Registers the service worker (see src/service-worker.ts) — split out from
 * the root layout so it's a plain function call there rather than inline
 * browser-API-touching code mixed into component setup. */
export function registerServiceWorker(): void {
	if (!('serviceWorker' in navigator)) return;

	navigator.serviceWorker.register('/service-worker.js', { type: 'module' }).catch((err) => {
		console.error('Service worker registration failed', err);
	});
}
