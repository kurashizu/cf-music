import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	reconcileAudioCache,
	downloadSongForOffline,
	estimateBrowserStorage
} from './offline-cache';

/**
 * Minimal fake of the one thing these functions actually touch on
 * `navigator.serviceWorker`: `.ready` resolving to a registration with an
 * `.active` worker whose `postMessage` either replies over the given
 * MessageChannel port (for LIST_CACHED_AUDIO/PRECACHE_AUDIO) or just
 * records what was sent (for EVICT_AUDIO, which is fire-and-forget by
 * design) — real MessageChannel/MessagePort are available natively in
 * Node, no DOM/jsdom needed.
 */
function installFakeServiceWorker(
	options: {
		cachedVideoIds?: string[] | 'never-replies';
		precacheReply?: { ok: boolean } | 'never-replies';
	} = {}
) {
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
				if (message.type === 'PRECACHE_AUDIO' && transfer) {
					const port = transfer[0];
					if (options.precacheReply !== 'never-replies') {
						port.postMessage(options.precacheReply ?? { ok: true });
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

describe('downloadSongForOffline', () => {
	it('returns false when serviceWorker is not supported', async () => {
		vi.stubGlobal('navigator', {});
		expect(await downloadSongForOffline('a')).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('fetches a stream URL and forwards PRECACHE_AUDIO, returning true on success', async () => {
		const { sentMessages } = installFakeServiceWorker();
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			json: async () => ({ audioUrl: 'https://signed.example/a' })
		} as Response);

		expect(await downloadSongForOffline('a')).toBe(true);

		expect(fetch).toHaveBeenCalledWith('/api/stream-url/a');
		expect(sentMessages).toEqual([
			{ type: 'PRECACHE_AUDIO', videoId: 'a', audioUrl: 'https://signed.example/a' }
		]);
	});

	it('returns false when the stream-url fetch responds non-ok', async () => {
		installFakeServiceWorker();
		vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);

		expect(await downloadSongForOffline('a')).toBe(false);
	});

	it('returns false when the fetch throws', async () => {
		installFakeServiceWorker();
		vi.mocked(fetch).mockRejectedValue(new Error('network error'));

		expect(await downloadSongForOffline('a')).toBe(false);
	});

	it('returns false when the service worker reports the download itself failed', async () => {
		installFakeServiceWorker({ precacheReply: { ok: false } });
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			json: async () => ({ audioUrl: 'https://signed.example/a' })
		} as Response);

		// The stream-url fetch succeeded and the service worker was
		// reachable — only the actual audio download it attempted failed
		// (e.g. the presigned URL expired) — this is exactly the case a
		// bare "message was sent" signal couldn't distinguish from success.
		expect(await downloadSongForOffline('a')).toBe(false);
	});

	it('resolves to false rather than hanging if the service worker never replies to PRECACHE_AUDIO', async () => {
		vi.useFakeTimers();
		installFakeServiceWorker({ precacheReply: 'never-replies' });
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			json: async () => ({ audioUrl: 'https://signed.example/a' })
		} as Response);

		const pending = downloadSongForOffline('a');
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

		expect(await pending).toBe(false);
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
