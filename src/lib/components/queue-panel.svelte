<script lang="ts">
	import { player } from '$lib/client/player.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import XIcon from '@lucide/svelte/icons/x';

	let open = $state(false);

	function formatTime(seconds: number): string {
		if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${m}:${s.toString().padStart(2, '0')}`;
	}
</script>

<!-- Fixed to the viewport corner, not anchored to the queue button's own
     position inside the player bar — a popover anchored there would open
     directly on top of the player bar's other controls (the bar spans the
     full window width right at the bottom edge), which is what this
     replaced. bottom-20 on mobile clears the player bar itself plus the
     fixed bottom nav under it; md:bottom-24 just clears the taller
     desktop player bar. -->
<div class="fixed right-3 bottom-20 z-40 md:right-4 md:bottom-24">
	{#if open}
		<div class="mb-2 w-72 overflow-hidden rounded-xl border border-border bg-card shadow-lg sm:w-80">
			<div class="flex items-center justify-between border-b border-border px-3 py-2.5">
				<p class="text-sm font-medium">Queue</p>
				<button
					type="button"
					class="rounded p-1 text-muted-foreground hover:text-foreground"
					onclick={() => (open = false)}
					aria-label="Close queue"
				>
					<XIcon class="size-4" />
				</button>
			</div>
			{#if player.currentTrack}
				<div class="flex items-center gap-2 border-b border-border px-3 py-2.5">
					<span
						class="size-1.5 shrink-0 rounded-full {player.isPlaying
							? 'animate-pulse bg-foreground'
							: 'bg-muted-foreground'}"
					></span>
					<p class="min-w-0 flex-1 truncate text-sm font-medium">{player.currentTrack.title}</p>
					<span class="shrink-0 text-xs text-muted-foreground">
						{formatTime(player.currentTimeSeconds)}
					</span>
				</div>
			{/if}
			{#if player.upcoming.length === 0}
				<p class="px-3 py-6 text-center text-xs text-muted-foreground">Nothing queued up next.</p>
			{:else}
				<div class="flex max-h-80 flex-col overflow-y-auto p-1.5">
					<p class="px-1.5 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
						Next up
					</p>
					{#each player.upcoming as { track, queueArrayIndex }, position (queueArrayIndex)}
						<div class="group flex items-center gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-muted">
							<span class="w-4 shrink-0 text-right text-xs text-muted-foreground">{position + 1}</span>
							<button
								type="button"
								class="min-w-0 flex-1 truncate text-left text-sm"
								onclick={() => player.playFromQueue(queueArrayIndex)}
							>
								{track.title}
							</button>
							{#if track.durationSeconds !== null}
								<span class="shrink-0 text-xs text-muted-foreground">
									{formatTime(track.durationSeconds)}
								</span>
							{/if}
							<button
								type="button"
								class="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
								onclick={() => player.removeFromQueue(queueArrayIndex)}
								aria-label="Remove {track.title} from queue"
							>
								<XIcon class="size-3.5" />
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	<Button
		variant="ghost"
		size="icon-sm"
		class="relative bg-card shadow-md {player.upcoming.length > 0 ? 'text-foreground' : 'text-muted-foreground'}"
		onclick={() => (open = !open)}
		aria-label="Queue"
		aria-expanded={open}
	>
		<ListMusicIcon class="size-4" />
		{#if player.upcoming.length > 0}
			<span
				class="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-foreground text-[9px] font-medium text-background"
			>
				{player.upcoming.length > 9 ? '9+' : player.upcoming.length}
			</span>
		{/if}
	</Button>
</div>
