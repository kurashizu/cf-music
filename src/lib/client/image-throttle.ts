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
 */

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
 * Fetches url through the shared per-second throttle and resolves to a
 * local blob URL. Callers own the returned URL and must revoke it (e.g. on
 * component unmount) once it's no longer displayed.
 */
export async function throttledFetchBlobUrl(url: string): Promise<string> {
	await acquireSlot();
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
	const blob = await response.blob();
	return URL.createObjectURL(blob);
}

/** Test-only: clears the module-singleton scheduler state between tests. */
export function _resetThrottleForTests(): void {
	startTimestamps.length = 0;
	queue.length = 0;
	drainScheduled = false;
}
