import { describe, it, expect } from 'vitest';
import {
	computeEvictionScore,
	rankEvictionCandidates,
	planEviction,
	DEFAULT_HALF_LIFE_DAYS,
	type EvictionCandidate
} from './eviction-score';

describe('computeEvictionScore', () => {
	it('returns 0 for a never-played song (playCount = 0)', () => {
		const score = computeEvictionScore({ playCount: 0, lastPlayedAt: null });
		expect(score).toBe(0);
	});

	it('returns 0 when playCount is 0 even if lastPlayedAt is set', () => {
		const score = computeEvictionScore({ playCount: 0, lastPlayedAt: new Date() });
		expect(score).toBe(0);
	});

	it('returns 0 when lastPlayedAt is null even if playCount is positive (defensive)', () => {
		const score = computeEvictionScore({ playCount: 5, lastPlayedAt: null });
		expect(score).toBe(0);
	});

	it('returns 0 for a negative playCount (defensive)', () => {
		const score = computeEvictionScore({ playCount: -3, lastPlayedAt: new Date() });
		expect(score).toBe(0);
	});

	it('returns exactly playCount when played right now (zero decay)', () => {
		const now = new Date('2026-01-01T00:00:00.000Z');
		const score = computeEvictionScore({ playCount: 10, lastPlayedAt: now, now });
		expect(score).toBeCloseTo(10, 10);
	});

	it('halves the score after exactly one half-life period', () => {
		const now = new Date('2026-02-01T00:00:00.000Z');
		const lastPlayedAt = new Date(now.getTime() - DEFAULT_HALF_LIFE_DAYS * 86_400_000);
		const score = computeEvictionScore({ playCount: 8, lastPlayedAt, now });
		expect(score).toBeCloseTo(4, 6);
	});

	it('quarters the score after two half-life periods', () => {
		const now = new Date('2026-03-01T00:00:00.000Z');
		const lastPlayedAt = new Date(now.getTime() - 2 * DEFAULT_HALF_LIFE_DAYS * 86_400_000);
		const score = computeEvictionScore({ playCount: 8, lastPlayedAt, now });
		expect(score).toBeCloseTo(2, 6);
	});

	it('treats a lastPlayedAt in the future as zero elapsed days (clamped)', () => {
		const now = new Date('2026-01-01T00:00:00.000Z');
		const future = new Date('2026-06-01T00:00:00.000Z');
		const score = computeEvictionScore({ playCount: 6, lastPlayedAt: future, now });
		expect(score).toBeCloseTo(6, 10);
	});

	it('respects a custom halfLifeDays', () => {
		const now = new Date('2026-01-11T00:00:00.000Z');
		const lastPlayedAt = new Date('2026-01-01T00:00:00.000Z'); // 10 days ago
		const score = computeEvictionScore({ playCount: 4, lastPlayedAt, now, halfLifeDays: 10 });
		expect(score).toBeCloseTo(2, 6);
	});

	it('a higher play count always scores at least as high given identical recency', () => {
		const now = new Date('2026-01-01T00:00:00.000Z');
		const lastPlayedAt = new Date('2025-12-15T00:00:00.000Z');
		const low = computeEvictionScore({ playCount: 2, lastPlayedAt, now });
		const high = computeEvictionScore({ playCount: 20, lastPlayedAt, now });
		expect(high).toBeGreaterThan(low);
	});

	it('a more recently played song scores at least as high given identical play counts', () => {
		const now = new Date('2026-01-01T00:00:00.000Z');
		const recent = computeEvictionScore({
			playCount: 5,
			lastPlayedAt: new Date('2025-12-30T00:00:00.000Z'),
			now
		});
		const stale = computeEvictionScore({
			playCount: 5,
			lastPlayedAt: new Date('2025-06-01T00:00:00.000Z'),
			now
		});
		expect(recent).toBeGreaterThan(stale);
	});
});

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

