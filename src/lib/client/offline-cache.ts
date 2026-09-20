/**
 * Bridges the app to the service worker's audio cache (see
 * src/service-worker.ts): lets the UI trigger on-demand downloads for
 * offline playback, and reports how much space the browser is actually
 * using.
 */

import { analyzeTrackIfCached } from '$lib/client/silence-trim.svelte';
import {
	AUDIO_CACHE_NAME,
	COVER_CACHE_NAME,
	LIBRARY_CACHE_NAME,
	METADATA_CACHE_NAME,
	audioCacheKey,
	coverCacheKey,
	librarySnapshotKey,
	metadataCacheKey,
	routeDataKey,
	type CachedPlaylist,
	type CachedTrackMetadata,
	type LibrarySnapshot
} from '$lib/shared/audio-cache-key';

interface StreamUrlResponse {
	audioUrl: string;
	coverUrl: string | null;
}

async function postToServiceWorker(message: unknown): Promise<void> {
	const registration = await navigator.serviceWorker.ready;
	registration.active?.postMessage(message);
}

const LIST_CACHED_AUDIO_TIMEOUT_MS = 5000;
const PRECACHE_AUDIO_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Same MessageChannel-reply pattern as listCachedVideoIds, and for the
 * same reason: a bare postMessage resolves the instant the call is
 * handed off, not when the service worker's own fetch+cache.put actually
 * finishes — which made every "download for offline" caller's await
 * meaningless as a completion signal. Races against a generous timeout
 * (large files, slow connections) rather than hanging forever if the
 * service worker crashed or a deploy mid-update never replies.
 */
async function postToServiceWorkerAwaitingReply(message: unknown): Promise<boolean> {
	const registration = await navigator.serviceWorker.ready;
	if (!registration.active) return false;

	const reply = new Promise<boolean>((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = (event) => resolve(Boolean((event.data as { ok?: boolean })?.ok));
		registration.active!.postMessage(message, [channel.port2]);
	});
	const timeout = new Promise<boolean>((resolve) =>
		setTimeout(() => resolve(false), PRECACHE_AUDIO_TIMEOUT_MS)
	);

	return Promise.race([reply, timeout]);
}

/**
 * Asks the service worker (via a MessageChannel reply port, since
 * postMessage alone is fire-and-forget) which videoIds it currently has
 * audio cached for. Races the reply against a timeout — a crashed or
 * mid-update service worker that never responds would otherwise leave this
 * promise (and reconcileAudioCache's whole call) hanging forever with no
 * error and no signal that the "keep cache synced" pass silently stopped
 * running.
 */
export async function listCachedVideoIds(): Promise<string[]> {
	const registration = await navigator.serviceWorker.ready;
	if (!registration.active) return [];

	const reply = new Promise<string[]>((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = (event) => resolve(event.data.videoIds as string[]);
		registration.active!.postMessage({ type: 'LIST_CACHED_AUDIO' }, [channel.port2]);
	});
	const timeout = new Promise<string[]>((resolve) =>
		setTimeout(() => resolve([]), LIST_CACHED_AUDIO_TIMEOUT_MS)
	);

	return Promise.race([reply, timeout]);
}

/**
 * Keeps the service worker's audio cache from drifting away from account
 * storage: evicts anything cached for a song that isn't in the user's
 * library at all anymore — removed from every playlist, or evicted for
 * quota. Only "cached for a song account storage no longer has any record
 * of" is the actual leak this closes — nothing else ever clears that
 * case, since eviction/unlink only ever touches D1 and S3, never the
 * browser's own cache. Called on every storage page load; account storage
 * (the DB) is always the source of truth this reconciles *toward*, never
 * the other way around.
 */
export async function reconcileAudioCache(libraryVideoIds: string[]): Promise<void> {
	if (!('serviceWorker' in navigator)) return;

	const cachedVideoIds = await listCachedVideoIds();
	if (cachedVideoIds.length === 0) return;

	const libraryIds = new Set(libraryVideoIds);
	const toEvict = cachedVideoIds.filter((videoId) => !libraryIds.has(videoId));
	if (toEvict.length === 0) return;

	await postToServiceWorker({ type: 'EVICT_AUDIO', videoIds: toEvict });
}

