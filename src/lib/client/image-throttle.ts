/**
 * Caps how many cover-image fetches start per second across the whole app.
 * Loading a large playlist renders many <img>-equivalents at once (a
 * paginated page's own window, plus grid view, plus every mosaic tile on
 * the library index), and the browser fires all of their network requests
 * essentially simultaneously — that burst alone is enough to trip
 * Cloudflare's rate limiting in front of the S3 origin (seen in
 * production: dozens of concurrent cover requests on one page load, most
 * of them coming back 429). Routing every cover fetch through one shared
 * rolling-window scheduler, rather than adding `loading="lazy"` per <img>,
 * caps the burst regardless of how many covers a given view renders at
 * once (list, grid, or four-tile mosaic) or whether they're all already
 * in the viewport.
 *
 * A second, separate cache sits on top of that: the service worker caches
 * the underlying HTTP response by videoId (see service-worker.ts), but a
 * presigned cover URL's query string changes on every server render, so
 * every remount of a <ThrottledImage> for the same song — switching back
 * to a page, a component reused with a new key, etc — still re-ran
 * fetch()+blob()+createObjectURL() from scratch even when the SW served
 * the fetch itself from cache. That's a real cost (decoding, allocating a
 * fresh blob and object URL every time) for no benefit, so this module
 * also keeps its own videoId-keyed blob URL cache and hands out the same
 * object URL to every concurrent caller instead of minting a new one per
 * mount.
 *
 * That blobUrlCache above is only in-memory, though — a full page reload
 * clears it, even on a browser session where the service worker's own
 * Cache Storage entry for every cover is still there from last time and
 * would resolve near-instantly. Naively running every fetch through
 * acquireSlot() regardless punished that case for no reason: a reload of
 * a page with hundreds of covers, ALL already SW-cached, still queued
 * them 20-at-a-time exactly as if they were fresh cold fetches hitting
 * S3, even though not one of them was going to touch the network. Before
 * queuing, this checks the SW's own Cache Storage directly (a cheap,
 * synchronous-ish lookup, not a real network request) — a hit skips
 * acquireSlot() entirely, since it can't contribute to the S3 rate-limit
 * burst this throttle exists to prevent; only a genuine cache miss queues.
 */

import { coverCacheKey, extractVideoIdFromCoverPath } from '$lib/shared/audio-cache-key';

const COVER_SW_CACHE_NAME = 'cover-v1';

const blobUrlCache = new Map<string, { url: string; refCount: number }>();
// Tracks a fetch that's already been started (queued or in-flight) for a
// key, so a second call for the same key made before the first resolves
// awaits that same fetch instead of starting its own — blobUrlCache alone
// only catches callers that arrive *after* the first has already
// completed.
const inFlight = new Map<string, Promise<string>>();

const MAX_STARTS_PER_SECOND = 20;
const WINDOW_MS = 1000;

const startTimestamps: number[] = [];
const queue: Array<() => void> = [];
let drainScheduled = false;

function pruneOldTimestamps(now: number): void {
	while (startTimestamps.length > 0 && now - startTimestamps[0] >= WINDOW_MS) {
		startTimestamps.shift();
	}
}

function scheduleDrain(delayMs: number): void {
	if (drainScheduled) return;
	drainScheduled = true;
	setTimeout(() => {
		drainScheduled = false;
		drainQueue();
	}, delayMs);
}

function drainQueue(): void {
	const now = Date.now();
	pruneOldTimestamps(now);
	while (queue.length > 0 && startTimestamps.length < MAX_STARTS_PER_SECOND) {
		startTimestamps.push(now);
		queue.shift()!();
	}
	if (queue.length > 0) {
		// Next slot frees up when the window's oldest timestamp ages out.
		scheduleDrain(WINDOW_MS - (now - startTimestamps[0]) + 1);
	}
}

/** Resolves once this call is allowed to start, in FIFO order. */
function acquireSlot(): Promise<void> {
	return new Promise((resolve) => {
		queue.push(resolve);
		drainQueue();
	});
}

/**
 * The part of a presigned URL that's actually stable across re-presigns of
 * the same object — everything but the query string. Two presigned URLs
 * for the same videoId differ only in their signature/date query params,
 * so this (not the full URL) is what the blob cache keys on.
 */
function cacheKeyFor(url: string): string {
	return url.split('?')[0];
}

