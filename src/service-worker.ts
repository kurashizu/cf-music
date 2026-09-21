/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// SvelteKit's virtual module: `build` is every JS/CSS asset the current
// deploy produced, `files` is everything under static/, `version` changes
// on every deploy. Precaching these is what makes the app shell itself
// (not song audio — see below) available offline.
import { build, files, prerendered, version } from '$service-worker';
import {
	audioCacheKey,
	extractVideoIdFromAudioPath,
	coverCacheKey,
	extractVideoIdFromCoverPath,
	AUDIO_CACHE_NAME,
	COVER_CACHE_NAME,
	METADATA_CACHE_NAME,
	LIBRARY_CACHE_NAME,
	metadataCacheKey
} from '$lib/shared/audio-cache-key';
import { sliceRangeFromCachedResponse } from '$lib/shared/range-slice';

const sw = self as unknown as ServiceWorkerGlobalScope;

const APP_CACHE = `app-${version}`;
const AUDIO_CACHE = AUDIO_CACHE_NAME;
// Separate from AUDIO_CACHE: covers are small and every song has one, so
// there's no reason to gate them behind the same explicit pin/download
// flow audio uses — they're cached opportunistically, cache-first, the
// first time any page happens to request one.
const COVER_CACHE = COVER_CACHE_NAME;
const METADATA_CACHE = METADATA_CACHE_NAME;
const LIBRARY_CACHE = LIBRARY_CACHE_NAME;
/** Last good __data.json per route, so client navigation survives offline. */
const ROUTE_DATA_CACHE = 'route-data-v1';
/**
 * Last good HTML for routes that work without a connection.
 *
 * These can't be precached at install time the way /offline is — they
 * render against the user's session, so there is no build-time copy to
 * ship. But once the user has opened one while online, its shell is worth
 * keeping: the page's own content is device-local, so replaying that HTML
 * offline gives back a fully working page rather than the offline
 * fallback.
 */
const PAGE_SHELL_CACHE = 'page-shell-v1';

/**
 * Routes whose shell is kept for offline use, per PAGE_SHELL_CACHE.
 *
 * Settings qualifies because nearly all of it is device-local — skip
 * silence, clearing downloads, what this browser has cached — and it
 * degrades gracefully on the one figure that isn't (see
 * loadAccountUsage). Import and Stats deliberately do not: both are
 * meaningless without the server, and the offline page already drops them
 * from navigation.
 */
const OFFLINE_CAPABLE_ROUTES = new Set(['/settings']);

/**
 * The page served for any navigation the network can't answer.
 *
 * A prerendered route (see routes/offline), so it ships as static HTML with
 * the build and needs no server — while still being the real app: it hydrates
 * the same components the online library uses, and reads the audio cache
 * instead of the server. Every other route renders against the user's session
 * and so cannot be precached at all.
 */
const OFFLINE_PAGE = '/offline';

/**
 * Paths this deploy precached, as a set so the fetch handler can decide
 * whether a request is one of them without opening the cache.
 */
const PRECACHED_PATHS = new Set([...build, ...files, ...prerendered]);

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(APP_CACHE);
			// `prerendered` matters as much as the other two: the offline page
			// is a prerendered route, and `files` covers only static/, so
			// without it the one page this worker exists to serve would not be
			// cached at all.
			await cache.addAll([...build, ...files, ...prerendered]);
			// Without this, a new service worker sits in "waiting" until every
			// tab running the old one closes — so a deploy's old APP_CACHE
			// (and the old JS chunk hashes its HTML still references) stays
			// live indefinitely across repeated deploys in one browsing
			// session, and a client can end up requesting an old entry chunk
			// that the new deploy's static assets no longer have at that
			// hash at all (a real incident: `Failed to fetch dynamically
			// imported module`). skipWaiting activates immediately instead.
			await sw.skipWaiting();
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			// Drop every cache from a previous deploy except audio/covers —
			// those are keyed by videoId, not by deploy version, and clearing
			// them on every deploy would defeat the point of caching them at
			// all.
			// Everything keyed by content rather than by deploy: audio, covers,
			// their metadata and the library's shape all survive a deploy,
			// because clearing them would throw away the user's downloads. Only
			// a previous deploy's APP_CACHE is dropped.
			//
			// Listed in one place deliberately: a cache missing from here is
			// silently deleted on the next deploy, which is how the library
			// snapshot vanished the first time.
			const KEEP = new Set([
				APP_CACHE,
				AUDIO_CACHE,
				COVER_CACHE,
				METADATA_CACHE,
				LIBRARY_CACHE,
				ROUTE_DATA_CACHE,
				PAGE_SHELL_CACHE
			]);
			for (const key of await caches.keys()) {
				if (!KEEP.has(key)) await caches.delete(key);
			}
			// Pairs with skipWaiting above: takes control of already-open
			// tabs immediately rather than only ones opened after this
			// activation, so they stop requesting old-deploy asset URLs too.
			await sw.clients.claim();
		})()
	);
});