/** Deletes cached audio for the given videoIds from the service worker's audio cache. */
export async function clearCachedAudio(videoIds: string[]): Promise<void> {
	if (!('serviceWorker' in navigator) || videoIds.length === 0) return;
	await postToServiceWorker({ type: 'EVICT_AUDIO', videoIds });
}

/**
 * Tells the service worker to fetch and cache one song's audio, given a
 * URL already in hand — split out from downloadSongForOffline so the
 * player's own auto-cache-on-buffer (see player.svelte.ts) can reuse this
 * without re-fetching /api/stream-url for a track it's already loaded.
 * Resolves once the download actually finishes (or fails), not just once
 * the service worker acknowledged the request.
 */
export async function precacheAudio(videoId: string, audioUrl: string): Promise<boolean> {
	if (!('serviceWorker' in navigator)) return false;
	return postToServiceWorkerAwaitingReply({ type: 'PRECACHE_AUDIO', videoId, audioUrl });
}

/**
 * Fetches a cover and stores it under its videoId, so it can be found again
 * without a presigned URL. Best-effort: a missing cover is a placeholder, not
 * a failed download.
 */
export async function cacheCover(videoId: string, coverUrl: string): Promise<void> {
	if (typeof caches === 'undefined') return;
	try {
		const cache = await caches.open(COVER_CACHE_NAME);
		if (await cache.match(coverCacheKey(videoId))) return;
		const response = await fetch(coverUrl);
		if (response.status === 200) await cache.put(coverCacheKey(videoId), response);
	} catch {
		// No cover offline; the row shows its placeholder.
	}
}

/**
 * Downloads one song into the offline cache on demand — used by explicit
 * "download" actions in the UI.
 *
 * Measures the track's silence trim points on the way out. A download is
 * exactly the moment a cache entry a measurement can read becomes available,
 * and doing it here rather than at each call site means every download path
 * behaves the same: previously only the player's own auto-cache measured
 * anything, so a song downloaded from the storage or playlist page still
 * played its leading silence the first time. Failures are swallowed — an
 * unmeasured track simply plays untrimmed, which must not make the download
 * itself report failure.
 */
export async function downloadSongForOffline(
	videoId: string,
	metadata?: Omit<CachedTrackMetadata, 'videoId'>
): Promise<boolean> {
	if (!('serviceWorker' in navigator)) return false;
	try {
		const response = await fetch(`/api/stream-url/${videoId}`);
		if (!response.ok) return false;
		const { audioUrl, coverUrl }: StreamUrlResponse = await response.json();
		const cached = await precacheAudio(videoId, audioUrl);
		if (cached) {
			if (metadata) await storeTrackMetadata([{ videoId, ...metadata }]);
			// The cover too: it is otherwise only cached as a side effect of
			// some page happening to display it, so a song downloaded and never
			// scrolled past had no art at all offline. Downloading a song
			// should bring everything needed to show it.
			if (coverUrl) await cacheCover(videoId, coverUrl);
			await analyzeTrackIfCached(videoId).catch(() => null);
		}
		return cached;
	} catch {
		return false;
	}
}

/**
 * How many downloads run at once in a batch.
 *
 * Each one now genuinely waits for the service worker to finish writing, so
 * a fully serial batch is as slow as the sum of its parts, while an unbounded
 * one opens a connection per song and starves the audio actually playing.
 */
const BATCH_DOWNLOAD_CONCURRENCY = 3;

/**
 * Downloads several songs, a few at a time, reporting each as it settles so a
 * caller can show progress. Shared by every batch "download for offline"
 * action rather than reimplemented per page.
 */
