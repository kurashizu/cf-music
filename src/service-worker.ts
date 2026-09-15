/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// SvelteKit's virtual module: `build` is every JS/CSS asset the current
// deploy produced, `files` is everything under static/, `version` changes
// on every deploy. Precaching these is what makes the app shell itself
// (not song audio — see below) available offline.
import { build, files, version } from '$service-worker';
import {
	audioCacheKey,
	extractVideoIdFromAudioPath,
	coverCacheKey,
	extractVideoIdFromCoverPath
} from '$lib/shared/audio-cache-key';

const sw = self as unknown as ServiceWorkerGlobalScope;

const APP_CACHE = `app-${version}`;
const AUDIO_CACHE = 'audio-v1';
// Separate from AUDIO_CACHE: covers are small and every song has one, so
// there's no reason to gate them behind the same explicit pin/download
// flow audio uses — they're cached opportunistically, cache-first, the
// first time any page happens to request one.
const COVER_CACHE = 'cover-v1';

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(APP_CACHE);
			await cache.addAll([...build, ...files]);
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
			for (const key of await caches.keys()) {
				if (key !== APP_CACHE && key !== AUDIO_CACHE && key !== COVER_CACHE) {
					await caches.delete(key);
				}
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

	// Anything that isn't a song audio/cover request (the app shell, API
	// calls) goes straight through untouched — no cache-first behavior for
	// those, since a stale API response or a stale app shell asset is far
	// worse than a network request that could have been avoided.
	if (!audioVideoId && !coverVideoId) return;

	const cacheName = audioVideoId ? AUDIO_CACHE : COVER_CACHE;
	const cacheKey = audioVideoId ? audioCacheKey(audioVideoId) : coverCacheKey(coverVideoId!);

	event.respondWith(
		(async () => {
			const cache = await caches.open(cacheName);
			const cached = await cache.match(cacheKey);
			if (cached) return cached;

			const response = await fetch(event.request);
			// Only a real, complete response is worth keeping — a presigned
			// URL failing (expired, network error) shouldn't cache a broken
			// entry that would then be served instead of a working retry.
			if (response.ok) {
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
 */
sw.addEventListener('message', (event) => {
	const data = event.data as { type: string; [key: string]: unknown };

	if (data?.type === 'PRECACHE_AUDIO') {
		const { videoId, audioUrl } = data as { videoId: string; audioUrl: string };
		event.waitUntil(
			(async () => {
				const cache = await caches.open(AUDIO_CACHE);
				const cacheKey = audioCacheKey(videoId);
				if (await cache.match(cacheKey)) return;

				const response = await fetch(audioUrl);
				if (response.ok) {
					await cache.put(cacheKey, response);
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
				const videoIds = keys.map((request) => new URL(request.url).pathname.split('/').pop() ?? '');
				port?.postMessage({ videoIds: videoIds.filter((id) => id.length > 0) });
			})()
		);
		return;
	}

	if (data?.type === 'EVICT_AUDIO') {
		const { videoIds } = data as { videoIds: string[] };
		event.waitUntil(
			(async () => {
				const cache = await caches.open(AUDIO_CACHE);
				for (const videoId of videoIds) {
					await cache.delete(audioCacheKey(videoId));
				}
			})()
		);
	}
});
