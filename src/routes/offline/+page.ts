/**
 * Prerendered, and deliberately outside (app): that layout's load requires a
 * session from the server, which is exactly what is unavailable offline. This
 * route ships as static HTML with the build, so the service worker can serve
 * it when no request can reach the server, and the real components then
 * hydrate and read the cache.
 */
export const prerender = true;
export const ssr = true;
