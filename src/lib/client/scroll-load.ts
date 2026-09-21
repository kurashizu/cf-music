/** How close to the end of the scroll container counts as "reached the end". */
export const LOAD_THRESHOLD_PX = 400;

export interface ScrollGeometry {
	/** How far the container has been scrolled from the top. */
	scrollTop: number;
	/** Total scrollable content height. */
	scrollHeight: number;
	/** Visible height of the container. */
	clientHeight: number;
}

/**
 * Whether an infinite-scroll list should load its next page.
 *
 * Proximity to the end is deliberately not enough on its own. The sentinel
 * is polled, and each load appends a page that moves the sentinel down with
 * it — so at the top of a list whose rows are short, the distance to the
 * end after a load is still inside the threshold, the next poll fires, and
 * the list walks itself to the bottom with nobody touching the scrollbar.
 * That was 47 sequential requests and 959 rows rendered on opening a
 * thousand-song playlist.
 *
 * So a list that hasn't been scrolled at all only loads when its content
 * genuinely cannot scroll — the case the poll exists for, a window tall
 * enough to show a whole page without producing any scrollable distance.
 * Once the user has scrolled, proximity is the right signal again.
 */
export function shouldLoadMore(
	geometry: ScrollGeometry,
	thresholdPx: number = LOAD_THRESHOLD_PX
): boolean {
	const { scrollTop, scrollHeight, clientHeight } = geometry;

	if (scrollTop === 0) {
		return scrollHeight <= clientHeight + thresholdPx;
	}

	return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}
