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
	// cheaper in principle, but its notion of "visible" proved unreliable
	// for a sentinel inside a scrolling `<main class="overflow-y-auto">`:
	// rooted at the viewport it reports the sentinel permanently visible and
	// fires only once, and rooted at the container it did not fire at all in
	// this layout — either way the playlist page stalled on its first page of
	// songs. Measuring the distance to the end directly is predictable, and
	// the handler is trivial (two reads plus a compare) and rAF-coalesced, so
	// the per-event cost that motivated the observer does not really apply.
	$effect(() => {
		if (!element) return;
		const scrollParent = findScrollParent(element);
		const target: HTMLElement | Window = scrollParent ?? window;

		let queued = false;
		function check() {
			queued = false;
			const remaining = scrollParent
				? scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight
				: document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
			if (remaining <= LOAD_THRESHOLD_PX) onIntersect();
		}
		function schedule() {
			if (queued) return;
			queued = true;
			requestAnimationFrame(check);
		}

		target.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule, { passive: true });
		// The first screenful may already sit short of the threshold (a
		// container taller than its content), which no scroll event would
		// ever report.
		schedule();

		return () => {
			target.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
		};
	});
</script>

<div bind:this={element} class="h-px w-full" aria-hidden="true"></div>
