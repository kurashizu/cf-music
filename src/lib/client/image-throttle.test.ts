import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { throttledFetchBlobUrl, releaseBlobUrl, _resetThrottleForTests } from './image-throttle';

describe('throttledFetchBlobUrl', () => {
	beforeEach(() => {
		_resetThrottleForTests();
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, blob: async () => new Blob() }))
		);
		// Spied, not `vi.stubGlobal('URL', { ...URL, ... })` — spreading URL's
		// own static methods onto a plain object drops its prototype chain,
		// so the result is no longer callable with `new` at all. That broke
		// `new URL(...)` everywhere else in the module under test (throws
		// "URL is not a constructor"), silently — every catch-and-fall-back
		// path in image-throttle.ts swallowed it and masked the real bug.
		vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('starts at most 20 fetches within any rolling one-second window', async () => {
		const calls = Array.from({ length: 45 }, (_, i) =>
			throttledFetchBlobUrl(`https://example.test/${i}`)
		);

		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledTimes(20);

		// The scheduler waits until strictly after the 1000ms window boundary
		// (see the `+1` in image-throttle.ts's scheduleDrain call) rather than
		// exactly at it, so advancing by exactly 1000ms must not release a
		// new slot yet.
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetch).toHaveBeenCalledTimes(20);

		await vi.advanceTimersByTimeAsync(1);
		expect(fetch).toHaveBeenCalledTimes(40);

		await vi.advanceTimersByTimeAsync(1001);
		expect(fetch).toHaveBeenCalledTimes(45);

		await Promise.all(calls);
	});

	it('queues a call made after slots are already exhausted behind the pending ones', async () => {
		const first20 = Array.from({ length: 20 }, (_, i) =>
			throttledFetchBlobUrl(`https://example.test/first-${i}`)
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledTimes(20);

		const late = throttledFetchBlobUrl('https://example.test/late');
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledTimes(20);

		await vi.advanceTimersByTimeAsync(1001);
		expect(fetch).toHaveBeenCalledTimes(21);

		await Promise.all([...first20, late]);
	});

	it('resolves to the object URL created from the fetched blob', async () => {
		const url = await throttledFetchBlobUrl('https://example.test/one');
		expect(url).toBe('blob:mock');
	});

	it('rejects when the underlying fetch is not ok, without consuming a slot forever', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, status: 429, blob: async () => new Blob() }))
		);

		await expect(throttledFetchBlobUrl('https://example.test/bad')).rejects.toThrow('429');
	});

	it('shares one fetch and blob URL across repeated calls for the same object, ignoring query string', async () => {
		const first = await throttledFetchBlobUrl('https://example.test/song.avif?sig=abc&exp=1');
		const second = await throttledFetchBlobUrl('https://example.test/song.avif?sig=xyz&exp=2');

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(first).toBe(second);
	});

	it('shares one fetch across concurrent calls for the same object made while still queued', async () => {
		// Exhaust the per-second budget first so the second call below is
		// still sitting in the queue (not yet fetched) when it's made,
		// exercising the "re-check after the throttle wait" path rather
		// than the immediate-cache-hit path the previous test covers.
		const fillers = Array.from({ length: 20 }, (_, i) =>
			throttledFetchBlobUrl(`https://example.test/filler-${i}`)
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledTimes(20);

		const a = throttledFetchBlobUrl('https://example.test/same.avif?sig=1');
		const b = throttledFetchBlobUrl('https://example.test/same.avif?sig=2');

		await vi.advanceTimersByTimeAsync(1001);
		const [urlA, urlB] = await Promise.all([a, b]);

		expect(fetch).toHaveBeenCalledTimes(21);
		expect(urlA).toBe(urlB);

		await Promise.all(fillers);
	});

	it('does not revoke the blob URL until every caller has released it', async () => {
		vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

		await throttledFetchBlobUrl('https://example.test/shared.avif?sig=1');
		await throttledFetchBlobUrl('https://example.test/shared.avif?sig=2');

		releaseBlobUrl('https://example.test/shared.avif?sig=1');
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();

		releaseBlobUrl('https://example.test/shared.avif?sig=2');
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
	});

	it('fetches again after every reference has been released', async () => {
		await throttledFetchBlobUrl('https://example.test/reused.avif?sig=1');
		releaseBlobUrl('https://example.test/reused.avif?sig=1');

		await throttledFetchBlobUrl('https://example.test/reused.avif?sig=2');
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('skips the per-second queue for covers the service worker already has cached', async () => {
		// Fillers are deliberately "not cached" (match resolves undefined for
		// them) so they go through the real acquireSlot() queue and actually
		// occupy every slot in the current window — only "cached-video"
		// resolves to a hit. If it didn't bypass the queue, it would still be
		// waiting behind these 20, and fetch would still read 20 below.
		const match = vi.fn(async (key: string) =>
			key.endsWith('/cached-video') ? new Response() : undefined
		);
		vi.stubGlobal('caches', { open: vi.fn(async () => ({ match })) });

		const fillers = Array.from({ length: 20 }, (_, i) =>
			throttledFetchBlobUrl(`https://example.test/covers/filler-${i}.avif`)
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledTimes(20);

		const pending = throttledFetchBlobUrl('https://example.test/covers/cached-video.avif?sig=abc');
		await vi.advanceTimersByTimeAsync(0);
		const url = await pending;

		expect(url).toBe('blob:mock');
		expect(fetch).toHaveBeenCalledTimes(21);
		expect(match).toHaveBeenCalledWith('https://covers.cf-music.internal/cached-video');

		await vi.advanceTimersByTimeAsync(1001);
		await Promise.all(fillers);
	});

	it('still queues a cover the service worker does not have cached', async () => {
		vi.stubGlobal('caches', { open: vi.fn(async () => ({ match: vi.fn(async () => undefined) })) });

		const fillers = Array.from({ length: 20 }, (_, i) =>
			throttledFetchBlobUrl(`https://example.test/covers/filler-${i}.avif`)
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledTimes(20);

		const late = throttledFetchBlobUrl('https://example.test/covers/not-cached.avif');
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledTimes(20);

		await vi.advanceTimersByTimeAsync(1001);
		expect(fetch).toHaveBeenCalledTimes(21);

		await Promise.all([...fillers, late]);
	});
});
