<script lang="ts">
	import { player } from '$lib/client/player.svelte';
	import { queuePanelState } from '$lib/client/queue-panel-state.svelte';
	import XIcon from '@lucide/svelte/icons/x';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

	// Purely visual — collapses the now-playing row's audio-spec detail,
	// no data implications, cheap enough to not bother persisting.
	let nowPlayingExpanded = $state(true);

	function formatTime(seconds: number): string {
		if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${m}:${s.toString().padStart(2, '0')}`;
	}
</script>

<!-- Fixed to the viewport corner rather than anchored to the trigger
     button's own position (see queue-trigger-button.svelte, which lives
     inline in the player bar's button row) — anchoring a popover to a
     button inside a full-width bottom bar puts the popover right on top of
     the bar's other controls instead of reading as its own panel. -->
{#if queuePanelState.open}
	<div
		class="fixed right-3 bottom-32 z-40 w-72 origin-bottom-right overflow-hidden rounded-xl border border-border bg-card shadow-lg transition-[opacity,transform] duration-150 sm:w-80 md:right-4 md:bottom-36"
	>
		<div class="flex items-center justify-between border-b border-border px-3 py-2.5">
			<p class="text-sm font-medium">Queue</p>
			<button
				type="button"
				class="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
				onclick={() => (queuePanelState.open = false)}
				aria-label="Close queue"
			>
				<XIcon class="size-4" />
			</button>
		</div>
		{#if player.currentTrack}
			<div class="border-b border-border">
				<button
					type="button"
					class="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted"
					onclick={() => (nowPlayingExpanded = !nowPlayingExpanded)}
					aria-expanded={nowPlayingExpanded}
				>
					<span
						class="size-1.5 shrink-0 rounded-full {player.isPlaying
							? 'animate-pulse bg-foreground'
							: 'bg-muted-foreground'}"
					></span>
					<p class="min-w-0 flex-1 truncate text-sm font-medium">{player.currentTrack.title}</p>
					<span class="shrink-0 text-xs text-muted-foreground">
						{formatTime(player.currentTimeSeconds)}
					</span>
					<ChevronDownIcon
						class="size-3.5 shrink-0 text-muted-foreground transition-transform {nowPlayingExpanded
							? ''
							: '-rotate-90'}"
					/>
				</button>
				{#if nowPlayingExpanded && player.audioSpec}
					<p class="px-3 pb-2.5 font-mono text-[10px] text-muted-foreground">
						{player.audioSpec.codec}{player.audioSpec.bitrateKbps ? ` · ${player.audioSpec.bitrateKbps}kbps` : ''}
					</p>
				{/if}
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
					<div
						class="group flex items-center gap-2.5 rounded-md px-1.5 py-1.5 transition-colors hover:bg-muted"
					>
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
