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
	// Touch has no hover state at all, so a tap on the mute button toggles
	// the slider panel open/closed there instead of only being reachable
	// by hovering (which is how the desktop-only version of this worked
	// before mobile got a volume control at all).
	let toggledOpen = $state(false);

	const effectiveVolume = $derived(player.muted ? 0 : player.volume);
	const panelOpen = $derived(hovering || dragging || toggledOpen);

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

	// Touch has no hover, so tapping the button there can't double as
	// "mute" the way it does on desktop (see onclick below) — it has to
	// open the panel instead, or a phone user would have no way to reach
	// the slider at all. `pointerType` reliably distinguishes the two:
	// real mice/trackpads report 'mouse', touch and pen report otherwise.
	function handleButtonClick(event: PointerEvent) {
		if (event.pointerType === 'mouse') {
			player.toggleMute();
		} else {
			toggledOpen = !toggledOpen;
		}
	}
</script>

<div
	class="relative"
	onpointerenter={() => (hovering = true)}
	onpointerleave={() => (hovering = false)}
	role="group"
>
	<Button
		variant="ghost"
		size="icon-sm"
		class="text-muted-foreground"
		onpointerup={handleButtonClick}
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
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="absolute bottom-full left-1/2 z-40 -translate-x-1/2 pb-2"
			transition:fly={motionParams({ y: 4, duration: 100 })}
			onclick={(e) => e.stopPropagation()}
		>
			<div class="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-2 shadow-md">
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
				<!-- Only reachable path to mute/unmute on touch, since the
				     main button there opens/closes this panel instead (see
				     handleButtonClick) rather than toggling mute directly. -->
				<button
					type="button"
					class="text-muted-foreground sm:hidden"
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
				</button>
			</div>
		</div>
	{/if}
</div>

<!-- Closes the touch-toggled panel on an outside tap — desktop doesn't
     need this since pointerleave already collapses it there. -->
{#if toggledOpen}
	<button
		type="button"
		class="fixed inset-0 z-30 sm:hidden"
		tabindex="-1"
		aria-hidden="true"
		onclick={() => (toggledOpen = false)}
	></button>
{/if}
