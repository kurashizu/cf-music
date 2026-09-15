<script lang="ts">
	import { player } from '$lib/client/player.svelte';

	const BAR_COUNT = 20;

	let canvas: HTMLCanvasElement | undefined = $state();
	let frameId: number | undefined;
	// TEMP diagnostic: logs once/sec instead of every frame, tagged so it's
	// easy to filter/find and easy to grep out again once this is
	// resolved. Remove once the "spectrum never animates" report is closed.
	let lastDiagAt = 0;

	function draw(): void {
		frameId = requestAnimationFrame(draw);
		if (!canvas) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		const width = canvas.width;
		const height = canvas.height;
		ctx.clearRect(0, 0, width, height);

		const analyser = player.isPlaying ? player.getAnalyser() : null;
		const barWidth = width / BAR_COUNT;
		const gap = barWidth * 0.3;

		// idleLevels gives every bar a small resting height instead of the
		// canvas going fully blank while paused/loading — a flat "0" reading
		// looks broken, a faint static shape reads as "idle, ready".
		const levels = analyser ? readLevels(analyser) : new Array(BAR_COUNT).fill(0.06);

		const now = Date.now();
		if (now - lastDiagAt > 1000) {
			lastDiagAt = now;
			console.log('[spectrum-diag]', {
				isPlaying: player.isPlaying,
				hasAnalyser: !!analyser,
				audioContextState: analyser?.context.state,
				levelsSum: levels.reduce((a, b) => a + b, 0),
				levelsSample: levels.slice(0, 5).map((v) => Math.round(v * 100) / 100)
			});
		}

		// Canvas's fillStyle has no concept of the CSS `currentColor`
		// keyword — assigning it is simply ignored, silently leaving
		// fillStyle at its default black, which is invisible against this
		// bar's dark background. getComputedStyle resolves the element's
		// actual (inherited) text color instead.
		ctx.fillStyle = getComputedStyle(canvas).color;
		for (let i = 0; i < BAR_COUNT; i++) {
			const level = levels[i];
			const barHeight = Math.max(2, level * height);
			const x = i * barWidth + gap / 2;
			const y = height - barHeight;
			ctx.fillRect(x, y, barWidth - gap, barHeight);
		}
	}

	function readLevels(analyser: AnalyserNode): number[] {
		const data = new Uint8Array(analyser.frequencyBinCount);
		analyser.getByteFrequencyData(data);
		const levels: number[] = [];
		const binsPerBar = Math.max(1, Math.floor(data.length / BAR_COUNT));
		for (let i = 0; i < BAR_COUNT; i++) {
			let sum = 0;
			for (let b = 0; b < binsPerBar; b++) {
				sum += data[i * binsPerBar + b] ?? 0;
			}
			levels.push(sum / binsPerBar / 255);
		}
		return levels;
	}

	$effect(() => {
		frameId = requestAnimationFrame(draw);
		return () => {
			if (frameId !== undefined) cancelAnimationFrame(frameId);
		};
	});
</script>

<canvas
	bind:this={canvas}
	width="60"
	height="20"
	class="h-5 w-[60px] text-muted-foreground"
	aria-hidden="true"
></canvas>
