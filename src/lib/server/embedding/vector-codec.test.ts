import { describe, it, expect } from 'vitest';
import { encodeVector, decodeVector, cosineSimilarity } from './vector-codec';

describe('encodeVector/decodeVector', () => {
	it('round-trips a vector through encode and decode', () => {
		const original = [0.1, -0.2, 3.5, 0, -1.25];
		const decoded = decodeVector(encodeVector(original));
		expect(Array.from(decoded)).toEqual(
			new Float32Array(original).reduce<number[]>((acc, v) => [...acc, v], [])
		);
	});

	it('decodes correctly from a slice of a larger buffer (non-zero byteOffset)', () => {
		const original = [1, 2, 3];
		const encoded = encodeVector(original);
		const padded = new Uint8Array(10 + encoded.byteLength);
		padded.set(encoded, 10);
		const view = padded.subarray(10, 10 + encoded.byteLength);

		const decoded = decodeVector(view);

		expect(Array.from(decoded)).toEqual([1, 2, 3]);
	});
});

describe('cosineSimilarity', () => {
	it('returns 1 for identical vectors', () => {
		const v = new Float32Array([1, 2, 3]);
		expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
	});

	it('returns 0 for orthogonal vectors', () => {
		expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 5);
	});

	it('returns -1 for opposite vectors', () => {
		expect(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([-1, -2]))).toBeCloseTo(
			-1,
			5
		);
	});

	it('returns 0 for a zero vector rather than NaN', () => {
		expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
	});
});
