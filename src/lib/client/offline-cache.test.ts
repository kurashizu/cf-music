import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reconcileAudioCache, precachePinnedSongs, estimateBrowserStorage } from './offline-cache';

/**
 * Minimal fake of the one thing these functions actually touch on
 * `navigator.serviceWorker`: `.ready` resolving to a registration with an
 * `.active` worker whose `postMessage` either replies over the given
 * MessageChannel port (for LIST_CACHED_AUDIO) or just records what was
 * sent (for PRECACHE_AUDIO/EVICT_AUDIO) — real MessageChannel/MessagePort
 * are available natively in Node, no DOM/jsdom needed.
 */
function installFakeServiceWorker(options: { cachedVideoIds?: string[] | 'never-replies' } = {}) {
	const sentMessages: unknown[] = [];

	const registration = {
		active: {
			postMessage(message: { type: string }, transfer?: [MessagePort]) {
				sentMessages.push(message);
				if (message.type === 'LIST_CACHED_AUDIO' && transfer) {
					const port = transfer[0];
					if (options.cachedVideoIds !== 'never-replies') {
						port.postMessage({ videoIds: options.cachedVideoIds ?? [] });
					}
				}
			}
		}
	};

	vi.stubGlobal('navigator', {
		serviceWorker: { ready: Promise.resolve(registration) }
	});

	return { sentMessages };
}

beforeEach(() => {
	vi.unstubAllGlobals();
	vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('reconcileAudioCache', () => {
	it('does nothing when serviceWorker is not supported', async () => {
		vi.stubGlobal('navigator', {});
		await expect(reconcileAudioCache(['a'])).resolves.toBeUndefined();
	});

	it('does nothing when the service worker reports nothing cached', async () => {
		const { sentMessages } = installFakeServiceWorker({ cachedVideoIds: [] });
		await reconcileAudioCache(['a', 'b']);
		expect(sentMessages).toEqual([{ type: 'LIST_CACHED_AUDIO' }]);
	});

	it('does not evict anything cached for a song still in the library', async () => {
		const { sentMessages } = installFakeServiceWorker({ cachedVideoIds: ['a', 'b'] });
		await reconcileAudioCache(['a', 'b']);
		expect(sentMessages).toEqual([{ type: 'LIST_CACHED_AUDIO' }]);
	});

	it('evicts a cached videoId that is no longer in the library', async () => {
		const { sentMessages } = installFakeServiceWorker({ cachedVideoIds: ['a', 'stale'] });
		await reconcileAudioCache(['a']);
		expect(sentMessages).toEqual([
			{ type: 'LIST_CACHED_AUDIO' },
			{ type: 'EVICT_AUDIO', videoIds: ['stale'] }
		]);
	});

	it('evicts every cached videoId when the library is completely empty', async () => {
		const { sentMessages } = installFakeServiceWorker({ cachedVideoIds: ['a', 'b'] });
		await reconcileAudioCache([]);
		expect(sentMessages).toEqual([
			{ type: 'LIST_CACHED_AUDIO' },
			{ type: 'EVICT_AUDIO', videoIds: ['a', 'b'] }
		]);
	});

	it('resolves to an empty cached list (no eviction) if the service worker never replies', async () => {
		vi.useFakeTimers();
		installFakeServiceWorker({ cachedVideoIds: 'never-replies' });

		const pending = reconcileAudioCache(['a']);
		await vi.advanceTimersByTimeAsync(5000);

		await expect(pending).resolves.toBeUndefined();
	});
});

describe('precachePinnedSongs', () => {
	it('does nothing when serviceWorker is not supported', async () => {
		vi.stubGlobal('navigator', {});
		await precachePinnedSongs(['a']);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('does nothing for an empty list', async () => {
		installFakeServiceWorker();
		await precachePinnedSongs([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('fetches a stream URL and forwards PRECACHE_AUDIO for each pinned song', async () => {
		const { sentMessages } = installFakeServiceWorker();
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			json: async () => ({ audioUrl: 'https://signed.example/a' })
		} as Response);

		await precachePinnedSongs(['a']);

		expect(fetch).toHaveBeenCalledWith('/api/stream-url/a');
		expect(sentMessages).toEqual([{ type: 'PRECACHE_AUDIO', videoId: 'a', audioUrl: 'https://signed.example/a' }]);
	});

	it('skips a song whose stream-url fetch responds non-ok, without stopping the rest', async () => {
		const { sentMessages } = installFakeServiceWorker();
		vi.mocked(fetch)
			.mockResolvedValueOnce({ ok: false } as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ audioUrl: 'https://signed.example/b' })
			} as Response);

		await precachePinnedSongs(['a', 'b']);

		expect(sentMessages).toEqual([{ type: 'PRECACHE_AUDIO', videoId: 'b', audioUrl: 'https://signed.example/b' }]);
	});

	it('continues past a fetch that throws, without stopping the rest', async () => {
		const { sentMessages } = installFakeServiceWorker();
		vi.mocked(fetch)
			.mockRejectedValueOnce(new Error('network error'))
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ audioUrl: 'https://signed.example/b' })
			} as Response);

		await precachePinnedSongs(['a', 'b']);

		expect(sentMessages).toEqual([{ type: 'PRECACHE_AUDIO', videoId: 'b', audioUrl: 'https://signed.example/b' }]);
	});
});

describe('estimateBrowserStorage', () => {
	it('returns null when navigator.storage is not supported', async () => {
		vi.stubGlobal('navigator', {});
		expect(await estimateBrowserStorage()).toBeNull();
	});

	it('returns null when navigator.storage.estimate is not a function', async () => {
		vi.stubGlobal('navigator', { storage: {} });
		expect(await estimateBrowserStorage()).toBeNull();
	});

	it('returns null when the estimate omits usage or quota', async () => {
		vi.stubGlobal('navigator', { storage: { estimate: async () => ({}) } });
		expect(await estimateBrowserStorage()).toBeNull();
	});

	it('returns the usage/quota pair when both are present', async () => {
		vi.stubGlobal('navigator', {
			storage: { estimate: async () => ({ usage: 1234, quota: 999_999 }) }
		});
		expect(await estimateBrowserStorage()).toEqual({ usageBytes: 1234, quotaBytes: 999_999 });
	});
});
