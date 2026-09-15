/**
 * Bridges the app to the service worker's audio cache (see
 * src/service-worker.ts): lets the UI trigger on-demand downloads for
 * offline playback, and reports how much space the browser is actually
 * using.
 */

interface StreamUrlResponse {
	audioUrl: string;
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

/** Downloads one song into the offline cache on demand — used by explicit "download" actions in the UI. */
export async function downloadSongForOffline(videoId: string): Promise<boolean> {
	if (!('serviceWorker' in navigator)) return false;
	try {
		const response = await fetch(`/api/stream-url/${videoId}`);
		if (!response.ok) return false;
		const { audioUrl }: StreamUrlResponse = await response.json();
		return await precacheAudio(videoId, audioUrl);
	} catch {
		return false;
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
