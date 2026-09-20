<script lang="ts">
	import ThrottledImage from '$lib/components/throttled-image.svelte';
	import SongActionsMenu from '$lib/components/song-actions-menu.svelte';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import MusicIcon from '@lucide/svelte/icons/music';
	import CheckIcon from '@lucide/svelte/icons/check';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { formatDuration } from '$lib/shared/format';
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
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="group relative flex flex-col gap-2 rounded-xl border border-transparent p-3 transition-colors active:bg-muted hover:bg-muted sm:p-4 {flags.selected
		? 'border-ring/50 bg-muted'
		: ''}"
	onclick={(e) => actions.onSelect(e)}
>
	<div class="relative aspect-square overflow-hidden rounded-lg bg-muted">
		{#if song.coverUrl}
			<ThrottledImage src={song.coverUrl} class="size-full" />
		{:else}
			<div class="flex size-full items-center justify-center">
				<MusicIcon class="size-8 text-muted-foreground" />
			</div>
		{/if}

		<!-- One badge in this corner at a time: a download in progress is the
		     more urgent of the two to report, and a song can't be mid-download
		     and already settled as cached. -->
		{#if flags.downloading}
			<span
				class="absolute top-1 left-1 flex items-center gap-0.5 rounded-full bg-black/75 px-1.5 py-0.5 text-[10px] text-white"
			>
				<LoaderCircleIcon class="size-2.5 animate-spin" />
				Downloading
			</span>
		{:else if flags.cached}
			<span
				class="absolute top-1 left-1 flex items-center gap-0.5 rounded-full bg-black/75 px-1.5 py-0.5 text-[10px] text-white"
			>
				<CheckIcon class="size-2.5" />
				Downloaded
			</span>
		{/if}
		{#if song.embeddingStatus === 'done'}
			<span
				class="absolute top-1 right-1 flex items-center rounded-full bg-black/75 p-1 text-white"
				title="Embedded"
				aria-label="Embedded"
			>
				<SparklesIcon class="size-2.5" />
			</span>
		{/if}

		<!-- Covers the whole cover, so anywhere on the artwork starts playback;
		     the visible circle is only an affordance. -->
		<button
			type="button"
			class="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors active:bg-black/40 sm:group-hover:bg-black/40"
			onclick={(e) => {
				e.stopPropagation();
				actions.onPlay();
			}}
			aria-label={flags.current && flags.playing ? 'Pause' : 'Play'}
		>
			<span
				class="flex size-9 items-center justify-center rounded-full bg-black/65 opacity-100 transition-opacity sm:bg-black/75 sm:opacity-0 sm:group-hover:opacity-100"
			>
				{#if flags.current && flags.playing}
					<PauseIcon class="size-4 text-white" />
				{:else}
					<PlayIcon class="size-4 text-white" />
				{/if}
			</span>
		</button>

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<span class="absolute right-1 bottom-1" onclick={(e) => e.stopPropagation()}>
			<SongActionsMenu
				open={flags.menuOpen}
				canReorder={flags.canReorder}
				canRemove={flags.canRemove}
				canMoveOut={flags.canRemove}
				isFirst={flags.isFirst}
				isLast={flags.isLast}
				hasOtherPlaylists={flags.hasOtherPlaylists}
				variant="secondary"
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
	</div>

	<div class="min-w-0">
		<p class="truncate text-sm {flags.current ? 'text-foreground' : 'text-foreground/90'}">
			{song.title}
		</p>
		<p class="truncate text-xs text-muted-foreground">
			{song.detail ?? formatDuration(song.durationSeconds)}
		</p>
	</div>
</div>
