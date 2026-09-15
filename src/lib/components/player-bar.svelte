<script lang="ts">
	import { player } from '$lib/client/player.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import SkipBackIcon from '@lucide/svelte/icons/skip-back';
	import SkipForwardIcon from '@lucide/svelte/icons/skip-forward';
	import ShuffleIcon from '@lucide/svelte/icons/shuffle';
	import RepeatIcon from '@lucide/svelte/icons/repeat';
	import Repeat1Icon from '@lucide/svelte/icons/repeat-1';
	import MusicIcon from '@lucide/svelte/icons/music';
	import VolumeControl from '$lib/components/volume-control.svelte';
	import SpectrumVisualizer from '$lib/components/spectrum-visualizer.svelte';
	import QueuePanel from '$lib/components/queue-panel.svelte';
	import QueueTriggerButton from '$lib/components/queue-trigger-button.svelte';

	function formatAudioSpec(spec: typeof player.audioSpec): string {
		if (!spec) return '';
		const parts = [spec.codec];
		if (spec.bitrateKbps) parts.push(`${spec.bitrateKbps}kbps`);
		return parts.join(' · ');
	}

	function formatTime(seconds: number): string {
		if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${m}:${s.toString().padStart(2, '0')}`;
	}

	let seekTrack: HTMLDivElement | undefined = $state();
	let dragging = $state(false);
	let dragPercent = $state(0);

	function percentFromPointer(clientX: number): number {
		if (!seekTrack) return 0;
		const rect = seekTrack.getBoundingClientRect();
		return Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
	}

	function seekToPercent(percent: number) {
		if (player.durationSeconds <= 0) return;
		player.seekTo((percent / 100) * player.durationSeconds);
	}

	function handlePointerDown(event: PointerEvent) {
		if (player.durationSeconds <= 0) return;
		dragging = true;
		dragPercent = percentFromPointer(event.clientX);
		(event.target as HTMLElement).setPointerCapture(event.pointerId);
	}

	function handlePointerMove(event: PointerEvent) {
		if (!dragging) return;
		dragPercent = percentFromPointer(event.clientX);
	}

	function handlePointerUp(event: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		seekToPercent(percentFromPointer(event.clientX));
		(event.target as HTMLElement).releasePointerCapture(event.pointerId);
	}

	function handleTrackKeydown(event: KeyboardEvent) {
		if (player.durationSeconds <= 0) return;
		const stepSeconds = event.shiftKey ? 10 : 5;
		if (event.key === 'ArrowRight') {
			player.seekTo(Math.min(player.durationSeconds, player.currentTimeSeconds + stepSeconds));
		} else if (event.key === 'ArrowLeft') {
			player.seekTo(Math.max(0, player.currentTimeSeconds - stepSeconds));
		} else {
			return;
		}
		event.preventDefault();
	}

	const actualPercent = $derived(
		player.durationSeconds > 0 ? (player.currentTimeSeconds / player.durationSeconds) * 100 : 0
	);
	const progressPercent = $derived(dragging ? dragPercent : actualPercent);
</script>

<!-- mb-14 clears the mobile bottom nav, which is fixed and overlays
     whatever's otherwise at the bottom of the viewport; not needed on
     desktop, where that nav doesn't exist. Always rendered (not gated on
     currentTrack) so the queue is reachable — e.g. to start playback from
     songs added to it — even before anything's actually playing yet. -->
<div class="mb-14 shrink-0 border-t border-border bg-card/95 backdrop-blur-sm md:mb-0">
	<!-- Custom seek track (not a native <input type="range">, whose
	     browser-default styling looked out of place against the rest of
	     the app's own progress-bar visual language elsewhere — e.g. the
	     storage usage bars). A group of nested divs plus pointer events
	     instead, matching that same h-1.5/rounded-full/bg-muted look. -->
	<div
		bind:this={seekTrack}
		role="slider"
		tabindex="0"
		aria-label="Seek"
		aria-valuemin={0}
		aria-valuemax={Math.round(player.durationSeconds)}
		aria-valuenow={Math.round(player.currentTimeSeconds)}
		class="group/seek relative h-3 w-full touch-none px-3 md:px-4 {player.currentTrack
			? 'cursor-pointer'
			: 'pointer-events-none'}"
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		onkeydown={handleTrackKeydown}
	>
		<div class="absolute inset-x-3 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-muted md:inset-x-4">
			<div
				class="h-full rounded-full bg-foreground {dragging ? '' : 'transition-[width] duration-150'}"
				style="width: {progressPercent}%"
			></div>
		</div>
		<div
			class="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground opacity-0 shadow-sm transition-opacity group-hover/seek:opacity-100 {dragging
				? 'opacity-100'
				: ''}"
			style="left: calc(0.75rem + (100% - 1.5rem) * {progressPercent / 100})"
		></div>
	</div>

	<div class="flex items-center gap-3 px-3 py-2 md:px-4">
		<div class="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
			{#if player.coverUrl}
				<img src={player.coverUrl} alt="" class="size-10 rounded-md object-cover" />
			{:else}
				<MusicIcon class="size-4 text-muted-foreground" />
			{/if}
		</div>

		<div class="min-w-0 flex-1">
			<p class="truncate text-sm font-medium">
				{player.currentTrack?.title ?? 'Nothing playing'}
			</p>
			<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
				{#if player.currentTrack}
					<span>{formatTime(player.currentTimeSeconds)} / {formatTime(player.durationSeconds)}</span>
					{#if player.audioSpec}
						<span
							class="hidden rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-normal text-muted-foreground sm:inline"
						>
							{formatAudioSpec(player.audioSpec)}
						</span>
					{/if}
				{:else}
					Pick a song to get started
				{/if}
			</p>
		</div>

		<div class="hidden md:block">
			<SpectrumVisualizer />
		</div>

		<VolumeControl />

		<div class="hidden items-center gap-1 sm:flex">
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon-sm"
							class={player.shuffleEnabled ? 'text-foreground' : 'text-muted-foreground'}
							disabled={!player.currentTrack}
							onclick={() => player.toggleShuffle()}
							aria-label="Toggle shuffle"
							aria-pressed={player.shuffleEnabled}
						>
							<ShuffleIcon class="size-4" />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>{player.shuffleEnabled ? 'Shuffle on' : 'Shuffle off'}</Tooltip.Content>
			</Tooltip.Root>
		</div>

		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="icon-sm"
						disabled={!player.hasPrevious}
						onclick={() => player.previous()}
						aria-label="Previous"
					>
						<SkipBackIcon class="size-4" />
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>Previous</Tooltip.Content>
		</Tooltip.Root>

		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						size="icon-sm"
						class="rounded-full"
						disabled={!player.currentTrack || player.isLoading}
						onclick={() => player.togglePlayPause()}
						aria-label={player.isPlaying ? 'Pause' : 'Play'}
					>
						{#if player.isPlaying}
							<PauseIcon class="size-4" />
						{:else}
							<PlayIcon class="size-4" />
						{/if}
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>{player.isPlaying ? 'Pause' : 'Play'}</Tooltip.Content>
		</Tooltip.Root>

		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="icon-sm"
						disabled={!player.hasNext}
						onclick={() => player.next()}
						aria-label="Next"
					>
						<SkipForwardIcon class="size-4" />
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>Next</Tooltip.Content>
		</Tooltip.Root>

		<div class="hidden items-center gap-1 sm:flex">
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon-sm"
							class={player.repeatMode !== 'off' ? 'text-foreground' : 'text-muted-foreground'}
							disabled={!player.currentTrack}
							onclick={() => player.cycleRepeatMode()}
							aria-label="Toggle repeat"
							aria-pressed={player.repeatMode !== 'off'}
						>
							{#if player.repeatMode === 'one'}
								<Repeat1Icon class="size-4" />
							{:else}
								<RepeatIcon class="size-4" />
							{/if}
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>
					{player.repeatMode === 'off' ? 'Repeat off' : player.repeatMode === 'one' ? 'Repeat one' : 'Repeat all'}
				</Tooltip.Content>
			</Tooltip.Root>
		</div>

		<QueueTriggerButton />
	</div>
</div>

<QueuePanel />
