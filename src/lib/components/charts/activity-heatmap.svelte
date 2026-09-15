<script lang="ts">
	// GitHub-contributions-style grid: one column per day over the last N
	// weeks, intensity = play count that day. Deliberately calendar-shaped
	// (not a bar chart) since the point is spotting streaks/gaps at a
	// glance, which a bar chart of the same data doesn't convey as well.
	let { counts, weeks = 18 }: { counts: Map<string, number>; weeks?: number } = $props();

	interface Day {
		date: string;
		count: number;
		dayOfWeek: number;
	}

	const days = $derived.by((): Day[] => {
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		// Align the grid so the last column ends on the most recent Saturday
		// (or today), keeping full weeks (Sun-Sat) throughout.
		const endDayOfWeek = today.getDay();
		const gridEnd = new Date(today);
		gridEnd.setDate(gridEnd.getDate() + (6 - endDayOfWeek));

		const totalDays = weeks * 7;
		const result: Day[] = [];
		for (let i = totalDays - 1; i >= 0; i--) {
			const d = new Date(gridEnd);
			d.setDate(d.getDate() - i);
			const key = d.toISOString().slice(0, 10);
			result.push({ date: key, count: counts.get(key) ?? 0, dayOfWeek: d.getDay() });
		}
		return result;
	});

	const columns = $derived.by((): Day[][] => {
		const cols: Day[][] = [];
		for (let i = 0; i < days.length; i += 7) cols.push(days.slice(i, i + 7));
		return cols;
	});

	const maxCount = $derived(Math.max(1, ...days.map((d) => d.count)));

	function intensityClass(count: number): string {
		if (count === 0) return 'bg-muted';
		const ratio = count / maxCount;
		if (ratio > 0.75) return 'bg-primary';
		if (ratio > 0.5) return 'bg-primary/70';
		if (ratio > 0.25) return 'bg-primary/45';
		return 'bg-primary/25';
	}

	function formatDate(dateStr: string): string {
		return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric'
		});
	}

	// Clamps the tooltip's horizontal anchor so it stays inside the
	// scrollable grid instead of overflowing on the first/last few
	// columns (same idea as area-chart's tooltip clamp).
	function tooltipAlignClass(columnIndex: number, totalColumns: number): string {
		if (columnIndex < 2) return 'left-0 translate-x-0';
		if (columnIndex > totalColumns - 3) return 'right-0 left-auto translate-x-0';
		return 'left-1/2 -translate-x-1/2';
	}
</script>

<div class="flex gap-[3px] overflow-x-auto pb-1">
	{#each columns as column, i (i)}
		<div class="flex flex-col gap-[3px]">
			{#each column as day (day.date)}
				<div
					class="group relative size-2.5 rounded-sm {intensityClass(day.count)} transition-transform hover:scale-125"
					role="presentation"
				>
					<div
						class="pointer-events-none absolute bottom-full z-10 mb-1 rounded-md border border-border bg-popover px-1.5 py-0.5 text-[10px] whitespace-nowrap opacity-0 shadow-md transition-opacity group-hover:opacity-100 {tooltipAlignClass(
							i,
							columns.length
						)}"
					>
						{day.count} {day.count === 1 ? 'play' : 'plays'} · {formatDate(day.date)}
					</div>
				</div>
			{/each}
		</div>
	{/each}
</div>
