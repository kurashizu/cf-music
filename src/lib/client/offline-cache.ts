/**
 * Bridges the app to the service worker's audio cache (see
 * src/service-worker.ts): triggers pre-caching of pinned songs so they're
 * available offline before the user ever plays them, and reports how much
 * space the browser is actually using.
 */

interface StreamUrlResponse {
	audioUrl: string;
}

async function postToServiceWorker(message: unknown): Promise<void> {
	const registration = await navigator.serviceWorker.ready;
	registration.active?.postMessage(message);
}

const LIST_CACHED_AUDIO_TIMEOUT_MS = 5000;

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
 * quota. A song still in the library but not (or no longer) pinned keeps
 * its cached bytes; that's lazy caching working as designed (play once,
 * stay available offline until something else reclaims the space), not
 * drift. Only "cached for a song account storage no longer has any record
 * of" is the actual leak this closes — nothing else ever clears that
 * case, since eviction/unlink only ever touches D1 and S3, never the
 * browser's own cache. Called on every Settings/offline-cache page load;
 * account storage (the DB) is always the source of truth this reconciles
 * *toward*, never the other way around.
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

/**
 * Pre-fetches and caches every pinned song's audio, one at a time — not
 * in parallel, since this can run on every page load and a burst of
 * concurrent large audio downloads competing with whatever the user is
 * actually doing (e.g. playing a different song right now) would be a bad
 * trade for songs that are, by definition, not urgently needed yet.
 */
export async function precachePinnedSongs(pinnedVideoIds: string[]): Promise<void> {
	if (!('serviceWorker' in navigator) || pinnedVideoIds.length === 0) return;

	for (const videoId of pinnedVideoIds) {
		try {
			const response = await fetch(`/api/stream-url/${videoId}`);
			if (!response.ok) continue;
			const { audioUrl }: StreamUrlResponse = await response.json();
			await postToServiceWorker({ type: 'PRECACHE_AUDIO', videoId, audioUrl });
		} catch {
			// Best-effort: one pinned song failing to pre-cache (network
			// hiccup, expired session mid-loop) shouldn't stop the rest from
			// being tried, and isn't worth surfacing — the song still plays
			// fine online, it just won't be available offline yet.
		}
	}
}

/**
 * Deletes cached audio for the given videoIds from the service worker's
 * audio cache, without touching pin state — a song can still be pinned
 * (or in the library) after this; it just has to be re-fetched from the
 * network next time it's played.
 */
export async function clearCachedAudio(videoIds: string[]): Promise<void> {
	if (!('serviceWorker' in navigator) || videoIds.length === 0) return;
	await postToServiceWorker({ type: 'EVICT_AUDIO', videoIds });
}

/**
 * Downloads one song into the offline cache on demand, independent of pin
 * state — used by explicit "download" actions in the UI (playlist rows,
 * batch toolbar), as opposed to precachePinnedSongs' background warm-up of
 * already-pinned songs.
 */
export async function downloadSongForOffline(videoId: string): Promise<boolean> {
	if (!('serviceWorker' in navigator)) return false;
	try {
		const response = await fetch(`/api/stream-url/${videoId}`);
		if (!response.ok) return false;
		const { audioUrl }: StreamUrlResponse = await response.json();
		await postToServiceWorker({ type: 'PRECACHE_AUDIO', videoId, audioUrl });
		return true;
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
