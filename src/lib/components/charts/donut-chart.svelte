<script lang="ts">
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

	const arcs = $derived.by(() => {
		let offset = 0;
		return slices.map((slice) => {
			const fraction = total > 0 ? slice.value / total : 0;
			const length = fraction * circumference;
			const arc = { ...slice, fraction, dashArray: `${length} ${circumference - length}`, dashOffset: -offset };
			offset += length;
			return arc;
		});
	});

	let hoverLabel: string | null = $state(null);
</script>

{#if total === 0}
	<p class="text-xs text-muted-foreground">Not enough data yet.</p>
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
						stroke-dasharray={arc.dashArray}
						stroke-dashoffset={arc.dashOffset}
						class="{arc.strokeClass} cursor-pointer transition-opacity duration-150 {hoverLabel && hoverLabel !== arc.label
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