export async function downloadSongsForOffline(
	videoIds: string[],
	onEachSettled: (videoId: string, ok: boolean) => void,
	metadataFor?: (videoId: string) => Omit<CachedTrackMetadata, 'videoId'> | undefined
): Promise<void> {
	let nextIndex = 0;
	async function worker(): Promise<void> {
		while (nextIndex < videoIds.length) {
			const videoId = videoIds[nextIndex++];
			const ok = await downloadSongForOffline(videoId, metadataFor?.(videoId));
			onEachSettled(videoId, ok);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(BATCH_DOWNLOAD_CONCURRENCY, videoIds.length) }, worker)
	);
}

/**
 * Records what a cached song is called, so the offline page can list and play
 * it. The audio cache holds opaque media keyed by videoId, with nowhere to
 * put a title and nothing a reader could recognise.
 *
 * Best-effort: a track whose metadata never lands still plays offline, it
 * just shows its id, so this never fails a download.
 */
export async function storeTrackMetadata(tracks: CachedTrackMetadata[]): Promise<void> {
	if (!('serviceWorker' in navigator) || tracks.length === 0) return;
	try {
		await postToServiceWorker({ type: 'STORE_TRACK_METADATA', tracks });
	} catch {
		// Nothing to recover: the song is cached either way.
	}
}

/**
 * A playable local URL for a cached song, or null if it isn't cached.
 *
 * The cache key the service worker uses is a lookup handle it invents, not
 * something that can be fetched — so the bytes are read out and handed back
 * as a blob URL the audio element can actually load. This is what lets
 * playback work with no network at all.
 */
export async function cachedAudioUrl(videoId: string): Promise<string | null> {
	if (typeof caches === 'undefined') return null;
	try {
		const cache = await caches.open(AUDIO_CACHE_NAME);
		const hit = await cache.match(audioCacheKey(videoId));
		if (!hit) return null;
		return URL.createObjectURL(await hit.blob());
	} catch {
		return null;
	}
}

/**
 * Fills in metadata for songs cached before it was being recorded.
 *
 * Without this, a download made by an earlier version of the app lists as a
 * raw videoId offline — there is nothing in the audio cache to derive a title
 * from. Called from the pages that already hold the library, since that is
 * the only place those names exist.
 */
export async function backfillTrackMetadata(known: CachedTrackMetadata[]): Promise<void> {
	if (typeof caches === 'undefined' || known.length === 0) return;
	try {
		const [audio, meta] = await Promise.all([
			caches.open(AUDIO_CACHE_NAME),
			caches.open(METADATA_CACHE_NAME)
		]);
		const cachedIds = new Set(
			(await audio.keys()).map((request) => new URL(request.url).pathname.split('/').pop() ?? '')
		);
		const missing: CachedTrackMetadata[] = [];
		for (const track of known) {
			if (!cachedIds.has(track.videoId)) continue;
			if (await meta.match(metadataCacheKey(track.videoId))) continue;
			missing.push(track);
		}
		if (missing.length > 0) await storeTrackMetadata(missing);
	} catch {
		// Best-effort: a song without a title still plays.
	}
}

/**
 * Stores the shape of the library — the playlists and what is in them — so
 * offline keeps the same structure rather than collapsing to one flat list.
 *
 * Written whenever a page that knows the library renders, which is the only
 * place this information exists on the client.
 */
export async function storeLibrarySnapshot(playlists: CachedPlaylist[]): Promise<void> {
	if (typeof caches === 'undefined' || playlists.length === 0) return;
	try {
		const cache = await caches.open(LIBRARY_CACHE_NAME);
		const snapshot: LibrarySnapshot = { playlists, capturedAt: new Date().toISOString() };
		await cache.put(
			librarySnapshotKey(),
			new Response(JSON.stringify(snapshot), {
				headers: { 'content-type': 'application/json' }
			})
		);
	} catch {
		// Offline still works without it, just as a single list.
	}
}

/**
 * Refreshes the cached library structure from the server.
 *
 * Called from pages that are already online; failing is fine, since the last
 * good snapshot stays in place and an offline device is no worse off than
 * before.
 */
export async function syncLibrarySnapshot(): Promise<void> {
	try {
		const response = await fetch('/api/library-snapshot');
		if (!response.ok) return;
		const { playlists } = (await response.json()) as { playlists: CachedPlaylist[] };
		await storeLibrarySnapshot(playlists);
	} catch {
		// Offline already, or the request failed; keep whatever was stored.
	}
}

