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

/** MinIO object keys are covers/{videoId}.{ext} — see object-key.ts for the authoritative format. */
export function extractVideoIdFromCoverPath(pathname: string): string | null {
	const match = pathname.match(/\/covers\/([^/.]+)\.[^/]+$/);
	return match ? match[1] : null;
}
