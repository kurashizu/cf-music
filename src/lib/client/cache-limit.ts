import { planEviction, type EvictionCandidate } from '$lib/shared/eviction-score';
import { clearCachedAudio } from './offline-cache';

/** One cached song, as the service worker measured it. */
export interface MeasuredCacheEntry {
	videoId: string;
	sizeBytes: number;
	pinned: boolean;
}

/** Per-song play history, as the server records it. */
export interface PlayStat {
	videoId: string;
	playCount: number;
	lastPlayedAt: string | null;
}

const MEASURE_TIMEOUT_MS = 10_000;

/** Every cached song with its stored size and pinned flag. */
export async function measureCachedAudio(): Promise<MeasuredCacheEntry[]> {
	if (!('serviceWorker' in navigator)) return [];
	const registration = await navigator.serviceWorker.ready;
	if (!registration.active) return [];

	const reply = new Promise<MeasuredCacheEntry[]>((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = (event) =>
			resolve((event.data as { entries: MeasuredCacheEntry[] }).entries);
		registration.active!.postMessage({ type: 'MEASURE_CACHED_AUDIO' }, [channel.port2]);
	});
	// Same shape as the other worker round-trips: a worker that crashed or
	// is mid-update must not hang the caller forever. Reporting nothing
	// cached means no eviction runs, which is the safe direction to fail.
	const timeout = new Promise<MeasuredCacheEntry[]>((resolve) =>
		setTimeout(() => resolve([]), MEASURE_TIMEOUT_MS)
	);
	return Promise.race([reply, timeout]);
}

/**
 * Which cached songs to drop to get back under `limitBytes`.
 *
 * Pinned songs are excluded outright rather than ranked last: the user
 * downloaded those on purpose, and silently deleting one to make room for
 * a song that merely happened to play would break the one guarantee the
 * Download button makes. They still count toward the total, so the limit
 * stays a limit — it just cannot be met by evicting them. A cache made
 * entirely of pinned songs therefore stays over the limit, which is
 * correct: the alternative is deleting something the user asked to keep.
 *
 * Ranking is the same LFU-with-recency-decay used to evict from cloud
 * storage (see eviction-score.ts), fed by this user's real play history,
 * so "least worth keeping" means the same thing in both places.
 *
 * A song with no play stats sorts as never-played and goes first — which
 * is right: it reached the cache without anyone listening through it.
 */
export function planCacheEviction(
	entries: MeasuredCacheEntry[],
	stats: Map<string, PlayStat>,
	limitBytes: number,
	now = new Date()
): string[] {
	const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
	const bytesNeeded = totalBytes - limitBytes;
	if (bytesNeeded <= 0) return [];

	const candidates: EvictionCandidate[] = entries
		.filter((entry) => !entry.pinned)
		.map((entry) => {
			const stat = stats.get(entry.videoId);
			const lastPlayedAt = stat?.lastPlayedAt ? new Date(stat.lastPlayedAt) : null;
			return {
				videoId: entry.videoId,
				playCount: stat?.playCount ?? 0,
				// An unparseable timestamp is treated as never played rather
				// than as an Invalid Date, which would poison the decay maths.
				lastPlayedAt: lastPlayedAt && !Number.isNaN(lastPlayedAt.getTime()) ? lastPlayedAt : null,
				// Only used to tie-break never-played songs against each
				// other. The browser has no import date, so play recency
				// carries that job and every tie resolves the same way.
				importedAt:
					lastPlayedAt && !Number.isNaN(lastPlayedAt.getTime()) ? lastPlayedAt : new Date(0),
				fileSizeBytes: entry.sizeBytes
			};
		});

	return planEviction(candidates, bytesNeeded, { now }).toEvict.map((c) => c.videoId);
}

/**
 * Drops the least-worth-keeping auto-cached songs until the cache fits
 * `limitBytes`, and reports how many bytes that freed.
 *
 * Runs after a song is cached rather than before: the write that pushes
 * the cache over the limit is allowed to land, and the overflow is
 * reclaimed immediately afterwards. Enforcing beforehand would mean
 * predicting a size that is only known once the file has arrived.
 */
export async function enforceCacheLimit(
	limitBytes: number | null,
	fetchStats: () => Promise<PlayStat[]>
): Promise<number> {
	if (limitBytes === null) return 0;

	const entries = await measureCachedAudio();
	const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
	// Checked before asking the server for anything: the common case is a
	// cache comfortably under its limit, and that case should cost one
	// worker round-trip and no network at all.
	if (totalBytes <= limitBytes) return 0;

	const stats = await fetchStats();
	// No history means every song ranks as never-played, and eviction would
	// come down to whatever order the cache happened to enumerate. That is
	// a bad reason to delete someone's offline audio, so a failed or empty
	// stats fetch skips this round entirely — the cache stays over its
	// limit until the next play, when the figures are available again.
	if (stats.length === 0) return 0;

	const byId = new Map(stats.map((s) => [s.videoId, s]));
	const toEvict = planCacheEviction(entries, byId, limitBytes);
	if (toEvict.length === 0) return 0;

	await clearCachedAudio(toEvict);
	const evictedBytes = entries
		.filter((e) => toEvict.includes(e.videoId))
		.reduce((sum, e) => sum + e.sizeBytes, 0);
	return evictedBytes;
}
