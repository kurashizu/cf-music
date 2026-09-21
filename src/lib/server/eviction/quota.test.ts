import { describe, it, expect } from 'vitest';
import { checkQuota } from './quota';
import type { EvictionCandidate } from '../../shared/eviction-score';

const now = new Date('2026-06-01T00:00:00.000Z');

function makeCandidate(overrides: Partial<EvictionCandidate>): EvictionCandidate {
	return {
		videoId: 'default-id',
		playCount: 0,
		lastPlayedAt: null,
		importedAt: new Date('2026-01-01T00:00:00.000Z'),
		fileSizeBytes: 1_000_000,
		...overrides
	};
}

describe('checkQuota', () => {
	it('returns "fits" when the file fits within remaining free space', () => {
		const result = checkQuota({
			fileSizeBytes: 100,
			quotaBytes: 1000,
			usedBytes: 500,
			existingSongs: [],
			now
		});
		expect(result).toEqual({ outcome: 'fits', bytesAvailable: 500 });
	});

	it('returns "fits" at the exact boundary (file size equals remaining space)', () => {
		const result = checkQuota({
			fileSizeBytes: 500,
			quotaBytes: 1000,
			usedBytes: 500,
			existingSongs: [],
			now
		});
		expect(result.outcome).toBe('fits');
	});

	it('returns "exceeds_total_quota" when the file is larger than the total quota, regardless of usage', () => {
		const result = checkQuota({
			fileSizeBytes: 2000,
			quotaBytes: 1000,
			usedBytes: 0,
			existingSongs: [],
			now
		});
		expect(result).toEqual({
			outcome: 'exceeds_total_quota',
			quotaBytes: 1000,
			fileSizeBytes: 2000
		});
	});

	it('returns "exceeds_total_quota" even when file size exactly equals quota plus one byte', () => {
		const result = checkQuota({
			fileSizeBytes: 1001,
			quotaBytes: 1000,
			usedBytes: 0,
			existingSongs: [],
			now
		});
		expect(result.outcome).toBe('exceeds_total_quota');
	});

	it('does NOT flag exceeds_total_quota when file size exactly equals the quota', () => {
		const result = checkQuota({
			fileSizeBytes: 1000,
			quotaBytes: 1000,
			usedBytes: 0,
			existingSongs: [],
			now
		});
		expect(result.outcome).not.toBe('exceeds_total_quota');
	});

	it('returns "needs_eviction" with a plan when file fits quota but not remaining space', () => {
		const stale = makeCandidate({ videoId: 'stale', fileSizeBytes: 300 });
		const result = checkQuota({
			fileSizeBytes: 400,
			quotaBytes: 1000,
			usedBytes: 800, // only 200 free, need 200 more
			existingSongs: [stale],
			now
		});
		expect(result.outcome).toBe('needs_eviction');
		if (result.outcome === 'needs_eviction') {
			expect(result.plan.sufficient).toBe(true);
			expect(result.plan.toEvict.map((c) => c.videoId)).toEqual(['stale']);
		}
	});

	it('produces an insufficient plan when even evicting everything cannot free enough space', () => {
		const small = makeCandidate({ videoId: 'small', fileSizeBytes: 50 });
		const result = checkQuota({
			fileSizeBytes: 900,
			quotaBytes: 1000,
			usedBytes: 950,
			existingSongs: [small],
			now
		});
		expect(result.outcome).toBe('needs_eviction');
		if (result.outcome === 'needs_eviction') {
			expect(result.plan.sufficient).toBe(false);
		}
	});

	it('actually threads a custom halfLifeDays into the eviction plan (changes which song is evicted)', () => {
		// A: heavily played but 5 days stale. B: barely played but very fresh.
		// With the default 30-day half-life, A's score still dominates B's ->
		// B (lower score) gets evicted first. With an aggressive 0.5-day
		// half-life, A's score decays far below B's -> A gets evicted first
		// instead. If checkQuota silently dropped the halfLifeDays option,
		// both cases would evict the same song.
		const songA = makeCandidate({
			videoId: 'a-hot-but-stale',
			playCount: 100,
			lastPlayedAt: new Date('2026-05-27T00:00:00.000Z'), // 5 days before `now`
			fileSizeBytes: 100
		});
		const songB = makeCandidate({
			videoId: 'b-cold-but-fresh',
			playCount: 2,
			lastPlayedAt: new Date('2026-05-31T00:00:00.000Z'), // 1 day before `now`
			fileSizeBytes: 200
		});

		const resultDefault = checkQuota({
			fileSizeBytes: 100,
			quotaBytes: 1000,
			usedBytes: 950,
			existingSongs: [songA, songB],
			now
		});
		const resultAggressiveDecay = checkQuota({
			fileSizeBytes: 100,
			quotaBytes: 1000,
			usedBytes: 950,
			existingSongs: [songA, songB],
			now,
			halfLifeDays: 0.5
		});

		expect(resultDefault.outcome).toBe('needs_eviction');
		expect(resultAggressiveDecay.outcome).toBe('needs_eviction');
		if (
			resultDefault.outcome === 'needs_eviction' &&
			resultAggressiveDecay.outcome === 'needs_eviction'
		) {
			expect(resultDefault.plan.toEvict[0].videoId).toBe('b-cold-but-fresh');
			expect(resultAggressiveDecay.plan.toEvict[0].videoId).toBe('a-hot-but-stale');
		}
	});
});
