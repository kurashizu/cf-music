<script lang="ts">
	interface Props {
		onIntersect: () => void;
	}

	let { onIntersect }: Props = $props();

	let element: HTMLDivElement | undefined = $state();

	// IntersectionObserver over a plain scroll listener: cheaper (no
	// per-scroll-event JS), and doesn't need to know which ancestor is
	// actually the scrolling container — every song-list page's scroll
	// container differs (page-level vs. a page's own overflow-y-auto), an
	// observer just watches the sentinel's own viewport visibility instead.
	$effect(() => {
		if (!element) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) onIntersect();
			},
			{ rootMargin: '400px' }
		);
		observer.observe(element);
		return () => observer.disconnect();
	});
</script>

<div bind:this={element} class="h-px w-full" aria-hidden="true"></div>
