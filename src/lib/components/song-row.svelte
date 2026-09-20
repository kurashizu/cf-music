<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import ThrottledImage from '$lib/components/throttled-image.svelte';
	import SongActionsMenu from '$lib/components/song-actions-menu.svelte';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import MusicIcon from '@lucide/svelte/icons/music';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import CheckIcon from '@lucide/svelte/icons/check';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
	import { formatDuration, formatAudioSpec } from '$lib/shared/format';
	import type { SongRowActions, SongRowData, SongRowFlags } from '$lib/components/song-row-types';

	interface Props {
		song: SongRowData;
		flags: SongRowFlags;
		actions: SongRowActions;
	}

	let { song, flags, actions }: Props = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<li
	class="group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors active:bg-muted hover:bg-muted {flags.selected
		? 'bg-muted ring-1 ring-inset ring-ring/50'
		: flags.current
			? 'bg-muted'
			: ''} {flags.dragging ? 'opacity-50' : ''}"
	style={flags.dragOrder === null ? undefined : `order: ${flags.dragOrder}`}
	draggable={flags.draggable}
	ondragstart={() => flags.draggable && actions.onDragStart()}
	ondragover={(e) => flags.draggable && actions.onDragOver(e)}
	ondragend={() => flags.draggable && actions.onDragEnd()}
	onclick={(e) => actions.onSelect(e)}
>
	<!-- Hover-only by design, unlike the other row controls: HTML5 drag never
	     fires from touch, so this handle is inert on a phone — the menu's Move
	     up/down items are the reorder path there. -->
	<button
		type="button"
		class="cursor-grab touch-none text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing {flags.draggable
			? ''
			: 'invisible'}"
		aria-label="Drag to reorder"
		tabindex={flags.draggable ? 0 : -1}
		onclick={(e) => e.stopPropagation()}
	>
		<GripVerticalIcon class="size-4" />
	</button>

	<button
		type="button"
		class="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
		onclick={(e) => {
			e.stopPropagation();
			actions.onPlay();
		}}
		aria-label={flags.current && flags.playing ? 'Pause' : 'Play'}
	>
		{#if flags.current && flags.playing}
			<PauseIcon class="size-4" />
		{:else}
			<PlayIcon class="size-4" />
		{/if}
	</button>

	<div class="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
		{#if song.coverUrl}
			<ThrottledImage src={song.coverUrl} class="size-8" />
		{:else}
			<MusicIcon class="size-3.5 text-muted-foreground" />
		{/if}
	</div>

	<div class="min-w-0 flex-1">
		<p class="truncate text-sm {flags.current ? 'text-foreground' : 'text-foreground/90'}">
			{song.title}
		</p>
	</div>

	{#if flags.cached}
		<span
			class="hidden shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground sm:flex"
		>
			<CheckIcon class="size-3" />
			Cached
		</span>
	{/if}

	<span
		class="hidden shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground sm:inline-block"
	>
		{formatAudioSpec(song.codec, song.bitrateKbps)}
	</span>

	{#if song.embeddingStatus === 'done'}
		<span
			class="hidden shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground sm:flex"
		>
			<SparklesIcon class="size-3" />
			Embedded
		</span>
	{/if}

	<span class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
		<ClockIcon class="size-3" />
		{formatDuration(song.durationSeconds)}
	</span>

	<Button
		variant="ghost"
		size="icon-sm"
		class="opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
		disabled={flags.downloading}
		onclick={(e) => {
			e.stopPropagation();
			actions.onDownload();
		}}
		aria-label={flags.downloading
			? 'Downloading for offline playback'
			: 'Download for offline playback'}
	>
		{#if flags.downloading}
			<LoaderCircleIcon class="size-4 animate-spin" />
		{:else}
			<DownloadIcon class="size-4" />
		{/if}
	</Button>

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<span onclick={(e) => e.stopPropagation()}>
		<SongActionsMenu
			open={flags.menuOpen}
			canReorder={flags.canReorder}
			canRemove={flags.canRemove}
			canMoveOut={flags.canRemove}
			isFirst={flags.isFirst}
			isLast={flags.isLast}
			hasOtherPlaylists={flags.hasOtherPlaylists}
			class="opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:data-[state=open]:opacity-100"
			onOpenChange={actions.onMenuOpenChange}
			onAddToQueue={actions.onAddToQueue}
			onCopy={actions.onCopy}
			onMove={actions.onMove}
			onRemove={actions.onRemove}
			onDelete={actions.onDelete}
			onMoveUp={actions.onMoveUp}
			onMoveDown={actions.onMoveDown}
		/>
	</span>
</li>