/**
 * True if the service worker's own Cache Storage already has this cover
 * (see coverCacheKey/service-worker.ts) — cheap, local, no network
 * involved, so checking it before acquireSlot() is essentially free
 * compared to the cost of needlessly rate-limiting an already-cached
 * fetch. Fails open (false) on anything unexpected — a mid-navigation
 * `caches` access, no service worker registered yet, etc — since a false
 * negative here just costs one queue slot, not correctness.
 */
async function isAlreadyCoverCached(url: string): Promise<boolean> {
	if (typeof caches === 'undefined') return false;
	try {
		const videoId = extractVideoIdFromCoverPath(new URL(url).pathname);
		if (!videoId) return false;
		const cache = await caches.open(COVER_SW_CACHE_NAME);
		return (await cache.match(coverCacheKey(videoId))) !== undefined;
	} catch {
		return false;
	}
}

/** Largest edge a cover is shown at (a wide-screen grid tile), doubled for 2x displays. */
const MAX_COVER_EDGE = 320;

/**
 * Shrinks a cover to roughly the size it is actually displayed at.
 *
 * The file on disk is small either way, but the browser holds the *decoded*
 * bitmap, and covers arrive at whatever the source happened to be — commonly
 * 1280x720, or ~3.7MB decoded, to fill a 156px tile. A scrolled grid keeps
 * every row it has rendered, so a hundred covers passed 300MB of bitmaps and
 * the tab was eventually discarded and reloaded, dropping the reader back at
 * the top. Downscaling once on the way in bounds that; the stored original is
 * never touched.
 *
 * Returns the original blob if any step is unsupported or fails — a
 * correctly sized cover matters less than showing one at all.
 */
async function downscaleCover(blob: Blob): Promise<Blob> {
	if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return blob;
	let bitmap: ImageBitmap | null = null;
	try {
		bitmap = await createImageBitmap(blob);
		const scale = MAX_COVER_EDGE / Math.max(bitmap.width, bitmap.height);
		if (scale >= 1) return blob;

		const width = Math.round(bitmap.width * scale);
		const height = Math.round(bitmap.height * scale);
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d');
		if (!context) return blob;
		context.drawImage(bitmap, 0, 0, width, height);
		return await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
	} catch {
		return blob;
	} finally {
		bitmap?.close();
	}
}

/**
 * Resolves to a local blob URL for `url`, through the shared per-second
 * throttle. Concurrent or repeated calls for the same underlying object
 * (recognized by ignoring the presigned query string — see cacheKeyFor)
 * share one fetch and one blob URL rather than each minting their own;
 * every resolved call increments a refcount that releaseBlobUrl decrements,
 * so the object URL is only revoked once nothing is displaying it anymore.
 */
export async function throttledFetchBlobUrl(url: string): Promise<string> {
	const key = cacheKeyFor(url);

	const cached = blobUrlCache.get(key);
	if (cached) {
		cached.refCount++;
		return cached.url;
	}

	const pending = inFlight.get(key);
	if (pending) {
		const objectUrl = await pending;
		// The in-flight fetch this awaited has already recorded its own
		// refCount: 1 in blobUrlCache by the time it resolves (see below),
		// so this caller needs its own increment on top of that.
		blobUrlCache.get(key)!.refCount++;
		return objectUrl;
	}

	const fetchPromise = (async () => {
		if (!(await isAlreadyCoverCached(url))) {
			await acquireSlot();
		}
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
		const blob = await downscaleCover(await response.blob());
		const objectUrl = URL.createObjectURL(blob);
		blobUrlCache.set(key, { url: objectUrl, refCount: 1 });
		return objectUrl;
	})();
	inFlight.set(key, fetchPromise);
	try {
		return await fetchPromise;
	} finally {
		inFlight.delete(key);
	}
}

/**
 * Releases one reference to a blob URL previously returned by
 * throttledFetchBlobUrl — revokes and evicts it once no caller holds it
 * anymore. Callers must pass the original `url` they requested (not the
 * blob URL it resolved to), since that's what the cache is keyed on.
 */
export function releaseBlobUrl(url: string): void {
	const key = cacheKeyFor(url);
	const cached = blobUrlCache.get(key);
	if (!cached) return;
	cached.refCount--;
	if (cached.refCount <= 0) {
		URL.revokeObjectURL(cached.url);
		blobUrlCache.delete(key);
	}
}

/** Test-only: clears the module-singleton scheduler and blob cache state between tests. */
export function _resetThrottleForTests(): void {
	startTimestamps.length = 0;
	queue.length = 0;
	drainScheduled = false;
	blobUrlCache.clear();
	inFlight.clear();
}