/**
 * Keeps a copy of a route's server data, so the page still renders offline.
 *
 * Only for pages whose data is small and tolerant of being a little stale —
 * a storage total or a play count read from the last time there was a
 * connection is far better than the page being unreachable.
 */
export async function storeRouteData(routeId: string, data: unknown): Promise<void> {
	if (typeof caches === 'undefined') return;
	try {
		const cache = await caches.open(LIBRARY_CACHE_NAME);
		await cache.put(
			routeDataKey(routeId),
			new Response(JSON.stringify({ data, capturedAt: new Date().toISOString() }), {
				headers: { 'content-type': 'application/json' }
			})
		);
	} catch {
		// The page works online regardless; this only serves the offline case.
	}
}

/** A route's last server data, with when it was captured, or null. */
export async function readRouteData<T>(
	routeId: string
): Promise<{ data: T; capturedAt: string } | null> {
	if (typeof caches === 'undefined') return null;
	try {
		const cache = await caches.open(LIBRARY_CACHE_NAME);
		const hit = await cache.match(routeDataKey(routeId));
		return hit ? ((await hit.json()) as { data: T; capturedAt: string }) : null;
	} catch {
		return null;
	}
}

/** The last library snapshot taken while online, or null if there isn't one. */
export async function readLibrarySnapshot(): Promise<LibrarySnapshot | null> {
	if (typeof caches === 'undefined') return null;
	try {
		const cache = await caches.open(LIBRARY_CACHE_NAME);
		const hit = await cache.match(librarySnapshotKey());
		return hit ? ((await hit.json()) as LibrarySnapshot) : null;
	} catch {
		return null;
	}
}

/**
 * A local URL for a cached cover, or null if there isn't one.
 *
 * Covers are cached opportunistically the first time any page shows one (see
 * service-worker.ts), keyed by videoId rather than by their presigned URL —
 * which is what makes them findable with no network, since a fresh presign
 * can't be minted offline.
 */
export async function cachedCoverUrl(videoId: string): Promise<string | null> {
	if (typeof caches === 'undefined') return null;
	try {
		const cache = await caches.open(COVER_CACHE_NAME);
		const hit = await cache.match(coverCacheKey(videoId));
		if (!hit) return null;
		return URL.createObjectURL(await hit.blob());
	} catch {
		return null;
	}
}

/** Every cached song, with whatever is known about it. For offline listing. */
export async function listCachedTracks(): Promise<CachedTrackMetadata[]> {
	if (typeof caches === 'undefined') return [];
	try {
		const [audio, meta] = await Promise.all([
			caches.open(AUDIO_CACHE_NAME),
			caches.open(METADATA_CACHE_NAME)
		]);
		const ids = (await audio.keys())
			.map((request) => new URL(request.url).pathname.split('/').pop() ?? '')
			.filter((id) => id.length > 0);

		return await Promise.all(
			ids.map(async (videoId) => {
				const hit = await meta.match(metadataCacheKey(videoId));
				// A song cached before metadata was recorded still plays; it
				// just has no title of its own to show.
				return hit
					? ((await hit.json()) as CachedTrackMetadata)
					: { videoId, title: videoId, durationSeconds: null };
			})
		);
	} catch {
		return [];
	}
}

export interface StorageEstimate {
	usageBytes: number;
	quotaBytes: number;
}

/**
 * navigator.storage.estimate() reports usage for the *entire* origin
 * (Cache API + IndexedDB + everything else), not just the audio cache —
 * there's no browser API to scope it down further, so this is the closest
 * available proxy for "how much offline audio is using".
 */
export async function estimateBrowserStorage(): Promise<StorageEstimate | null> {
	if (!('storage' in navigator) || !navigator.storage.estimate) return null;

	const estimate = await navigator.storage.estimate();
	if (estimate.usage === undefined || estimate.quota === undefined) return null;

	return { usageBytes: estimate.usage, quotaBytes: estimate.quota };
}
