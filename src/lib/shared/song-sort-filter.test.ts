import { describe, it, expect } from 'vitest';
import { sortSongs, sortIndices, matchesDurationRange, type SongSortFilterInput } from './song-sort-filter';

const songs: SongSortFilterInput[] = [
	{ videoId: 'b', title: 'Bravo', artist: 'Zeta', durationSeconds: 200, addedAt: '2024-01-02' },
	{ videoId: 'a', title: 'alpha', artist: 'Alpha', durationSeconds: 100, addedAt: '2024-01-03' },
	{ videoId: 'c', title: 'Charlie', artist: null, durationSeconds: null, addedAt: null }
];

describe('sortSongs', () => {
	it('leaves order untouched for "custom"', () => {
		expect(sortSongs(songs, 'custom', 'asc').map((s) => s.videoId)).toEqual(['b', 'a', 'c']);
	});

	it('sorts by title case-insensitively, ascending', () => {
		expect(sortSongs(songs, 'title', 'asc').map((s) => s.videoId)).toEqual(['a', 'b', 'c']);
	});

	it('sorts by title descending', () => {
		expect(sortSongs(songs, 'title', 'desc').map((s) => s.videoId)).toEqual(['c', 'b', 'a']);
	});

	it('sorts by artist, nulls first ascending', () => {
		expect(sortSongs(songs, 'artist', 'asc').map((s) => s.videoId)).toEqual(['c', 'a', 'b']);
	});

	it('sorts by duration, nulls first ascending', () => {
		expect(sortSongs(songs, 'duration', 'asc').map((s) => s.videoId)).toEqual(['c', 'a', 'b']);
	});

	it('sorts by duration descending, nulls last', () => {
		expect(sortSongs(songs, 'duration', 'desc').map((s) => s.videoId)).toEqual(['b', 'a', 'c']);
	});

	it('sorts by addedAt ascending, nulls first', () => {
		expect(sortSongs(songs, 'addedAt', 'asc').map((s) => s.videoId)).toEqual(['c', 'b', 'a']);
	});

	it('does not mutate the input array', () => {
		const copy = [...songs];
		sortSongs(songs, 'title', 'asc');
		expect(songs).toEqual(copy);
	});
});

describe('sortIndices', () => {
	it('sorts indices into the array rather than the array itself', () => {
		const indices = [0, 1, 2];
		expect(sortIndices(songs, indices, 'title', 'asc')).toEqual([1, 0, 2]);
	});

	it('leaves indices untouched for "custom"', () => {
		expect(sortIndices(songs, [2, 0, 1], 'custom', 'asc')).toEqual([2, 0, 1]);
	});
});

describe('matchesDurationRange', () => {
	it('matches everything when both bounds are null', () => {
		expect(matchesDurationRange(null, { minSeconds: null, maxSeconds: null })).toBe(true);
		expect(matchesDurationRange(120, { minSeconds: null, maxSeconds: null })).toBe(true);
	});

	it('excludes a null duration once any bound is set', () => {
		expect(matchesDurationRange(null, { minSeconds: 60, maxSeconds: null })).toBe(false);
	});

	it('excludes durations below the minimum', () => {
		expect(matchesDurationRange(59, { minSeconds: 60, maxSeconds: null })).toBe(false);
		expect(matchesDurationRange(60, { minSeconds: 60, maxSeconds: null })).toBe(true);
	});

	it('excludes durations above the maximum', () => {
		expect(matchesDurationRange(301, { minSeconds: null, maxSeconds: 300 })).toBe(false);
		expect(matchesDurationRange(300, { minSeconds: null, maxSeconds: 300 })).toBe(true);
	});

	it('applies both bounds together', () => {
		const range = { minSeconds: 60, maxSeconds: 300 };
		expect(matchesDurationRange(30, range)).toBe(false);
		expect(matchesDurationRange(180, range)).toBe(true);
		expect(matchesDurationRange(400, range)).toBe(false);
	});
});
