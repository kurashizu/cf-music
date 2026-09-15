<script lang="ts">
	interface Bar {
		label: string;
		value: number;
		suffix?: string;
	}

	let { bars }: { bars: Bar[] } = $props();

	const maxValue = $derived(Math.max(1, ...bars.map((b) => b.value)));
</script>

<div class="flex flex-col gap-2.5">
	{#each bars as bar, i (bar.label)}
		<div class="flex items-center gap-2 text-sm">
			<span class="w-4 shrink-0 text-right text-xs text-muted-foreground">{i + 1}</span>
			<div class="min-w-0 flex-1">
				<div class="mb-1 flex items-center justify-between gap-2">
					<span class="min-w-0 truncate">{bar.label}</span>
					<span class="shrink-0 text-xs text-muted-foreground">{bar.value}{bar.suffix ?? ''}</span>
				</div>
				<div class="h-1.5 overflow-hidden rounded-full bg-muted">
					<div
						class="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
						style="width: {(bar.value / maxValue) * 100}%"
					></div>
				</div>
			</div>
		</div>
	{/each}
</div>
