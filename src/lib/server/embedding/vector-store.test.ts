import { describe, it, expect, vi } from 'vitest';
import { VectorizeSongStore } from './vector-store';

/** Minimal fake covering only what VectorizeSongStore actually calls — real VectorizeIndex has far more methods this doesn't need. */
function fakeIndex(getByIds: (ids: string[]) => Promise<{ id: string; values: number[] }[]>) {
	return { getByIds } as unknown as VectorizeIndex;
}

describe('VectorizeSongStore.getSongEmbeddings', () => {
	it('returns an empty map without calling Vectorize at all for an empty input', async () => {
		const getByIds = vi.fn();
		const store = new VectorizeSongStore(fakeIndex(getByIds));

		const result = await store.getSongEmbeddings([]);

		expect(result.size).toBe(0);
		expect(getByIds).not.toHaveBeenCalled();
	});

	it('makes a single call for a batch under the 20-id limit', async () => {
		const getByIds = vi.fn(async (ids: string[]) => ids.map((id) => ({ id, values: [1, 2, 3] })));
		const store = new VectorizeSongStore(fakeIndex(getByIds));

		const result = await store.getSongEmbeddings(['a', 'b', 'c']);

		expect(getByIds).toHaveBeenCalledTimes(1);
		expect(result.get('a')).toEqual([1, 2, 3]);
	});

	// Regression: a real 92-id call against production Vectorize failed
	// with "VECTOR_GET_ERROR (code = 40007): too many ids in payload; max
	// id count is 20, got 92" — getByIds silently accepting an oversized
	// array in earlier code meant this was never caught until a live CI
	// run against the real 92-song library hit it.
	it('splits a batch over 20 ids into multiple getByIds calls', async () => {
		const getByIds = vi.fn(async (ids: string[]) => ids.map((id) => ({ id, values: [0] })));
		const store = new VectorizeSongStore(fakeIndex(getByIds));
		const videoIds = Array.from({ length: 45 }, (_, i) => `v${i}`);

		const result = await store.getSongEmbeddings(videoIds);

		expect(getByIds).toHaveBeenCalledTimes(3); // 20 + 20 + 5
		for (const call of getByIds.mock.calls) {
			expect((call[0] as string[]).length).toBeLessThanOrEqual(20);
		}
		expect(result.size).toBe(45);
	});

	it('omits ids Vectorize has no entry for, rather than throwing', async () => {
		const getByIds = vi.fn(async () => [{ id: 'a', values: [1] }]); // 'b' is missing
		const store = new VectorizeSongStore(fakeIndex(getByIds));

		const result = await store.getSongEmbeddings(['a', 'b']);

		expect(result.has('a')).toBe(true);
		expect(result.has('b')).toBe(false);
	});
});
