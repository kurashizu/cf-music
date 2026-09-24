/**
 * Every page renders in the browser; the Worker only ever answers data.
 *
 * On the free plan a Worker gets 10ms of CPU per request, and this app's
 * traffic is light enough that most requests land on a fresh isolate. Server
 * rendering there — compiling and running the component tree, plus the
 * Tailwind class merging behind every Button — cost several times that
 * budget on its own, to produce markup the browser could build for free.
 *
 * With rendering off, a page is the same empty shell whatever the route, so
 * the adapter writes one out as index.html and wrangler.jsonc has the asset
 * server hand it out for every navigation without waking the Worker. The
 * router then asks for the route's __data.json, which still runs the
 * +page.server.ts / +layout.server.ts loads — session checks and redirects
 * included — just without rendering anything.
 */
export const ssr = false;
