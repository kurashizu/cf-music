<script lang="ts">
	import { player } from '$lib/client/player.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import Volume2Icon from '@lucide/svelte/icons/volume-2';
	import Volume1Icon from '@lucide/svelte/icons/volume-1';
	import VolumeXIcon from '@lucide/svelte/icons/volume-x';
	import { fly } from 'svelte/transition';
	import { motionParams } from '$lib/client/motion';

	let track: HTMLDivElement | undefined = $state();
	let dragging = $state(false);
	let hovering = $state(false);

	const effectiveVolume = $derived(player.muted ? 0 : player.volume);
	const panelOpen = $derived(hovering || dragging);

	function percentFromPointer(clientY: number): number {
		if (!track) return 0;
		const rect = track.getBoundingClientRect();
		// The track fills bottom-up (0% at the bottom), so percent is
		// measured from the bottom edge, not the top like a normal
		// top-down layout would.
		return Math.min(1, Math.max(0, (rect.bottom - clientY) / rect.height));
	}

	function handlePointerDown(event: PointerEvent) {
		dragging = true;
		player.setVolume(percentFromPointer(event.clientY));
		(event.target as HTMLElement).setPointerCapture(event.pointerId);
	}

	function handlePointerMove(event: PointerEvent) {
		if (!dragging) return;
		player.setVolume(percentFromPointer(event.clientY));
	}

	function handlePointerUp(event: PointerEvent) {
		dragging = false;
		(event.target as HTMLElement).releasePointerCapture(event.pointerId);
	}

	function handleKeydown(event: KeyboardEvent) {
		const step = 0.05;
		if (event.key === 'ArrowUp') {
			player.setVolume(effectiveVolume + step);
		} else if (event.key === 'ArrowDown') {
			player.setVolume(effectiveVolume - step);
		} else {
			return;
		}
		event.preventDefault();
	}
</script>

<div
	class="relative hidden sm:block"
	onpointerenter={() => (hovering = true)}
	onpointerleave={() => (hovering = false)}
	role="group"
>
	<Button
		variant="ghost"
		size="icon-sm"
		class="text-muted-foreground"
		onclick={() => player.toggleMute()}
		aria-label={player.muted ? 'Unmute' : 'Mute'}
	>
		{#if player.muted || effectiveVolume === 0}
			<VolumeXIcon class="size-4" />
		{:else if effectiveVolume < 0.5}
			<Volume1Icon class="size-4" />
		{:else}
			<Volume2Icon class="size-4" />
		{/if}
	</Button>

	{#if panelOpen}
		<div
			class="absolute bottom-full left-1/2 -translate-x-1/2 pb-2"
			transition:fly={motionParams({ y: 4, duration: 100 })}
		>
			<div class="rounded-lg border border-border bg-card p-2 shadow-md">
				<div
					bind:this={track}
					role="slider"
					tabindex="0"
					aria-label="Volume"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round(effectiveVolume * 100)}
					class="relative h-20 w-3 cursor-pointer touch-none rounded-full bg-muted"
					onpointerdown={handlePointerDown}
					onpointermove={handlePointerMove}
					onpointerup={handlePointerUp}
					onkeydown={handleKeydown}
				>
					<div
						class="absolute inset-x-0 bottom-0 rounded-full bg-foreground"
						style="height: {effectiveVolume * 100}%"
					></div>
				</div>
			</div>
		</div>
	{/if}
</div>
