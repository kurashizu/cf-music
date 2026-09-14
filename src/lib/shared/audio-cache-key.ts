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
