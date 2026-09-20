/**
 * A window onto a list whose items load a page at a time.
 *
 * Owns exactly one concern: which slice of a remote list is currently
 * materialised, and fetching the pages that slice needs. It knows nothing
 * about songs, selection, sorting or rendering — callers layer those on top.
 *
 * The window is bounded at both ends. Earlier implementations only ever grew
 * it, so scrolling a few hundred rows left every one of them mounted, and the
 * accumulated DOM (and the decoded cover in each row) was enough for a mobile
 * browser to discard the page. Rows outside the window are released.
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
	/** Largest number of items kept materialised; older ones are released. */
	maxWindow?: number;
	/** Largest range a single fetch may request, mirroring the endpoint's own cap. */
	maxFetch?: number;
}

const DEFAULT_PAGE_SIZE = 20;
/**
 * Roughly five screenfuls at typical row heights — enough that scrolling
 * never reveals a gap, small enough that memory stays flat however far the
 * list is scrolled.
 */
const DEFAULT_MAX_WINDOW = 100;
const DEFAULT_MAX_FETCH = 100;

export class PagedList<T> {
	/** Every item by its index in the full list; holes are positions not currently held. */
	items = $state<(T | undefined)[]>([]);
	/** First index of the materialised window. */
	windowStart = $state(0);
	/** Number of items the window currently spans. */
	windowCount = $state(0);

	private readonly total: number;
	private readonly pageSize: number;
	private readonly maxWindow: number;
	private readonly maxFetch: number;
	private readonly fetchRange: (offset: number, count: number) => Promise<T[]>;
	private readonly inFlight = new Set<number>();

	constructor(options: PagedListOptions<T>) {
		this.total = options.total;
		this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
		this.maxWindow = options.maxWindow ?? DEFAULT_MAX_WINDOW;
		this.maxFetch = options.maxFetch ?? DEFAULT_MAX_FETCH;
		this.fetchRange = options.fetchRange;
		this.reset(options.initial);
	}

	/** Re-seeds from a fresh server payload, e.g. after the list is mutated. */
	reset(initial: T[]): void {
		// .fill() matters: a bare `new Array(n)` has holes that map/filter skip
		// entirely rather than visiting, so scans for missing positions come
		// back empty.
		const next = new Array<T | undefined>(this.total).fill(undefined);
		initial.forEach((item, i) => (next[i] = item));
		this.items = next;
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

	/** Extends the window forward, releasing items that fall off the back. */
	async extend(): Promise<void> {
		if (!this.hasMore) return;
		const end = Math.min(this.total, this.windowStart + this.windowCount + this.pageSize);
		const start = Math.max(0, end - this.maxWindow);

		this.windowStart = start;
		this.windowCount = end - start;
		this.release();
		await this.ensure(start, end);
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

	/**
	 * Drops items outside the window. Skipped once the whole list is held,
	 * since callers that asked for everything (searching, sorting, queueing)
	 * need it to stay.
	 */
	private release(): void {
		if (this.isComplete) return;
		const keepFrom = this.windowStart;
		const keepTo = this.windowStart + this.windowCount;
		const next = [...this.items];
		let released = false;
		for (let i = 0; i < next.length; i++) {
			if (i < keepFrom || i >= keepTo) {
				if (next[i] !== undefined) {
					next[i] = undefined;
					released = true;
				}
			}
		}
		if (released) this.items = next;
	}
}
