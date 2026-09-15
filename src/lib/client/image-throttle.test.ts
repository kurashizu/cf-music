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
		vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock') });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
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
		const fillers = Array.from({ length: 20 }, (_, i) => throttledFetchBlobUrl(`https://example.test/filler-${i}`));
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
		vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });

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
});
