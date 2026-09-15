<script lang="ts">
	import { reducedMotion } from '$lib/client/motion';

	interface Slice {
		label: string;
		value: number;
		strokeClass: string;
		dotClass: string;
	}

	let { slices, size = 140 }: { slices: Slice[]; size?: number } = $props();

	const total = $derived(slices.reduce((sum, s) => sum + s.value, 0));
	const radius = 50;
	const circumference = 2 * Math.PI * radius;
	// A slice under ~5% of the circle draws thinner than the ring's own
	// 16px stroke width is tall — it reads as a stray pixel or a rendering
	// glitch, not "this category is small". Floors every non-zero slice's
	// drawn length so it stays legibly arc-shaped without meaningfully
	// distorting the proportions of anything bigger.
	const MIN_VISIBLE_FRACTION = 0.05;

	// A single 100%-share slice (e.g. every song tagged "Unknown" genre)
	// draws as a full, closed ring with no seam — visually identical to
	// "no data", which is exactly the ambiguity this chart most needs to
	// avoid. Below this many distinct non-empty slices, the ring reads as
	// a plain solid indicator instead, with the callout stat leading.
	const isSingleCategory = $derived(slices.filter((s) => s.value > 0).length <= 1);

	const arcs = $derived.by(() => {
		let offset = 0;
		return slices.map((slice) => {
			const rawFraction = total > 0 ? slice.value / total : 0;
			const fraction = rawFraction > 0 ? Math.max(rawFraction, MIN_VISIBLE_FRACTION) : 0;
			const length = fraction * circumference;
			const arc = { ...slice, fraction: rawFraction, length, dashOffset: -offset };
			offset += length;
			return arc;
		});
	});

	let hoverLabel: string | null = $state(null);

	// Same draw-in trick as bar-list: render every arc's dasharray as
	// "0 circumference" (nothing drawn) for one frame, then transition the
	// drawn length up to its real value — a CSS transition can't animate
	// from an element's initial paint otherwise. dashOffset (each arc's
	// fixed rotational position around the ring) stays constant throughout
	// — animating that instead of dasharray would just spin the segment
	// around the circle rather than growing it.
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

{#if total === 0}
	<p class="text-xs text-muted-foreground">Not enough data yet.</p>
{:else if isSingleCategory}
	{@const only = arcs.find((a) => a.value > 0)}
	<div class="flex items-center gap-4">
		<div class="relative shrink-0" style="width: {size}px; height: {size}px">
			<svg viewBox="0 0 120 120" class="-rotate-90" style="width: {size}px; height: {size}px">
				<circle
					cx="60"
					cy="60"
					r={radius}
					fill="none"
					stroke="currentColor"
					stroke-width="16"
					stroke-dasharray="{mounted ? circumference : 0} {circumference}"
					class="{only?.strokeClass ?? 'text-muted-foreground'} transition-[stroke-dasharray] duration-700 ease-out"
				/>
			</svg>
			<div class="absolute inset-0 flex flex-col items-center justify-center">
				<span class="text-lg font-medium">{total}</span>
				<span class="text-[10px] text-muted-foreground">total</span>
			</div>
		</div>
		<div class="flex min-w-0 flex-1 flex-col gap-1">
			<div class="flex items-center gap-2 text-sm">
				<span class="size-2 shrink-0 rounded-full {only?.dotClass}"></span>
				<span class="min-w-0 flex-1 truncate font-medium">{only?.label}</span>
			</div>
			<p class="text-xs text-muted-foreground">
				Every entry falls into this one category — nothing to break down yet.
			</p>
		</div>
	</div>
{:else}
	<div class="flex items-center gap-4">
		<div class="relative shrink-0" style="width: {size}px; height: {size}px">
			<svg viewBox="0 0 120 120" class="-rotate-90" style="width: {size}px; height: {size}px">
				<circle cx="60" cy="60" r={radius} fill="none" stroke="currentColor" stroke-width="16" class="text-muted" />
				{#each arcs as arc (arc.label)}
					<circle
						cx="60"
						cy="60"
						r={radius}
						fill="none"
						stroke="currentColor"
						stroke-width="16"
						stroke-dasharray="{mounted ? arc.length : 0} {circumference}"
						stroke-dashoffset={arc.dashOffset}
						class="{arc.strokeClass} cursor-pointer transition-[stroke-dasharray,opacity] duration-700 ease-out {hoverLabel && hoverLabel !== arc.label
							? 'opacity-40'
							: ''}"
						onpointerenter={() => (hoverLabel = arc.label)}
						onpointerleave={() => (hoverLabel = null)}
						role="presentation"
					/>
				{/each}
			</svg>
			<div class="absolute inset-0 flex flex-col items-center justify-center">
				<span class="text-lg font-medium">
					{hoverLabel ? Math.round((arcs.find((a) => a.label === hoverLabel)?.fraction ?? 0) * 100) : total}{hoverLabel
						? '%'
						: ''}
				</span>
				<span class="text-[10px] text-muted-foreground">{hoverLabel ?? 'total'}</span>
			</div>
		</div>

		<div class="flex min-w-0 flex-1 flex-col gap-1.5">
			{#each arcs as arc (arc.label)}
				<div
					class="flex items-center gap-2 text-xs transition-opacity duration-150 {hoverLabel && hoverLabel !== arc.label
						? 'opacity-40'
						: ''}"
					onpointerenter={() => (hoverLabel = arc.label)}
					onpointerleave={() => (hoverLabel = null)}
					role="presentation"
				>
					<span class="size-2 shrink-0 rounded-full {arc.dotClass}"></span>
					<span class="min-w-0 flex-1 truncate">{arc.label}</span>
					<span class="shrink-0 text-muted-foreground">{Math.round(arc.fraction * 100)}%</span>
				</div>
			{/each}
		</div>
	</div>
{/if}
