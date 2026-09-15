import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { throttledFetchBlobUrl, _resetThrottleForTests } from './image-throttle';

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
});
