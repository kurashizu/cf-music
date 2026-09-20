<script lang="ts">
	import type { Snippet } from 'svelte';
	import { slide } from 'svelte/transition';
	import { motionParams } from '$lib/client/motion';
	import { Button } from '$lib/components/ui/button/index.js';
	import XIcon from '@lucide/svelte/icons/x';
	import ListPlusIcon from '@lucide/svelte/icons/list-plus';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';

	interface Props {
		count: number;
		/** Disables every action while a batch operation is running. */
		busy: boolean;
		/** Progress of a running batch download, or null when none is running. */
		downloadProgress: { completed: number; total: number } | null;
		onClear: () => void;
		onAddToQueue: () => void;
		onDownload: () => void;
		/** The page's own trailing buttons — copy, move, remove, delete. */
		actions: Snippet;
	}

	let { count, busy, downloadProgress, onClear, onAddToQueue, onDownload, actions }: Props =
		$props();
</script>

<!--
	Overlaid rather than inserted into the flow: taking layout space would push
	the list down the moment a song is selected, moving the row that was just
	clicked out from under the pointer — so a second click lands on a different
	song.

	The playlist and storage pages had verbatim copies of this, including the
	comment above; only the trailing action buttons ever differed, so those are
	a snippet.
-->
<div
	class="border-border bg-card sticky top-0 z-20 -mb-12 flex h-12 items-center justify-between gap-3 rounded-lg border px-3 shadow-sm"
	transition:slide={motionParams({ duration: 150 })}
>
	<div class="flex items-center gap-2">
		<Button variant="ghost" size="icon-sm" onclick={onClear} aria-label="Clear selection">
			<XIcon class="size-4" />
		</Button>
		<span class="text-muted-foreground text-sm">{count} selected</span>
	</div>
	<div class="flex items-center gap-2">
		<Button size="sm" variant="outline" class="gap-1.5" onclick={onAddToQueue}>
			<ListPlusIcon class="size-3.5" />
			Add to queue
		</Button>
		<Button size="sm" variant="outline" class="gap-1.5" disabled={busy} onclick={onDownload}>
			{#if downloadProgress}
				<LoaderCircleIcon class="size-3.5 animate-spin" />
				Downloading {downloadProgress.completed}/{downloadProgress.total}
			{:else}
				<DownloadIcon class="size-3.5" />
				Download
			{/if}
		</Button>
		{@render actions()}
	</div>
</div>