sw.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	const audioVideoId = extractVideoIdFromAudioPath(url.pathname);
	const coverVideoId = audioVideoId ? null : extractVideoIdFromCoverPath(url.pathname);

	if (!audioVideoId && !coverVideoId) {
		// A navigation the network can't answer gets the offline page rather
		// than the browser's own error screen — that error screen was why an
		// installed app with songs already downloaded opened to nothing at
		// all once the connection dropped.
		if (event.request.mode === 'navigate') {
			event.respondWith(
				(async () => {
					try {
						const response = await fetch(event.request);
						// Keep the shell of a route that works offline, so a cold
						// start with no connection can open the real page instead
						// of the offline fallback. Only on a clean 200: an error
						// page or a redirect to the login screen is not a shell
						// worth replaying later.
						if (OFFLINE_CAPABLE_ROUTES.has(url.pathname) && response.status === 200) {
							const copy = response.clone();
							event.waitUntil(
								caches.open(PAGE_SHELL_CACHE).then((cache) => cache.put(url.pathname, copy))
							);
						}
						return response;
					} catch {
						// A route that works without the server gets its own last
						// good shell back, rather than the offline page — settings
						// is almost entirely device-local, so showing the fallback
						// instead would hide a page that genuinely works.
						const shellCache = await caches.open(PAGE_SHELL_CACHE);
						const shell = await shellCache.match(url.pathname);
						if (shell) {
							return new Response(await shell.blob(), {
								status: 200,
								headers: { 'content-type': 'text/html; charset=utf-8' }
							});
						}

						const cache = await caches.open(APP_CACHE);
						// A route this deploy precached is served as itself:
						// /settings works with no connection (its cloud figures
						// are fetched separately), so sending it to the offline
						// page would hide a page that does work.
						const own = PRECACHED_PATHS.has(url.pathname)
							? await cache.match(url.pathname)
							: undefined;
						const offline = own ?? (await cache.match(OFFLINE_PAGE));
						if (!offline) {
							return new Response('Offline', {
								status: 503,
								headers: { 'content-type': 'text/plain' }
							});
						}
						// Rebuilt rather than returned as-is: a cached entry can
						// carry a redirect flag (the host rewrites prerendered
						// paths), and returning a redirected response from a
						// navigation throws ("Failed to convert value to
						// 'Response'") — the browser then shows its own error
						// page, which is the whole thing this avoids. Copying the
						// body into a fresh Response drops the flag.
						return new Response(await offline.blob(), {
							status: 200,
							headers: { 'content-type': 'text/html; charset=utf-8' }
						});
					}
				})()
			);
			return;
		}

		// SvelteKit asks for a route's data as __data.json on every
		// client-side navigation. Offline that fetch throws, and the router
		// reports it as a server error — so the last successful copy is kept
		// and replayed, which is what lets a page whose own content is
		// device-local (see settings) still open with no connection. Only
		// ever a fallback: a reachable server always wins.
		if (url.origin === sw.location.origin && url.pathname.endsWith('__data.json')) {
			event.respondWith(
				(async () => {
					const cache = await caches.open(ROUTE_DATA_CACHE);
					try {
						const response = await fetch(event.request);
						if (response.status === 200) await cache.put(url.pathname, response.clone());
						return response;
					} catch {
						const hit = await cache.match(url.pathname);
						if (hit) return hit;
						throw new Error(`Offline and no cached data for ${url.pathname}`);
					}
				})()
			);
			return;
		}

		// Anything this deploy precached (build assets and static files) is
		// served from that cache when the network is gone. Build assets are
		// content-hashed so a cached one can never be stale, and the static
		// files are this deploy's own. Everything else — API calls above all
		// — still goes straight to the network, where a stale answer would be
		// worse than an error.
		if (url.origin === sw.location.origin && PRECACHED_PATHS.has(url.pathname)) {
			event.respondWith(
				(async () => {
					try {
						return await fetch(event.request);
					} catch {
						const cache = await caches.open(APP_CACHE);
						const hit = await cache.match(event.request);
						if (hit) return hit;
						throw new Error(`Offline and not cached: ${url.pathname}`);
					}
				})()
			);
		}
		return;
	}

	const cacheName = audioVideoId ? AUDIO_CACHE : COVER_CACHE;
	const cacheKey = audioVideoId ? audioCacheKey(audioVideoId) : coverCacheKey(coverVideoId!);
	const rangeHeader = event.request.headers.get('range');

	event.respondWith(
		(async () => {
			const cache = await caches.open(cacheName);
			const cached = await cache.match(cacheKey);

			// A browser playing/seeking an <audio> element sends real Range
			// requests (Range: bytes=...), not just full-file GETs — every
			// playback triggers at least one. A cached entry is always the
			// FULL file (see below — only ever written from a non-Range
			// fetch), so a Range request against one is answered by slicing
			// the requested bytes out of it locally, rather than either
			// ignoring the cache (the old behavior — meant every playback of
			// an already-cached song still hit the network) or handing back
			// the full cached response as if it were the requested range
			// (wrong Content-Range, and the browser would just re-request).
			if (cached && rangeHeader) {
				const sliced = await sliceRangeFromCachedResponse(cached.clone(), rangeHeader);
				if (sliced) return sliced;
				// Range unparseable/unsatisfiable against this entry — fall
				// through to a real fetch rather than serve something wrong.
			} else if (cached) {
				return cached;
			}

			const response = await fetch(event.request);
			// Only a real, complete (status 200) response is worth
			// keeping — a presigned URL failing (expired, network error)
			// shouldn't cache a broken entry that would then be served
			// instead of a working retry. Status 206 (Partial Content)
			// also satisfies response.ok, but the Cache API flatly
			// refuses to store partial responses (cache.put throws
			// "Partial response (status code 206) is unsupported"), so a
			// Range request's own response (206) is never a candidate for
			// caching here regardless — only ever a plain full-file fetch
			// (no Range header, this handler's non-Range path, or the
			// PRECACHE_AUDIO message handler below) populates the cache.
			if (response.status === 200) {
				await cache.put(cacheKey, response.clone());
			}
			return response;
		})()
	);
});