describe('rankEvictionCandidates', () => {
	const now = new Date('2026-06-01T00:00:00.000Z');

	it('sorts never-played songs before ever-played songs', () => {
		const neverPlayed = makeCandidate({ videoId: 'never', playCount: 0, lastPlayedAt: null });
		const everPlayed = makeCandidate({
			videoId: 'ever',
			playCount: 1,
			lastPlayedAt: new Date('2020-01-01T00:00:00.000Z') // very stale, but still > 0 score technically near 0
		});
		const ranked = rankEvictionCandidates([everPlayed, neverPlayed], { now });
		expect(ranked[0].videoId).toBe('never');
	});

	it('breaks ties among never-played songs by oldest import first', () => {
		const older = makeCandidate({
			videoId: 'older',
			importedAt: new Date('2025-01-01T00:00:00.000Z')
		});
		const newer = makeCandidate({
			videoId: 'newer',
			importedAt: new Date('2026-01-01T00:00:00.000Z')
		});
		const ranked = rankEvictionCandidates([newer, older], { now });
		expect(ranked.map((c) => c.videoId)).toEqual(['older', 'newer']);
	});

	it('sorts ever-played songs by ascending score', () => {
		const lowScore = makeCandidate({
			videoId: 'low',
			playCount: 1,
			lastPlayedAt: new Date('2020-01-01T00:00:00.000Z')
		});
		const highScore = makeCandidate({
			videoId: 'high',
			playCount: 50,
			lastPlayedAt: new Date('2026-05-31T00:00:00.000Z')
		});
		const ranked = rankEvictionCandidates([highScore, lowScore], { now });
		expect(ranked.map((c) => c.videoId)).toEqual(['low', 'high']);
	});

	it('returns an empty array for empty input', () => {
		expect(rankEvictionCandidates([], { now })).toEqual([]);
	});

	it('attaches a numeric score field to every candidate', () => {
		const candidate = makeCandidate({ videoId: 'x', playCount: 3, lastPlayedAt: now });
		const [ranked] = rankEvictionCandidates([candidate], { now });
		expect(typeof ranked.score).toBe('number');
	});
});

describe('planEviction', () => {
	const now = new Date('2026-06-01T00:00:00.000Z');

	it('requires evicting nothing when bytesNeeded is 0', () => {
		const plan = planEviction([makeCandidate({})], 0, { now });
		expect(plan).toEqual({ toEvict: [], bytesFreed: 0, sufficient: true });
	});

	it('requires evicting nothing when bytesNeeded is negative (defensive)', () => {
		const plan = planEviction([makeCandidate({})], -100, { now });
		expect(plan.toEvict).toEqual([]);
		expect(plan.sufficient).toBe(true);
	});

	it('evicts exactly enough candidates to cover bytesNeeded', () => {
		const a = makeCandidate({ videoId: 'a', fileSizeBytes: 1000 });
		const b = makeCandidate({ videoId: 'b', fileSizeBytes: 1000 });
		const c = makeCandidate({ videoId: 'c', fileSizeBytes: 1000 });
		const plan = planEviction([a, b, c], 1500, { now });
		expect(plan.toEvict).toHaveLength(2);
		expect(plan.bytesFreed).toBe(2000);
		expect(plan.sufficient).toBe(true);
	});

	it('evicts the most-evictable (lowest score) candidates first', () => {
		const stale = makeCandidate({
			videoId: 'stale',
			playCount: 1,
			lastPlayedAt: new Date('2020-01-01T00:00:00.000Z'),
			fileSizeBytes: 1000
		});
		const hot = makeCandidate({
			videoId: 'hot',
			playCount: 100,
			lastPlayedAt: new Date('2026-05-31T00:00:00.000Z'),
			fileSizeBytes: 1000
		});
		const plan = planEviction([hot, stale], 1000, { now });
		expect(plan.toEvict).toHaveLength(1);
		expect(plan.toEvict[0].videoId).toBe('stale');
	});

	it('marks the plan insufficient when candidates cannot cover bytesNeeded', () => {
		const a = makeCandidate({ videoId: 'a', fileSizeBytes: 500 });
		const plan = planEviction([a], 10_000, { now });
		expect(plan.sufficient).toBe(false);
		expect(plan.bytesFreed).toBe(500);
		expect(plan.toEvict).toHaveLength(1);
	});

	it('returns an insufficient empty plan when there are no candidates at all', () => {
		const plan = planEviction([], 100, { now });
		expect(plan).toEqual({ toEvict: [], bytesFreed: 0, sufficient: false });
	});

	it('stops evicting as soon as the threshold is met, not after (exact boundary)', () => {
		const a = makeCandidate({ videoId: 'a', fileSizeBytes: 1000 });
		const b = makeCandidate({ videoId: 'b', fileSizeBytes: 1000 });
		const plan = planEviction([a, b], 1000, { now });
		expect(plan.toEvict).toHaveLength(1);
		expect(plan.bytesFreed).toBe(1000);
		expect(plan.sufficient).toBe(true);
	});

	it('marks the plan as exactly sufficient (not falsely insufficient) when bytesFreed equals bytesNeeded precisely', () => {
		const a = makeCandidate({ videoId: 'a', fileSizeBytes: 250 });
		const plan = planEviction([a], 250, { now });
		expect(plan.sufficient).toBe(true);
	});
});
