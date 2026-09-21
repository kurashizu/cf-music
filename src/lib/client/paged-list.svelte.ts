/**
 * A window onto a list whose items load a page at a time.
 *
 * Owns exactly one concern: which slice of a remote list is currently
 * materialised, and fetching the pages that slice needs. It knows nothing
 * about songs, selection, sorting or rendering — callers layer those on top.
 *
 * The window grows forward and is never trimmed from behind — see extend()
 * for why recycling rows makes a scrolling list unstable.
 */
export interface PagedListOptions<T> {
	/** Total number of items on the server. */
	total: number;
	/** Items already delivered with the initial render, from index 0. */
	initial: T[];
	/** Fetches `count` items starting at `offset`. Must return them in order. */
	fetchRange: (offset: number, count: number) => Promise<T[]>;
	/** How many items to add to the window at a time. */
	pageSize?: number;
	/** Largest range a single fetch may request, mirroring the endpoint's own cap. */
	maxFetch?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_FETCH = 100;

export class PagedList<T> {
	/** Every item by its index in the full list; holes are positions not currently held. */
	items = $state<(T | undefined)[]>([]);
	/** First index of the materialised window. */
	windowStart = $state(0);
	/** Number of items the window currently spans. */
	windowCount = $state(0);
	/** Set for the duration of extend(), so overlapping callers can't stack pages. */
	private extending = false;

	private readonly total: number;
	private readonly pageSize: number;
	private readonly maxFetch: number;
	private readonly fetchRange: (offset: number, count: number) => Promise<T[]>;
	private readonly inFlight = new Set<number>();

	constructor(options: PagedListOptions<T>) {
		this.total = options.total;
		this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
		this.maxFetch = options.maxFetch ?? DEFAULT_MAX_FETCH;
		this.fetchRange = options.fetchRange;
		this.reset(options.initial);
	}

	/**
	 * Re-seeds from a fresh payload, e.g. after the list is mutated.
	 *
	 * `keepWindow` is for a re-seed that carries everything already on screen
	 * — reordering a fully-loaded playlist, say. Collapsing back to one page
	 * there would snap a 200-row list down to 20, scrolling the reader away
	 * from the edit they just made, and would also disable further dragging,
	 * since that needs the whole list rendered.
	 */
	reset(initial: T[], keepWindow = false): void {
		// .fill() matters: a bare `new Array(n)` has holes that map/filter skip
		// entirely rather than visiting, so scans for missing positions come
		// back empty.
		const next = new Array<T | undefined>(this.total).fill(undefined);
		initial.forEach((item, i) => (next[i] = item));
		this.items = next;
		if (keepWindow) return;
		this.windowStart = 0;
		this.windowCount = Math.min(this.pageSize, this.total);
	}

	/** Indices currently materialised and safe to render. */
	get windowIndices(): number[] {
		const indices: number[] = [];
		for (let i = this.windowStart; i < this.windowStart + this.windowCount && i < this.total; i++) {
			if (this.items[i] !== undefined) indices.push(i);
		}
		return indices;
	}

	get hasMore(): boolean {
		return this.windowStart + this.windowCount < this.total;
	}

	get loadedCount(): number {
		return this.items.reduce<number>((n, item) => (item === undefined ? n : n + 1), 0);
	}

	get isComplete(): boolean {
		return this.loadedCount >= this.total;
	}

	/**
	 * Reveals another page.
	 *
	 * The window only ever grows. Dropping rows that scrolled off the top is
	 * tempting — it is where the memory goes in a naive list — but a released
	 * row takes its height with it, so the content above the viewport
	 * collapses and the browser drags the scroll position up to compensate.
	 * That reads as the page flickering and jumping back toward the top, which
	 * is far worse than holding some rows. Bounding the memory each row costs
	 * (see the cover downscaling in image-throttle) is the part that actually
	 * needed solving; recycling rows would additionally require rendering a
	 * placeholder of the exact height each one left behind.
	 */
	async extend(): Promise<void> {
		if (!this.hasMore || this.extending) return;
		// Guarded because windowCount grows before the await resolves, so
		// hasMore reports another page immediately while the rows for this
		// one have not rendered yet. A caller that polls — the scroll
		// sentinel does — then sees a viewport that still looks unfilled and
		// extends again, and again, walking a thousand-song playlist to its
		// end in one burst with nobody scrolling. Measured: 47 requests and
		// every row rendered on opening the default playlist, with
		// scrollHeight unchanged at 1143px throughout.
		this.extending = true;
		try {
			const end = Math.min(this.total, this.windowStart + this.windowCount + this.pageSize);
			this.windowCount = end - this.windowStart;
			await this.ensure(this.windowStart, end);
		} finally {
			this.extending = false;
		}
	}

	/** Loads every remaining item — for operations that need the whole list. */
	async loadAll(): Promise<void> {
		if (this.isComplete) return;
		await this.ensure(0, this.total);
	}

	/** Fetches whatever is missing in [from, to), in chunks the endpoint accepts. */
	private async ensure(from: number, to: number): Promise<void> {
		const missing: number[] = [];
		for (let i = from; i < to; i++) {
			if (this.items[i] === undefined && !this.inFlight.has(i)) missing.push(i);
		}
		if (missing.length === 0) return;

		const ranges: [number, number][] = [];
		let runStart = missing[0];
		let prev = missing[0];
		for (const i of missing.slice(1)) {
			if (i !== prev + 1 || i - runStart >= this.maxFetch) {
				ranges.push([runStart, prev]);
				runStart = i;
			}
			prev = i;
		}
		ranges.push([runStart, prev]);

		for (const i of missing) this.inFlight.add(i);
		try {
			const pages = await Promise.all(
				ranges.map(async ([start, endInclusive]) => ({
					offset: start,
					items: await this.fetchRange(start, endInclusive - start + 1)
				}))
			);
			const next = [...this.items];
			for (const page of pages) {
				page.items.forEach((item, i) => (next[page.offset + i] = item));
			}
			this.items = next;
		} finally {
			for (const i of missing) this.inFlight.delete(i);
		}
	}
}
