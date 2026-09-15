<script lang="ts">
	import { player } from '$lib/client/player.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import SkipBackIcon from '@lucide/svelte/icons/skip-back';
	import SkipForwardIcon from '@lucide/svelte/icons/skip-forward';
	import ShuffleIcon from '@lucide/svelte/icons/shuffle';
	import RepeatIcon from '@lucide/svelte/icons/repeat';
	import Repeat1Icon from '@lucide/svelte/icons/repeat-1';
	import MusicIcon from '@lucide/svelte/icons/music';

	function formatTime(seconds: number): string {
		if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${m}:${s.toString().padStart(2, '0')}`;
	}

	function handleSeek(event: Event) {
		const value = Number((event.target as HTMLInputElement).value);
		player.seekTo(value);
	}

	const progressPercent = $derived(
		player.durationSeconds > 0 ? (player.currentTimeSeconds / player.durationSeconds) * 100 : 0
	);
</script>

{#if player.currentTrack}
	<!-- mb-14 clears the mobile bottom nav, which is fixed and overlays
	     whatever's otherwise at the bottom of the viewport; not needed on
	     desktop, where that nav doesn't exist. -->
	<div class="mb-14 shrink-0 border-t border-border bg-card/95 backdrop-blur-sm md:mb-0">
		<!-- Seek bar spans the full width, as a subtle top edge of the player -->
		<input
			type="range"
			min="0"
			max={player.durationSeconds || 0}
			value={player.currentTimeSeconds}
			oninput={handleSeek}
			class="h-1 w-full cursor-pointer appearance-none bg-transparent accent-foreground [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-muted [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground"
			style="background: linear-gradient(to right, var(--color-foreground) {progressPercent}%, var(--color-muted) {progressPercent}%)"
			aria-label="Seek"
		/>

		<div class="flex items-center gap-3 px-3 py-2 md:px-4">
			<div class="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
				{#if player.coverUrl}
					<img src={player.coverUrl} alt="" class="size-10 rounded-md object-cover" />
				{:else}
					<MusicIcon class="size-4 text-muted-foreground" />
				{/if}
			</div>

			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-medium">{player.currentTrack.title}</p>
				<p class="text-xs text-muted-foreground">
					{formatTime(player.currentTimeSeconds)} / {formatTime(player.durationSeconds)}
				</p>
			</div>

			<div class="hidden items-center gap-1 sm:flex">
				<Button
					variant="ghost"
					size="icon-sm"
					class={player.shuffleEnabled ? 'text-foreground' : 'text-muted-foreground'}
					onclick={() => player.toggleShuffle()}
					aria-label="Toggle shuffle"
					aria-pressed={player.shuffleEnabled}
				>
					<ShuffleIcon class="size-4" />
				</Button>
			</div>

			<Button
				variant="ghost"
				size="icon-sm"
				disabled={!player.hasPrevious}
				onclick={() => player.previous()}
				aria-label="Previous"
			>
				<SkipBackIcon class="size-4" />
			</Button>

			<Button
				size="icon-sm"
				class="rounded-full"
				disabled={player.isLoading}
				onclick={() => player.togglePlayPause()}
				aria-label={player.isPlaying ? 'Pause' : 'Play'}
			>
				{#if player.isPlaying}
					<PauseIcon class="size-4" />
				{:else}
					<PlayIcon class="size-4" />
				{/if}
			</Button>

			<Button
				variant="ghost"
				size="icon-sm"
				disabled={!player.hasNext}
				onclick={() => player.next()}
				aria-label="Next"
			>
				<SkipForwardIcon class="size-4" />
			</Button>

			<div class="hidden items-center gap-1 sm:flex">
				<Button
					variant="ghost"
					size="icon-sm"
					class={player.repeatMode !== 'off' ? 'text-foreground' : 'text-muted-foreground'}
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
			</div>
		</div>
	</div>
{/if}
