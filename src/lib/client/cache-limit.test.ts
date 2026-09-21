import { describe, it, expect } from 'vitest';
import { planCacheEviction, type MeasuredCacheEntry, type PlayStat } from './cache-limit';

const NOW = new Date('2026-09-21T00:00:00Z');

function entry(videoId: string, mb: number, pinned = false): MeasuredCacheEntry {
	return { videoId, sizeBytes: mb * 1_000_000, pinned };
}

function stats(...rows: [string, number, string | null][]): Map<string, PlayStat> {
	return new Map(
		rows.map(([videoId, playCount, lastPlayedAt]) => [
			videoId,
			{ videoId, playCount, lastPlayedAt }
		])
	);
}

describe('planCacheEviction', () => {
	it('evicts nothing when the cache is under its limit', () => {
		const entries = [entry('a', 100), entry('b', 100)];
		expect(planCacheEviction(entries, stats(), 500_000_000, NOW)).toEqual([]);
	});

	it('evicts the least-played song first', () => {
		const entries = [entry('often', 100), entry('rarely', 100)];
		const played = stats(
			['often', 50, '2026-09-20T00:00:00Z'],
			['rarely', 1, '2026-09-20T00:00:00Z']
		);
		expect(planCacheEviction(entries, played, 150_000_000, NOW)).toEqual(['rarely']);
	});

	it('prefers to evict the song not played for longer, at equal play counts', () => {
		const entries = [entry('recent', 100), entry('stale', 100)];
		const played = stats(
			['recent', 10, '2026-09-20T00:00:00Z'],
			['stale', 10, '2026-01-01T00:00:00Z']
		);
		expect(planCacheEviction(entries, played, 150_000_000, NOW)).toEqual(['stale']);
	});

	it('evicts never-played songs before anything that has been played', () => {
		const entries = [entry('played-once', 100), entry('never', 100)];
		const played = stats(['played-once', 1, '2026-01-01T00:00:00Z']);
		expect(planCacheEviction(entries, played, 150_000_000, NOW)).toEqual(['never']);
	});

	it('never evicts a song the user downloaded on purpose', () => {
		// The pinned song is the obvious candidate on every other measure —
		// never played, and large enough to solve the overflow alone.
		const entries = [entry('pinned', 400, true), entry('auto', 100)];
		const played = stats(['auto', 20, '2026-09-20T00:00:00Z']);
		expect(planCacheEviction(entries, played, 300_000_000, NOW)).toEqual(['auto']);
	});

	it('leaves the cache over its limit rather than evicting pinned songs', () => {
		// Nothing here may be deleted, so the honest outcome is to delete
		// nothing — not to break the Download button's guarantee.
		const entries = [entry('p1', 300, true), entry('p2', 300, true)];
		expect(planCacheEviction(entries, stats(), 100_000_000, NOW)).toEqual([]);
	});

	it('keeps evicting until the cache actually fits', () => {
		const entries = [entry('a', 100), entry('b', 100), entry('c', 100), entry('keep', 100)];
		const played = stats(
			['a', 1, '2026-01-01T00:00:00Z'],
			['b', 2, '2026-01-01T00:00:00Z'],
			['c', 3, '2026-01-01T00:00:00Z'],
			['keep', 99, '2026-09-20T00:00:00Z']
		);
		const evicted = planCacheEviction(entries, played, 150_000_000, NOW);
		expect(evicted).toContain('a');
		expect(evicted).not.toContain('keep');
		// 400MB down to <=150MB needs at least 250MB gone: three songs.
		expect(evicted.length).toBe(3);
	});

	it('treats a song with no stats as never played rather than crashing', () => {
		const entries = [entry('unknown', 200)];
		expect(planCacheEviction(entries, stats(), 100_000_000, NOW)).toEqual(['unknown']);
	});

	it('treats an unparseable timestamp as never played', () => {
		// Invalid Date would otherwise poison the decay arithmetic and make
		// the score NaN, which sorts unpredictably.
		const entries = [entry('broken', 200), entry('fine', 200)];
		const played = stats(['broken', 5, 'not-a-date'], ['fine', 1, '2026-09-20T00:00:00Z']);
		expect(planCacheEviction(entries, played, 200_000_000, NOW)).toEqual(['broken']);
	});
});
