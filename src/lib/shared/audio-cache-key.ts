/**
 * Names of the Cache Storage buckets the service worker maintains.
 *
 * Declared here, beside the key helpers, because more than the service
 * worker reads them: analysis code opens the audio cache directly to reuse a
 * track it has already downloaded. A bucket renamed in only one of those
 * places fails silently — the reader simply finds nothing.
 */
export const AUDIO_CACHE_NAME = 'audio-v1';
export const COVER_CACHE_NAME = 'cover-v1';
/**
 * Holds one small JSON entry per cached song: the title and duration needed
 * to list and play it with no network at all.
 *
 * Kept apart from the audio itself because the audio cache stores opaque
 * media bodies — there is nowhere in them to put a title, and the videoId in
 * the key is not something a reader can be shown.
 */
export const METADATA_CACHE_NAME = 'audio-meta-v1';
/**
 * Holds the shape of the library itself — which playlists exist and which
 * songs are in each — so offline is the same app rather than one flat list.
 */
export const LIBRARY_CACHE_NAME = 'library-v1';

/**
 * Presigned S3/MinIO URLs (see /api/stream-url/[videoId]) carry a
 * signature query string that's different on every request, so the
 * request URL itself can't be a stable Cache API key — two requests for
 * the same song a minute apart would never match. This derives a stable,
 * videoId-scoped key instead, deliberately unrelated to the real
 * fetchable URL: it's only ever used as a lookup key, never actually
 * fetched. Kept as a plain string (not a Request) so it can be unit
 * tested outside the service worker's browser-only global scope.
 */
export function audioCacheKey(videoId: string): string {
	return `https://audio.cf-music.internal/${videoId}`;
}

/**
 * Whether a cached song is in a different container from the one now being
 * requested.
 *
 * The cache is keyed by videoId alone, so a song re-stored in a new
 * container (WebM moved to MP4 so Safari follows output-device changes)
 * would otherwise go on being served from its old bytes indefinitely. The
 * response remembers the URL it was fetched from, and the object key's
 * extension is the container. An entry with no URL to compare, or either
 * side without an extension, is taken as current: nothing says otherwise.
 */
export function isCachedAudioOutdated(cachedUrl: string, requestedUrl: string): boolean {
	const extension = (url: string): string | null => {
		if (!url) return null;
		return new URL(url).pathname.match(/\.([^./]+)$/)?.[1]?.toLowerCase() ?? null;
	};
	const cached = extension(cachedUrl);
	const requested = extension(requestedUrl);
	return cached !== null && requested !== null && cached !== requested;
}

/** MinIO object keys are audio/{videoId}.{ext} — see object-key.ts for the authoritative format. */
export function extractVideoIdFromAudioPath(pathname: string): string | null {
	const match = pathname.match(/\/audio\/([^/.]+)\.[^/]+$/);
	return match ? match[1] : null;
}

/**
 * Same signed-URL-instability problem as audioCacheKey, for cover images:
 * presigned cover URLs carry a signature query string that changes on
 * every page load (a fresh presign per request — see the various
 * +page.server.ts loads), so the browser's own HTTP cache can never treat
 * two loads of the same cover as the same resource, even though the
 * underlying image never changes. Deliberately a different origin than
 * audioCacheKey's so the two never collide in the same Cache API store.
 */
export function coverCacheKey(videoId: string): string {
	return `https://covers.cf-music.internal/${videoId}`;
}

/** Lookup key for one cached song's metadata. Same scheme as audioCacheKey, never fetched. */
export function metadataCacheKey(videoId: string): string {
	return `https://meta.cf-music.internal/${videoId}`;
}

/**
 * Lookup key for one route's last server payload.
 *
 * Pages whose data is small and changes slowly (settings, stats) keep a copy
 * so they still render with no connection, rather than being unreachable.
 */
export function routeDataKey(routeId: string): string {
	return `https://route.cf-music.internal/${encodeURIComponent(routeId)}`;
}

/** Lookup key for the cached library snapshot. Never fetched. */
export function librarySnapshotKey(): string {
	return 'https://library.cf-music.internal/snapshot';
}

/** One playlist as it is needed offline: its name, and the songs it holds in order. */
export interface CachedPlaylist {
	id: string;
	name: string;
	kind: string;
	videoIds: string[];
}

/** The whole library as last seen online. */
export interface LibrarySnapshot {
	playlists: CachedPlaylist[];
	/** When this was taken, so the offline view can say how fresh it is. */
	capturedAt: string;
}

/** What is known about a cached song without reaching the network. */
export interface CachedTrackMetadata {
	videoId: string;
	title: string;
	durationSeconds: number | null;
	/**
	 * The user asked for this song offline, rather than it being kept
	 * because they happened to play it through.
	 *
	 * Both paths write to the same audio cache, so without this there is no
	 * way to tell them apart — and the cache limit must not quietly delete
	 * a song someone downloaded on purpose. Absent counts as false, so
	 * anything cached before this existed is treated as auto-cached and is
	 * eligible for eviction.
	 */
	pinned?: boolean;
}

/** MinIO object keys are covers/{videoId}.{ext} — see object-key.ts for the authoritative format. */
export function extractVideoIdFromCoverPath(pathname: string): string | null {
	const match = pathname.match(/\/covers\/([^/.]+)\.[^/]+$/);
	return match ? match[1] : null;
}