/**
 * Explicitly warms the audio cache for a song — used by the app's
 * "download for offline" actions rather than waiting for the user to
 * actually play one before it's available offline. Takes the real
 * (presigned) URL to fetch from, since the service worker itself has no
 * way to mint one — that's a signed, authenticated call only the page
 * (which has the user's session) can make.
 *
 * Replies on the caller's MessageChannel port once the fetch actually
 * settles (not just once the message was received) — without that, the
 * page side has no real completion signal at all, only "the postMessage
 * call itself returned," which happens essentially instantly regardless
 * of how long the underlying download takes. That made every "download
 * for offline" progress indicator in the UI fake: it cleared the instant
 * the request was handed off, not when the file was actually cached.
 */
sw.addEventListener('message', (event) => {
	const data = event.data as { type: string; [key: string]: unknown };

	// Written whenever a track is cached, so the offline page can list and
	// play it: the audio cache holds opaque media with nowhere to put a
	// title, and a videoId is not something a reader can be shown.
	if (data?.type === 'STORE_TRACK_METADATA') {
		const { tracks } = data as { tracks: unknown[] };
		event.waitUntil(
			(async () => {
				const cache = await caches.open(METADATA_CACHE);
				for (const track of tracks) {
					const { videoId } = track as { videoId?: string };
					if (!videoId) continue;
					await cache.put(
						metadataCacheKey(videoId),
						new Response(JSON.stringify(track), {
							headers: { 'content-type': 'application/json' }
						})
					);
				}
			})()
		);
		return;
	}

	if (data?.type === 'LIST_CACHED_TRACKS') {
		const port = event.ports[0];
		event.waitUntil(
			(async () => {
				const [audio, meta] = await Promise.all([
					caches.open(AUDIO_CACHE),
					caches.open(METADATA_CACHE)
				]);
				const cachedIds = (await audio.keys()).map(
					(request) => new URL(request.url).pathname.split('/').pop() ?? ''
				);
				const tracks = [];
				for (const videoId of cachedIds) {
					if (!videoId) continue;
					const hit = await meta.match(metadataCacheKey(videoId));
					// A track cached before metadata was recorded still plays;
					// it just has no title to show, so the id stands in.
					tracks.push(hit ? await hit.json() : { videoId, title: videoId, durationSeconds: null });
				}
				port?.postMessage({ tracks });
			})()
		);
		return;
	}

	if (data?.type === 'PRECACHE_AUDIO') {
		const { videoId, audioUrl } = data as { videoId: string; audioUrl: string };
		const port = event.ports[0];
		event.waitUntil(
			(async () => {
				try {
					const cache = await caches.open(AUDIO_CACHE);
					const cacheKey = audioCacheKey(videoId);
					if (await cache.match(cacheKey)) {
						port?.postMessage({ ok: true });
						return;
					}

					// Plain fetch(url) with no request options — the browser has
					// no reason to attach a Range header on its own here, but
					// pin to exactly 200 rather than response.ok anyway (see the
					// 'fetch' handler above for why 206 can't go through
					// cache.put at all).
					const response = await fetch(audioUrl);
					if (response.status === 200) {
						await cache.put(cacheKey, response);
						port?.postMessage({ ok: true });
					} else {
						port?.postMessage({ ok: false });
					}
				} catch {
					port?.postMessage({ ok: false });
				}
			})()
		);
		return;
	}

	// Reconciliation with account storage (see settings/storage/+page.svelte):
	// the page knows the user's actual library, the service worker only
	// knows what videoIds it happens to have cached — neither side alone
	// can tell a stale entry (song removed from every playlist, or
	// evicted) from a still-valid one.
	if (data?.type === 'LIST_CACHED_AUDIO') {
		const port = event.ports[0];
		event.waitUntil(
			(async () => {
				const cache = await caches.open(AUDIO_CACHE);
				const keys = await cache.keys();
				// audioCacheKey's URLs have no file extension (they're only ever
				// used as a lookup key, never fetched - see its own comment), so
				// the videoId is just the last path segment, not something
				// extractVideoIdFromAudioPath (which expects a real .ext suffix)
				// can parse.
				const videoIds = keys.map(
					(request) => new URL(request.url).pathname.split('/').pop() ?? ''
				);
				port?.postMessage({ videoIds: videoIds.filter((id) => id.length > 0) });
			})()
		);
		return;
	}

	if (data?.type === 'EVICT_AUDIO') {
		const { videoIds } = data as { videoIds: string[] };
		event.waitUntil(
			(async () => {
				const [cache, meta, covers] = await Promise.all([
					caches.open(AUDIO_CACHE),
					caches.open(METADATA_CACHE),
					caches.open(COVER_CACHE)
				]);
				for (const videoId of videoIds) {
					await cache.delete(audioCacheKey(videoId));
					// Kept in step with the audio: metadata for a track that is
					// no longer cached would list something unplayable offline.
					await meta.delete(metadataCacheKey(videoId));
					// The cover too. Without this, evicting a song left its art
					// behind forever — small individually, but never reclaimed
					// by anything, since covers are only ever written.
					await covers.delete(coverCacheKey(videoId));
				}
			})()
		);
		return;
	}

	/**
	 * Every cached song with the size of its stored audio and whether it
	 * was pinned — what the cache limit needs to decide what to drop.
	 *
	 * Sizes are read here rather than estimated on the page, because only
	 * the worker can open the cache, and a Response's own body length is
	 * the real number of bytes stored. Reading each body is why this isn't
	 * folded into LIST_CACHED_AUDIO, which runs on every storage page load
	 * and needs to stay cheap.
	 */
	if (data?.type === 'MEASURE_CACHED_AUDIO') {
		const port = event.ports[0];
		event.waitUntil(
			(async () => {
				const [cache, meta] = await Promise.all([
					caches.open(AUDIO_CACHE),
					caches.open(METADATA_CACHE)
				]);
				const entries: { videoId: string; sizeBytes: number; pinned: boolean }[] = [];
				for (const request of await cache.keys()) {
					const videoId = new URL(request.url).pathname.split('/').pop() ?? '';
					if (!videoId) continue;
					const response = await cache.match(request);
					if (!response) continue;
					const sizeBytes = (await response.blob()).size;
					const metaResponse = await meta.match(metadataCacheKey(videoId));
					const record = metaResponse
						? ((await metaResponse.json().catch(() => null)) as { pinned?: boolean } | null)
						: null;
					entries.push({ videoId, sizeBytes, pinned: record?.pinned === true });
				}
				port?.postMessage({ entries });
			})()
		);
	}
});
