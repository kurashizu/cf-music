import { describe, it, expect } from 'vitest';
import { computePlayThresholdSeconds, hasReachedPlayThreshold } from './playback';

describe('computePlayThresholdSeconds', () => {
	it('uses 50% of duration for a short track (below the 30s cap)', () => {
		expect(computePlayThresholdSeconds(40)).toBe(20);
	});

	it('caps at 30 seconds for a long track', () => {
		expect(computePlayThresholdSeconds(300)).toBe(30);
	});

	it('returns exactly 30 at the boundary where 50% equals 30s (60s track)', () => {
		expect(computePlayThresholdSeconds(60)).toBe(30);
	});

	it('returns 0 for a zero-duration track', () => {
		expect(computePlayThresholdSeconds(0)).toBe(0);
	});

	it('returns 0 for a negative duration (defensive)', () => {
		expect(computePlayThresholdSeconds(-10)).toBe(0);
	});

	it('returns 0 for a non-finite duration (NaN)', () => {
		expect(computePlayThresholdSeconds(NaN)).toBe(0);
	});

	it('returns 0 for a non-finite duration (Infinity)', () => {
		expect(computePlayThresholdSeconds(Infinity)).toBe(0);
	});
});

describe('hasReachedPlayThreshold', () => {
	it('returns false before the threshold', () => {
		expect(hasReachedPlayThreshold(10, 300)).toBe(false);
	});

	it('returns true exactly at the threshold (boundary)', () => {
		expect(hasReachedPlayThreshold(30, 300)).toBe(true);
	});

	it('returns true after the threshold', () => {
		expect(hasReachedPlayThreshold(31, 300)).toBe(true);
	});

	it('returns true immediately for a zero-duration track (threshold is 0)', () => {
		expect(hasReachedPlayThreshold(0, 0)).toBe(true);
	});
});
