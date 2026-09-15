<script lang="ts">
	import { reducedMotion } from '$lib/client/motion';

	// Minimal dependency-free SVG area/line chart. Deliberately not a
	// general-purpose charting library — just enough (linear scale, smooth
	// path, gradient fill, hover tooltip) for the stats page's own
	// time-series data, which is always a short array of {label, value}.
	interface Point {
		label: string;
		value: number;
	}

	let { points, height = 160, formatValue = (v: number) => String(v) }: {
		points: Point[];
		height?: number;
		formatValue?: (value: number) => string;
	} = $props();

	const width = 600;
	const paddingY = 12;

	const maxValue = $derived(Math.max(1, ...points.map((p) => p.value)));

	const coords = $derived(
		points.map((p, i) => {
			const x = points.length > 1 ? (i / (points.length - 1)) * width : width / 2;
			const y =
				height - paddingY - (p.value / maxValue) * (height - paddingY * 2);
			return { x, y, ...p };
		})
	);

	const linePath = $derived(
		coords.length > 0
			? coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ')
			: ''
	);

	const areaPath = $derived(
		coords.length > 0
			? `${linePath} L ${coords[coords.length - 1].x} ${height} L ${coords[0].x} ${height} Z`
			: ''
	);

	let hoverIndex: number | null = $state(null);
	const gradientId = `area-gradient-${Math.random().toString(36).slice(2)}`;

	// Draw-in effect: measure the line's real length once it's in the DOM,
	// then animate stroke-dashoffset from that length (fully retracted)
	// down to 0. The area fill can't dash-draw the same way (it's a closed
	// shape, not a single stroke), so it just fades in alongside.
	let lineEl: SVGPathElement | undefined = $state();
	let pathLength = $state(0);
	let drawn = $state(false);

	$effect(() => {
		if (!lineEl || linePath === '') return;
		pathLength = lineEl.getTotalLength();
		drawn = false;
		if (reducedMotion()) {
			drawn = true;
			return;
		}
		const raf = requestAnimationFrame(() => (drawn = true));
		return () => cancelAnimationFrame(raf);
	});

	function handleMove(event: PointerEvent, svgEl: SVGSVGElement) {
		const rect = svgEl.getBoundingClientRect();
		const relativeX = ((event.clientX - rect.left) / rect.width) * width;
		let closest = 0;
		let closestDist = Infinity;
		for (let i = 0; i < coords.length; i++) {
			const dist = Math.abs(coords[i].x - relativeX);
			if (dist < closestDist) {
				closestDist = dist;
				closest = i;
			}
		}
		hoverIndex = coords.length > 0 ? closest : null;
	}
</script>

{#if points.length === 0}
	<p class="text-xs text-muted-foreground">Not enough data yet.</p>
{:else}
	<div class="relative">
		<svg
			viewBox="0 0 {width} {height}"
			preserveAspectRatio="none"
			class="h-auto w-full touch-none"
			style="height: {height}px"
			role="img"
			aria-label="Chart"
			onpointermove={(e) => handleMove(e, e.currentTarget as SVGSVGElement)}
			onpointerleave={() => (hoverIndex = null)}
		>
			<defs>
				<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stop-color="currentColor" stop-opacity="0.25" />
					<stop offset="100%" stop-color="currentColor" stop-opacity="0" />
				</linearGradient>
			</defs>

			<path
				d={areaPath}
				fill="url(#{gradientId})"
				class="text-primary transition-opacity duration-700 ease-out {drawn ? 'opacity-100' : 'opacity-0'}"
			/>
			<path
				bind:this={lineEl}
				d={linePath}
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linejoin="round"
				stroke-linecap="round"
				class="text-primary transition-[stroke-dashoffset] duration-700 ease-out"
				style="stroke-dasharray: {pathLength}; stroke-dashoffset: {drawn ? 0 : pathLength}"
			/>

			{#if hoverIndex !== null && coords[hoverIndex]}
				<line
					x1={coords[hoverIndex].x}
					x2={coords[hoverIndex].x}
					y1="0"
					y2={height}
					stroke="currentColor"
					stroke-width="1"
					class="text-muted-foreground/30"
				/>
				<circle
					cx={coords[hoverIndex].x}
					cy={coords[hoverIndex].y}
					r="4"
					fill="currentColor"
					class="text-primary"
				/>
			{/if}
		</svg>

		{#if hoverIndex !== null && coords[hoverIndex]}
			{@const point = coords[hoverIndex]}
			{@const percent = Math.min(94, Math.max(6, (point.x / width) * 100))}
			<div
				class="pointer-events-none absolute top-0 -translate-x-1/2 rounded-md border border-border bg-popover px-2 py-1 text-xs whitespace-nowrap shadow-md"
				style="left: {percent}%"
			>
				<div class="font-medium">{formatValue(point.value)}</div>
				<div class="text-muted-foreground">{point.label}</div>
			</div>
		{/if}
	</div>
{/if}
