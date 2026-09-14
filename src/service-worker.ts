/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// SvelteKit's virtual module: `build` is every JS/CSS asset the current
// deploy produced, `files` is everything under static/, `version` changes
// on every deploy. Precaching these is what makes the app shell itself
// (not song audio — see below) available offline.
import { build, files, version } from '$service-worker';
import { audioCacheKey, extractVideoIdFromAudioPath } from '$lib/shared/audio-cache-key';

const sw = self as unknown as ServiceWorkerGlobalScope;

const APP_CACHE = `app-${version}`;
const AUDIO_CACHE = 'audio-v1';

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(APP_CACHE);
			await cache.addAll([...build, ...files]);
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			// Drop every cache from a previous deploy except the audio one —
			// that's keyed by videoId, not by deploy version, and clearing it
			// on every deploy would defeat the entire point of pinning songs
			// for offline use.
			for (const key of await caches.keys()) {
				if (key !== APP_CACHE && key !== AUDIO_CACHE) {
					await caches.delete(key);
				}
			}
		})()
	);
});

sw.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	const videoId = extractVideoIdFromAudioPath(url.pathname);

	// Anything that isn't a song audio request (the app shell, API calls)
	// goes straight through untouched — no cache-first behavior for those,
	// since a stale API response or a stale app shell asset is far worse
	// than a network request that could have been avoided.
	if (!videoId) return;

	event.respondWith(
		(async () => {
			const cache = await caches.open(AUDIO_CACHE);
			const cacheKey = audioCacheKey(videoId);
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
 * Explicitly warms the audio cache for a song — used to pre-fetch pinned
 * songs (see cache-preferences.ts) rather than waiting for the user to
 * actually play one before it's available offline. Takes the real
 * (presigned) URL to fetch from, since the service worker itself has no
 * way to mint one — that's a signed, authenticated call only the page
 * (which has the user's session) can make.
 */
sw.addEventListener('message', (event) => {
	if (event.data?.type !== 'PRECACHE_AUDIO') return;
	const { videoId, audioUrl } = event.data as { videoId: string; audioUrl: string };

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
});
