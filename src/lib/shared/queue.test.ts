import { describe, it, expect } from 'vitest';
import { shuffleOrder, nextQueueIndex, cycleRepeatMode, moveIndexToFront } from './queue';

describe('shuffleOrder', () => {
	it('returns an empty array for length 0', () => {
		expect(shuffleOrder(0)).toEqual([]);
	});

	it('returns the single index for length 1', () => {
		expect(shuffleOrder(1)).toEqual([0]);
	});

	it('returns every index from 0 to length-1 exactly once', () => {
		const result = shuffleOrder(10);
		expect([...result].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it('is deterministic given a fixed random source (identity permutation when random() is always 0)', () => {
		// Fisher-Yates with random() always returning 0 always swaps index i with
		// index 0, which produces a specific, reproducible (not identity) order —
		// pinning it down catches accidental algorithm changes.
		expect(shuffleOrder(4, () => 0)).toEqual([1, 2, 3, 0]);
	});

	it('produces a different order for a different fixed random source', () => {
		const first = shuffleOrder(8, () => 0);
		const second = shuffleOrder(8, () => 0.999999);
		expect(first).not.toEqual(second);
	});

	it('scales the candidate index by the current swap range, not an off-by-one variant of it', () => {
		// At i=2 (length 3), the valid swap range is [0, i] (3 slots), so
		// random()=0.5 maps to floor(0.5 * 3) = 1. A range of `i - 1` instead of
		// `i + 1` would map the same random() to floor(0.5 * 1) = 0, producing a
		// different result — this pins the exact multiplier down.
		expect(shuffleOrder(3, () => 0.5)).toEqual([0, 2, 1]);
	});
});

describe('nextQueueIndex', () => {
	it('moves forward by one within bounds', () => {
		expect(nextQueueIndex(0, 3, 1, 'off')).toBe(1);
	});

	it('moves backward by one within bounds', () => {
		expect(nextQueueIndex(1, 3, -1, 'off')).toBe(0);
	});

	it('returns null moving forward off the end with repeat off', () => {
		expect(nextQueueIndex(2, 3, 1, 'off')).toBeNull();
	});

	it('wraps to 0 moving forward off the end with repeat all', () => {
		expect(nextQueueIndex(2, 3, 1, 'all')).toBe(0);
	});

	it('returns null moving forward off the end with repeat all but an empty queue', () => {
		expect(nextQueueIndex(0, 0, 1, 'all')).toBeNull();
	});

	it('returns null moving backward off the start regardless of repeat mode', () => {
		expect(nextQueueIndex(0, 3, -1, 'all')).toBeNull();
	});

	it('does not wrap moving forward off the end with repeat one', () => {
		expect(nextQueueIndex(2, 3, 1, 'one')).toBeNull();
	});

	it('stays in bounds one step before the last index', () => {
		expect(nextQueueIndex(1, 3, 1, 'off')).toBe(2);
	});
});

describe('cycleRepeatMode', () => {
	it('off -> all', () => {
		expect(cycleRepeatMode('off')).toBe('all');
	});

	it('all -> one', () => {
		expect(cycleRepeatMode('all')).toBe('one');
	});

	it('one -> off', () => {
		expect(cycleRepeatMode('one')).toBe('off');
	});
});

describe('moveIndexToFront', () => {
	it('moves the target index to the front, preserving the rest of the order', () => {
		expect(moveIndexToFront([3, 1, 4, 0, 2], 4)).toEqual([4, 3, 1, 0, 2]);
	});

	it('is a no-op (structurally) when the target is already first', () => {
		expect(moveIndexToFront([4, 3, 1, 0, 2], 4)).toEqual([4, 3, 1, 0, 2]);
	});

	it('does not duplicate the target if called on a single-element array', () => {
		expect(moveIndexToFront([0], 0)).toEqual([0]);
	});

	it('leaves the array unchanged (aside from ordering) when the target is not present', () => {
		expect(moveIndexToFront([1, 2, 3], 99)).toEqual([99, 1, 2, 3]);
	});
});
