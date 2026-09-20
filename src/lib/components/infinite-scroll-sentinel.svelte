<script lang="ts">
	interface Props {
		onIntersect: () => void;
	}

	let { onIntersect }: Props = $props();

	let element: HTMLDivElement | undefined = $state();

	/** How close to the end of the scroll container counts as "reached the end". */
	const LOAD_THRESHOLD_PX = 400;

	/** Nearest scrollable ancestor, or null when the page itself scrolls. */
	function findScrollParent(node: HTMLElement): HTMLElement | null {
		for (let el = node.parentElement; el; el = el.parentElement) {
			const { overflowY } = getComputedStyle(el);
			if (overflowY === 'auto' || overflowY === 'scroll') return el;
		}
		return null;
	}

	// A scroll listener rather than an IntersectionObserver. An observer is
	// cheaper in principle, but its notion of "visible" proved unreliable for
	// a sentinel inside a scrolling `<main class="overflow-y-auto">`: rooted
	// at the viewport it reports the sentinel permanently visible and fires
	// only once, and rooted at the container it did not fire at all in this
	// layout — either way the list stalled on its first page. Measuring the
	// distance to the end directly is predictable, and the handler is trivial
	// (two reads and a compare) and rAF-coalesced, so the per-event cost that
	// motivated the observer does not really apply.
	$effect(() => {
		if (!element) return;
		const scrollParent = findScrollParent(element);
		const target: HTMLElement | Window = scrollParent ?? window;

		let disposed = false;
		let queued = false;

		function remainingPx(): number {
			return scrollParent
				? scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight
				: document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
		}

		function check() {
			queued = false;
			if (disposed || remainingPx() > LOAD_THRESHOLD_PX) return;
			onIntersect();
			// One batch often isn't enough to fill a tall window, and while the
			// container still can't scroll no further event will ever ask for
			// the next one — so keep going until it overflows. This terminates:
			// callers advance monotonically toward a fixed total and stop
			// rendering this sentinel once everything is shown, which disposes
			// the effect.
			schedule();
		}

		function schedule() {
			if (queued || disposed) return;
			queued = true;
			// Two frames: one for Svelte to render the batch just requested,
			// one for layout to settle before re-measuring.
			requestAnimationFrame(() => requestAnimationFrame(check));
		}

		target.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule, { passive: true });

		schedule();

		return () => {
			disposed = true;
			target.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
		};
	});
</script>

<div bind:this={element} class="h-px w-full" aria-hidden="true"></div>
