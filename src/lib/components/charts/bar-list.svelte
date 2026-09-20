<script lang="ts">
	import { reducedMotion } from '$lib/client/motion';

	interface Bar {
		label: string;
		value: number;
		suffix?: string;
	}

	let { bars }: { bars: Bar[] } = $props();

	const maxValue = $derived(Math.max(1, ...bars.map((b) => b.value)));

	// CSS transitions don't animate from an element's very first paint —
	// only from a subsequent style change — so bars would otherwise just
	// appear at full width immediately. Rendering at width:0 for one frame
	// then flipping to the real width gives the draw-in.
	let mounted = $state(false);
	$effect(() => {
		if (reducedMotion()) {
			mounted = true;
			return;
		}
		const raf = requestAnimationFrame(() => (mounted = true));
		return () => cancelAnimationFrame(raf);
	});
</script>

<div class="flex flex-col gap-2.5">
	{#each bars as bar, i (bar.label)}
		<div class="flex items-center gap-2 text-sm">
			<span class="text-muted-foreground w-4 shrink-0 text-right text-xs">{i + 1}</span>
			<div class="min-w-0 flex-1">
				<div class="mb-1 flex items-center justify-between gap-2">
					<span class="min-w-0 truncate">{bar.label}</span>
					<span class="text-muted-foreground shrink-0 text-xs">{bar.value}{bar.suffix ?? ''}</span>
				</div>
				<div class="bg-muted h-1.5 overflow-hidden rounded-full">
					<div
						class="bg-primary h-full rounded-full transition-[width] duration-500 ease-out"
						style="width: {mounted ? (bar.value / maxValue) * 100 : 0}%; transition-delay: {i *
							40}ms"
					></div>
				</div>
			</div>
		</div>
	{/each}
</div>
