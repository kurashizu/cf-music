<script lang="ts">
	import { scale } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { player } from '$lib/client/player.svelte';
	import { queuePanelState } from '$lib/client/queue-panel-state.svelte';
	import { motionParams } from '$lib/client/motion';
	import XIcon from '@lucide/svelte/icons/x';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

	// Purely visual — collapses the now-playing row's audio-spec detail,
	// no data implications, cheap enough to not bother persisting.
	let nowPlayingExpanded = $state(true);

	// Anchored to the trigger button's own last-measured position (see
	// queue-trigger-button.svelte) rather than a hardcoded viewport offset —
	// the player bar isn't a fixed height (it wraps its content), so a
	// guessed bottom-N class drifted out of sync with where the button
	// actually sits across breakpoints. Positioned from `top` (the
	// button's own top edge, minus a gap) with translateY(-100%) to flip
	// upward from that point, rather than computing where the panel's
	// bottom edge should land relative to the viewport's bottom edge —
	// the latter only holds if the button is flush against the viewport's
	// bottom, which isn't guaranteed (e.g. the mobile bottom nav sits
	// below the player bar), so it could open a full nav-bar's-height too
	// high floating detached above the button instead of sitting right
	// next to it.
	const PANEL_WIDTH = 320;
	const GAP_PX = 8;
	const style = $derived.by(() => {
		const rect = queuePanelState.anchorRect;
		if (!rect) return '';
		const right = Math.max(12, window.innerWidth - rect.right);
		const top = rect.top - GAP_PX;
		return `right: ${right}px; top: ${top}px; transform: translateY(-100%); width: min(${PANEL_WIDTH}px, calc(100vw - 24px));`;
	});

	function formatTime(seconds: number): string {
		if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${m}:${s.toString().padStart(2, '0')}`;
	}
</script>

{#if queuePanelState.open}
	<div
		{style}
		class="fixed z-40 origin-bottom-right overflow-hidden rounded-xl border border-border bg-card shadow-lg"
		transition:scale={{ duration: 150, start: 0.95, opacity: 0 }}
	>
		<div class="flex items-center justify-between border-b border-border px-3 py-2.5">
			<p class="text-sm font-medium">Queue</p>
			<button
				type="button"
				class="rounded p-2.5 text-muted-foreground transition-colors hover:text-foreground sm:p-1"
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
						animate:flip={motionParams({ duration: 200 })}
						transition:scale={motionParams({ duration: 150, start: 0.9, opacity: 0 })}
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
							class="shrink-0 rounded p-2 text-muted-foreground opacity-100 transition-opacity hover:text-foreground sm:p-1 sm:opacity-0 sm:group-hover:opacity-100"
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
