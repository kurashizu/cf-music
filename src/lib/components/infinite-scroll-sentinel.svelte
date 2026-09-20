<script lang="ts">
	interface Props {
		/** Loads the next page. Awaited, so a promise here is honoured. */
		onIntersect: () => void | Promise<void>;
	}

	let { onIntersect }: Props = $props();

	let element: HTMLDivElement | undefined = $state();

	/** How close to the end of the scroll container counts as "reached the end". */
	const LOAD_THRESHOLD_PX = 400;
	/**
	 * How often to look while the end is still in reach.
	 *
	 * A tall window can show a whole page without producing any scrollable
	 * distance, and then no scroll event ever fires to ask for the next one.
	 * Polling covers that without making each load drive a chain of follow-up
	 * checks: that chain has to survive a fetch, a re-render and a layout
	 * pass, and any early return along the way strands the list part-way down
	 * with no event able to restart it.
	 */
	const POLL_INTERVAL_MS = 300;

	/** Nearest scrollable ancestor, or null when the page itself scrolls. */
	function findScrollParent(node: HTMLElement): HTMLElement | null {
		for (let el = node.parentElement; el; el = el.parentElement) {
			const { overflowY } = getComputedStyle(el);
			if (overflowY === 'auto' || overflowY === 'scroll') return el;
		}
		return null;
	}

	// A poll plus a scroll listener rather than an IntersectionObserver. An
	// observer is cheaper in principle, but its notion of "visible" proved
	// unreliable for a sentinel inside a scrolling `<main>`: rooted at the
	// viewport it reported the sentinel permanently visible and fired only
	// once, and rooted at the container it did not fire at all. Measuring the
	// distance to the end is predictable, and the check is two reads and a
	// compare.
	$effect(() => {
		if (!element) return;
		const scrollParent = findScrollParent(element);
		const target: HTMLElement | Window = scrollParent ?? window;

		let disposed = false;
		let loading = false;

		function remainingPx(): number {
			return scrollParent
				? scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight
				: document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
		}

		async function maybeLoad(): Promise<void> {
			if (disposed || loading || remainingPx() > LOAD_THRESHOLD_PX) return;
			loading = true;
			try {
				await onIntersect();
			} finally {
				loading = false;
			}
		}

		const request = () => void maybeLoad();
		const timer = setInterval(request, POLL_INTERVAL_MS);
		target.addEventListener('scroll', request, { passive: true });
		request();

		return () => {
			disposed = true;
			clearInterval(timer);
			target.removeEventListener('scroll', request);
		};
	});
</script>

<div bind:this={element} class="h-px w-full" aria-hidden="true"></div>
