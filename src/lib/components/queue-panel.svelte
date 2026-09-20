<script lang="ts">
	import { scale, fade } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { player } from '$lib/client/player.svelte';
	import { formatPlaybackTime } from '$lib/shared/format';
	import { queuePanelState } from '$lib/client/queue-panel-state.svelte';
	import { motionParams } from '$lib/client/motion';
	import XIcon from '@lucide/svelte/icons/x';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import InfiniteScrollSentinel from '$lib/components/infinite-scroll-sentinel.svelte';

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
	//
	// Below `sm`, this anchored-popover positioning is skipped entirely —
	// a bottom sheet is used instead (see the markup) since a small
	// screen has no good spot to anchor a floating popover to without it
	// covering half the content or clipping off-screen.
	const PANEL_WIDTH = 320;
	const GAP_PX = 8;
	const MOBILE_BREAKPOINT_PX = 640;
	const style = $derived.by(() => {
		const rect = queuePanelState.anchorRect;
		if (!rect || window.innerWidth < MOBILE_BREAKPOINT_PX) return '';
		const right = Math.max(12, window.innerWidth - rect.right);
		const top = rect.top - GAP_PX;
		return `right: ${right}px; top: ${top}px; transform: translateY(-100%); width: min(${PANEL_WIDTH}px, calc(100vw - 24px));`;
	});

	// A long playlist's queue can carry hundreds of upcoming tracks — same
	// windowing pattern as the storage page (see its own visibleCount /
	// loadMore), just scoped to this panel's own scroll container instead of
	// the page. The playlist page uses PagedList instead, which fetches from
	// the server; this queue is already entirely in memory, so there is
	// nothing to fetch. Resets whenever the panel (re)opens or the *current
	// track* changes, not on every upcoming-array mutation —
	// removeFromQueue/reorder already animate via animate:flip and
	// shouldn't also snap the window back to the top.
	const PAGE_SIZE = 30;
	let visibleCount = $state(PAGE_SIZE);
	$effect(() => {
		queuePanelState.open;
		player.currentTrack;
		visibleCount = PAGE_SIZE;
	});
	const visibleUpcoming = $derived(player.upcoming.slice(0, visibleCount));
	function loadMore() {
		visibleCount = Math.min(player.upcoming.length, visibleCount + PAGE_SIZE);
	}
</script>

{#if queuePanelState.open}
	<!-- Mobile-only backdrop: dims and blocks the page behind the sheet,
	     and doubles as a tap-outside-to-close target — the popover variant
	     doesn't need this since it's small enough to leave the rest of the
	     page visibly interactive around it. -->
	<button
		type="button"
		class="fixed inset-0 z-40 bg-black/50 sm:hidden"
		transition:fade={motionParams({ duration: 150 })}
		onclick={() => (queuePanelState.open = false)}
		aria-label="Close queue"
		tabindex="-1"
	></button>
	<div
		{style}
		class="border-border bg-card fixed inset-x-0 bottom-0 z-40 flex max-h-[70vh] origin-bottom flex-col overflow-hidden rounded-t-xl border shadow-lg sm:inset-x-auto sm:bottom-auto sm:origin-bottom-right sm:rounded-xl"
		transition:scale={motionParams({ duration: 150, start: 0.95, opacity: 0 })}
	>
		<div class="border-border flex shrink-0 items-center justify-between border-b px-3 py-2.5">
			<p class="text-sm font-medium">Queue</p>
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground rounded p-2.5 transition-colors active:scale-90 sm:p-1"
				onclick={() => (queuePanelState.open = false)}
				aria-label="Close queue"
			>
				<XIcon class="size-4" />
			</button>
		</div>
		{#if player.currentTrack}
			<div class="border-border border-b">
				<button
					type="button"
					class="active:bg-muted hover:bg-muted flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors"
					onclick={() => (nowPlayingExpanded = !nowPlayingExpanded)}
					aria-expanded={nowPlayingExpanded}
				>
					<!-- A play/pause glyph rather than a pulsing dot: it is the
					     same playing/paused vocabulary the player bar and every
					     song row already use, and it states which of the two it
					     is instead of relying on motion. A continuously running
					     animation also costs frames for as long as the panel is
					     open, which is the reason cover placeholders are a
					     static fill too (see throttled-image). -->
					{#if player.isPlaying}
						<PlayIcon class="text-foreground size-3 shrink-0 fill-current" />
					{:else}
						<PauseIcon class="text-muted-foreground size-3 shrink-0 fill-current" />
					{/if}
					<p class="min-w-0 flex-1 truncate text-sm font-medium">{player.currentTrack.title}</p>
					<span class="text-muted-foreground shrink-0 text-xs">
						{formatPlaybackTime(player.currentTimeSeconds)}
					</span>
					<ChevronDownIcon
						class="text-muted-foreground size-3.5 shrink-0 transition-transform {nowPlayingExpanded
							? ''
							: '-rotate-90'}"
					/>
				</button>
				{#if nowPlayingExpanded && player.audioSpec}
					<p class="text-muted-foreground px-3 pb-2.5 font-mono text-[10px]">
						{player.audioSpec.codec}{player.audioSpec.bitrateKbps
							? ` · ${player.audioSpec.bitrateKbps}kbps`
							: ''}
					</p>
				{/if}
			</div>
		{/if}
		{#if player.upcoming.length === 0}
			<p class="text-muted-foreground px-3 py-6 text-center text-xs">Nothing queued up next.</p>
		{:else}
			<div class="flex max-h-80 flex-col overflow-y-auto p-1.5">
				<p
					class="text-muted-foreground px-1.5 py-1 text-[11px] font-medium tracking-wide uppercase"
				>
					Next up
				</p>
				{#each visibleUpcoming as { track, queueArrayIndex }, position (queueArrayIndex)}
					<div
						class="group active:bg-muted hover:bg-muted flex items-center gap-2.5 rounded-md px-1.5 py-1.5 transition-colors"
						animate:flip={motionParams({ duration: 200 })}
						transition:scale={motionParams({ duration: 150, start: 0.9, opacity: 0 })}
					>
						<span class="text-muted-foreground w-4 shrink-0 text-right text-xs">{position + 1}</span
						>
						<button
							type="button"
							class="min-w-0 flex-1 truncate text-left text-sm"
							onclick={() => player.playFromQueue(queueArrayIndex)}
						>
							{track.title}
						</button>
						{#if track.durationSeconds !== null}
							<span class="text-muted-foreground shrink-0 text-xs">
								{formatPlaybackTime(track.durationSeconds)}
							</span>
						{/if}
						<button
							type="button"
							class="text-muted-foreground hover:text-foreground shrink-0 rounded p-2 opacity-100 transition-opacity active:scale-90 sm:p-1 sm:opacity-0 sm:group-hover:opacity-100"
							onclick={() => player.removeFromQueue(queueArrayIndex)}
							aria-label="Remove {track.title} from queue"
						>
							<XIcon class="size-3.5" />
						</button>
					</div>
				{/each}
				{#if visibleCount < player.upcoming.length}
					<InfiniteScrollSentinel onIntersect={loadMore} />
				{/if}
			</div>
		{/if}
	</div>
{/if}
