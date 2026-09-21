import { describe, it, expect, vi } from 'vitest';
import { PagedList } from './paged-list.svelte';

/** A fake backend that hands out `item-N` and records what was asked for. */
function backend(total: number) {
	const calls: [number, number][] = [];
	return {
		calls,
		fetchRange: vi.fn(async (offset: number, count: number) => {
			calls.push([offset, count]);
			return Array.from(
				{ length: Math.min(count, total - offset) },
				(_, i) => `item-${offset + i}`
			);
		})
	};
}

function build(total: number, initialCount = 20, options = {}) {
	const back = backend(total);
	const list = new PagedList<string>({
		total,
		initial: Array.from({ length: initialCount }, (_, i) => `item-${i}`),
		fetchRange: back.fetchRange,
		...options
	});
	return { list, back };
}

describe('window', () => {
	it('starts at the first page', () => {
		const { list } = build(365);
		expect(list.windowIndices).toEqual([...Array(20).keys()]);
		expect(list.hasMore).toBe(true);
	});

	it('grows a page at a time', async () => {
		const { list } = build(365);
		await list.extend();
		expect(list.windowIndices.length).toBe(40);
		expect(list.windowIndices[39]).toBe(39);
	});

	/**
	 * The scroll sentinel polls, and windowCount grows before extend()'s
	 * await resolves — so hasMore reports another page while the rows for
	 * this one have not rendered. Without a guard the poll kept firing
	 * against a viewport that still looked unfilled: opening a 959-song
	 * playlist made 47 requests and rendered every row, with the container's
	 * scrollHeight never moving off 1143px.
	 */
	it('does not stack pages when called again before the first finishes', async () => {
		const { list, back } = build(959);

		await Promise.all([list.extend(), list.extend(), list.extend(), list.extend()]);

		expect(list.windowIndices.length).toBe(40);
		expect(back.calls.length).toBe(1);
	});

	it('can still extend again once the previous one settled', async () => {
		const { list } = build(959);

		await list.extend();
		await list.extend();

		expect(list.windowIndices.length).toBe(60);
	});

	it('keeps rows that scrolled past, so the content above never collapses', () => {
		// Releasing them would take their height with them and drag the scroll
		// position upward, which reads as the page flickering and jumping.
		const list = build(365).list;
		return (async () => {
			for (let i = 0; i < 6; i++) await list.extend();
			expect(list.windowStart).toBe(0);
			expect(list.windowIndices[0]).toBe(0);
			expect(list.windowIndices.length).toBe(140);
		})();
	});

	it('never reports an index it cannot render', async () => {
		const { list } = build(365);
		for (let i = 0; i < 4; i++) await list.extend();
		for (const i of list.windowIndices) {
			expect(list.items[i]).toBeDefined();
		}
	});

	it('stops at the end of the list', async () => {
		const { list } = build(30);
		await list.extend();
		expect(list.hasMore).toBe(false);
		expect(list.windowIndices.length).toBe(30);
	});
});

describe('fetching', () => {
	it('asks only for positions it is missing', async () => {
		const { list, back } = build(365);
		await list.extend();
		expect(back.calls).toEqual([[20, 20]]);
	});

	it('splits a large range into chunks the endpoint accepts', async () => {
		// The songs endpoint clamps a larger limit silently, so asking for more
		// than it serves would leave the tail of the range unfilled.
		const { list, back } = build(365, 20, { maxFetch: 100 });
		await list.loadAll();
		expect(back.calls.every(([, count]) => count <= 100)).toBe(true);
		expect(list.isComplete).toBe(true);
	});

	it('fills every position when loading everything', async () => {
		const { list } = build(365);
		await list.loadAll();
		expect(list.loadedCount).toBe(365);
		expect(list.items[364]).toBe('item-364');
	});

	it('does not re-request a position already in flight', async () => {
		const { list, back } = build(365);
		await Promise.all([list.extend(), list.extend()]);
		const requested = back.calls.flatMap(([offset, count]) =>
			Array.from({ length: count }, (_, i) => offset + i)
		);
		expect(new Set(requested).size).toBe(requested.length);
	});

	it('keeps everything once the whole list is held', async () => {
		// Searching and sorting need every item to stay available.
		const { list } = build(120);
		await list.loadAll();
		await list.extend();
		expect(list.loadedCount).toBe(120);
	});
});

describe('reset', () => {
	it('re-seeds from a fresh payload and returns to the first page', async () => {
		const { list } = build(365);
		await list.extend();
		list.reset(['fresh-0', 'fresh-1']);
		expect(list.windowStart).toBe(0);
		expect(list.items[0]).toBe('fresh-0');
		expect(list.items[2]).toBeUndefined();
	});
});

describe('reset with keepWindow', () => {
	it('collapses to one page by default', async () => {
		const { list } = build(100);
		await list.loadAll();
		list.windowCount = 100;
		expect(list.windowIndices.length).toBe(100);

		list.reset(Array.from({ length: 100 }, (_, i) => `item-${i}`));

		expect(list.windowIndices.length).toBe(20);
	});

	it('keeps everything on screen when asked, so a reorder does not snap the list back', async () => {
		// Reordering only runs on a fully-loaded list, so collapsing the window
		// would scroll the reader away from the row they just dropped — and
		// would disable dragging, which needs the whole list rendered.
		const { list } = build(100);
		await list.loadAll();
		list.windowCount = 100;
		expect(list.windowIndices.length).toBe(100);

		list.reset(
			Array.from({ length: 100 }, (_, i) => `item-${i}`),
			true
		);

		expect(list.windowIndices.length).toBe(100);
		expect(list.isComplete).toBe(true);
	});
});
