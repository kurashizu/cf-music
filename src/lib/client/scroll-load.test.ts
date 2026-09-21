import { describe, it, expect } from 'vitest';
import { shouldLoadMore, LOAD_THRESHOLD_PX } from './scroll-load';

describe('shouldLoadMore', () => {
	it('loads when the content is too short to scroll at all', () => {
		// The case polling exists for: a window tall enough to show the whole
		// first page, so no scroll event will ever ask for the next one.
		expect(shouldLoadMore({ scrollTop: 0, scrollHeight: 700, clientHeight: 800 })).toBe(true);
	});

	/**
	 * The regression this function was extracted for. Opening a 959-song
	 * playlist fired 47 sequential page requests and rendered every row,
	 * because each load left the end of the content still within the
	 * threshold and the 300ms poll simply fired again.
	 */
	it('does not load at the top of a list that can already scroll', () => {
		expect(shouldLoadMore({ scrollTop: 0, scrollHeight: 4000, clientHeight: 800 })).toBe(false);
	});

	it('still refuses at the top no matter how much content has accumulated', () => {
		expect(shouldLoadMore({ scrollTop: 0, scrollHeight: 46000, clientHeight: 800 })).toBe(false);
	});

	it('loads once the user has scrolled near the end', () => {
		// 4000 - 3000 - 800 = 200px remaining, inside the threshold.
		expect(shouldLoadMore({ scrollTop: 3000, scrollHeight: 4000, clientHeight: 800 })).toBe(true);
	});

	it('does not load while the user is still far from the end', () => {
		// 4000 - 500 - 800 = 2700px remaining.
		expect(shouldLoadMore({ scrollTop: 500, scrollHeight: 4000, clientHeight: 800 })).toBe(false);
	});

	it('treats exactly the threshold as near enough', () => {
		const clientHeight = 800;
		const scrollTop = 1000;
		const scrollHeight = scrollTop + clientHeight + LOAD_THRESHOLD_PX;
		expect(shouldLoadMore({ scrollTop, scrollHeight, clientHeight })).toBe(true);
	});

	it('loads at the very bottom, where nothing remains', () => {
		expect(shouldLoadMore({ scrollTop: 3200, scrollHeight: 4000, clientHeight: 800 })).toBe(true);
	});
});
