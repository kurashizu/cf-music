import { describe, it, expect } from 'vitest';
import { chunk } from './chunk';

describe('chunk', () => {
	it('returns an empty array for an empty input', () => {
		expect(chunk([], 3)).toEqual([]);
	});

	it('returns a single chunk when items fit within size', () => {
		expect(chunk([1, 2], 3)).toEqual([[1, 2]]);
	});

	it('splits evenly when length is a multiple of size', () => {
		expect(chunk([1, 2, 3, 4], 2)).toEqual([
			[1, 2],
			[3, 4]
		]);
	});

	it('puts the remainder in a final, smaller chunk', () => {
		expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});

	it('returns one chunk per item when size is 1', () => {
		expect(chunk([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
	});

	it('returns a single chunk when size is larger than the input', () => {
		expect(chunk([1, 2], 100)).toEqual([[1, 2]]);
	});

	it('returns an empty array for a non-positive size with empty input', () => {
		expect(chunk([], 0)).toEqual([]);
	});

	it('treats a non-positive size as "one chunk containing everything"', () => {
		expect(chunk([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
		expect(chunk([1, 2, 3], -5)).toEqual([[1, 2, 3]]);
	});

	it('does not mutate the input array', () => {
		const input = [1, 2, 3];
		chunk(input, 2);
		expect(input).toEqual([1, 2, 3]);
	});

	it('returns a copy, not an alias, for the non-positive-size single-chunk case', () => {
		const input = [1, 2, 3];
		const [returnedChunk] = chunk(input, 0);
		returnedChunk.push(4);
		expect(input).toEqual([1, 2, 3]);
	});
});
