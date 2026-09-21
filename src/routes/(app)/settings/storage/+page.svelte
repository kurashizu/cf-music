<script lang="ts">
	import { formatBytes } from '$lib/shared/format';
	import { apiErrorMessage } from '$lib/client/api-error';
	import SearchField from '$lib/components/search-field.svelte';
	import { untrack, onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import { player } from '$lib/client/player.svelte';
	import { viewMode } from '$lib/client/view-mode.svelte';
	import ViewModeToggle from '$lib/components/view-mode-toggle.svelte';
	import SongRow from '$lib/components/song-row.svelte';
	import SongCard from '$lib/components/song-card.svelte';
	import SongSortFilterBar from '$lib/components/song-sort-filter-bar.svelte';
	import SelectionToolbar from '$lib/components/selection-toolbar.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import { SongSelection } from '$lib/client/song-selection.svelte';
	import { sortSongs, type SongSortField, type SortDirection } from '$lib/shared/song-sort-filter';
	import type { SongRowActions, SongRowData, SongRowFlags } from '$lib/components/song-row-types';
	import {
		reconcileAudioCache,
		listCachedVideoIds,
		clearCachedAudio,
		downloadSongForOffline,
		downloadSongsForOffline,
		backfillTrackMetadata,
		estimateBrowserStorage,
		type StorageEstimate
	} from '$lib/client/offline-cache';
	import InfiniteScrollSentinel from '$lib/components/infinite-scroll-sentinel.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let entries = $state(untrack(() => data.entries));
	let cachedVideoIds = $state<Set<string>>(new Set());
	// Disables a row's controls while any operation is running on it —
	// download, clear or delete alike. Distinct from downloadingVideoId,
	// which the row uses to show a spinner specifically for a download and
	// must not light up during a delete.
	let workingVideoId = $state<string | null>(null);
	let downloadingVideoId = $state<string | null>(null);
	let openMenuVideoId = $state<string | null>(null);
	let browserStorage = $state<StorageEstimate | null>(null);

	const selection = new SongSelection();
	let batchWorking = $state(false);
	// Separate from batchWorking so a download can report how far through the
	// selection it is; every other batch action completes in one step.
	let batchDownloadProgress = $state<{ completed: number; total: number } | null>(null);
	let batchDeleteConfirm = $state(false);
	let searchQuery = $state('');
	let copyTarget = $state<string | null>(null); // videoId, or null when copying the current selection
	let copyDialogOpen = $state(false);
	let copySubmitting = $state(false);

	function openCopyDialogForSong(videoId: string) {
		copyTarget = videoId;
		copyDialogOpen = true;
	}

	function openCopyDialogForSelection() {
		copyTarget = null;
		copyDialogOpen = true;
	}

	// Storage-specific fields sit alongside the ones every list sorts by, so
	// this page uses the same bar and the same comparator as the playlist
	// page rather than a parallel dropdown with directions baked into each
	// option. "Downloaded first" is deliberately absent: whether a song is
	// cached is browser state, not a property of the song, so it stays the
	// separate toggle below where it can't be mistaken for one.
	const SORT_OPTIONS = [
		{ value: 'fileSize' as const, label: 'File size' },
		{ value: 'title' as const, label: 'Title' },
		{ value: 'artist' as const, label: 'Artist' },
		{ value: 'duration' as const, label: 'Duration' },
		{ value: 'addedAt' as const, label: 'Date imported' },
		{ value: 'playCount' as const, label: 'Play count' },
		{ value: 'lastPlayedAt' as const, label: 'Last played' }
	];
	let sortField = $state<SongSortField>('fileSize');
	let sortDirection = $state<SortDirection>('desc');
	let artistFilter = $state('all');
	let cachedOnly = $state(false);

	const artistOptions = $derived(
		[...new Set(entries.map((e) => e.artist).filter((a): a is string => a !== null))].sort((a, b) =>
			a.localeCompare(b)
		)
	);

	const filteredEntries = $derived.by(() => {
		const query = searchQuery.trim().toLowerCase();
		const matching = entries.filter((entry) => {
			if (query.length > 0 && !entry.title.toLowerCase().includes(query)) return false;
			if (cachedOnly && !cachedVideoIds.has(entry.videoId)) return false;
			if (artistFilter !== 'all' && entry.artist !== artistFilter) return false;
			return true;
		});
		// importedAt is this page's "date added" — the song's own import date,
		// since a library-wide view has no one playlist whose membership date
		// would otherwise apply.
		return sortSongs(
			matching.map((entry) => ({ ...entry, addedAt: entry.importedAt })),
			sortField,
			sortDirection
		);
	});

	const filteredVideoIds = $derived(filteredEntries.map((e) => e.videoId));

	const PAGE_SIZE = 20;
	let visibleCount = $state(PAGE_SIZE);
	// Resets to one page whenever the filtered/sorted set changes shape —
	// otherwise a new search query would just be sliced at whatever count
	// scrolling had already reached for the *previous* query.
	$effect(() => {
		filteredEntries;
		visibleCount = PAGE_SIZE;
	});
	const visibleEntries = $derived(filteredEntries.slice(0, visibleCount));
	const visibleVideoIds = $derived(visibleEntries.map((e) => e.videoId));
	function loadMore() {
		visibleCount = Math.min(filteredEntries.length, visibleCount + PAGE_SIZE);
	}

	const allFilteredSelected = $derived(
		filteredVideoIds.length > 0 && filteredVideoIds.every((id) => selection.has(id))
	);

	const usagePercent = $derived(
		data.quotaBytes > 0 ? Math.min(100, (data.usageBytes / data.quotaBytes) * 100) : 0
	);
	const browserUsagePercent = $derived(
		browserStorage && data.quotaBytes > 0
			? Math.min(100, (browserStorage.usageBytes / data.quotaBytes) * 100)
			: 0
	);

	onMount(() => {
		estimateBrowserStorage().then((estimate) => {
			browserStorage = estimate;
		});

		// Reconciles the service worker's audio cache against this page's
		// own account-storage view of the library — see reconcileAudioCache
		// for why a song removed from the library entirely can otherwise
		// leave its cached bytes behind forever.
		reconcileAudioCache(entries.map((e) => e.videoId));

		listCachedVideoIds().then((ids) => {
			cachedVideoIds = new Set(ids);
		});

		// Songs downloaded before metadata was recorded have no title of their
		// own, so they list as a raw id offline. This page holds the whole
		// library, which is the only place those names exist.
		void backfillTrackMetadata(
			entries.map((entry) => ({
				videoId: entry.videoId,
				title: entry.title,
				durationSeconds: entry.durationSeconds
			}))
		);
	});

	/** Adapts a library entry to what the shared row and card render. */
	function toRowData(entry: (typeof entries)[number]): SongRowData {
		return {
			videoId: entry.videoId,
			title: entry.title,
			durationSeconds: entry.durationSeconds,
			coverUrl: entry.coverUrl,
			codec: entry.codec,
			bitrateKbps: null,
			embeddingStatus: null,
			detail: formatBytes(entry.fileSizeBytes)
		};
	}

	function rowFlags(entry: (typeof entries)[number]): SongRowFlags {
		return {
			selected: selection.has(entry.videoId),
			current: player.currentTrack?.videoId === entry.videoId,
			playing: player.isPlaying,
			cached: cachedVideoIds.has(entry.videoId),
			downloading: downloadingVideoId === entry.videoId,
			busy: workingVideoId === entry.videoId,
			menuOpen: openMenuVideoId === entry.videoId,
			// This page spans the whole library rather than one ordered
			// playlist, so there is no stored order to drag against and
			// nothing to remove a song *from* short of deleting it.
			draggable: false,
			dragging: false,
			dragOrder: null,
			reorderable: false,
			canReorder: false,
			canRemove: false,
			canCopy: true,
			isFirst: false,
			isLast: false,
			canClearCache: cachedVideoIds.has(entry.videoId)
		};
	}

	function rowActions(entry: (typeof entries)[number]): SongRowActions {
		const noop = () => {};
		return {
			// Shift-selects against what is on screen, so a range means what it
			// looks like; "Select all" below works on the whole filtered set.
			onSelect: (event) => selection.click(entry.videoId, event, visibleVideoIds),
			onPlay: () => playEntry(entry),
			onDownload: () => handleDownload(entry.videoId),
			onMenuOpenChange: (open) => (openMenuVideoId = open ? entry.videoId : null),
			onAddToQueue: () => addToQueue([entry.videoId]),
			onCopy: () => openCopyDialogForSong(entry.videoId),
			onClearCache: () => handleClearCached(entry.videoId),
			onDelete: () => handleDeleteOne(entry.videoId),
			onMove: noop,
			onRemove: noop,
			onMoveUp: noop,
			onMoveDown: noop,
			onDragStart: noop,
			onDragOver: noop,
			onDragEnd: noop
		};
	}

	function toQueueTracks(videoIds: string[]) {
		const byId = new Map(entries.map((e) => [e.videoId, e]));
		return videoIds
			.map((videoId) => byId.get(videoId))
			.filter((entry): entry is (typeof entries)[number] => entry !== undefined)
			.map((entry) => ({
				videoId: entry.videoId,
				title: entry.title,
				durationSeconds: entry.durationSeconds
			}));
	}

	async function addToQueue(videoIds: string[]) {
		const tracks = toQueueTracks(videoIds);
		if (tracks.length === 0) return;
		await player.addToQueue(tracks);
		toast.success(tracks.length === 1 ? 'Added to queue' : `Added ${tracks.length} songs to queue`);
	}

	async function addSelectionToQueue() {
		await addToQueue([...selection.ids]);
		selection.clear();
	}

	async function playEntry(entry: {
		videoId: string;
		title: string;
		durationSeconds: number | null;
	}) {
		if (player.currentTrack?.videoId === entry.videoId) {
			await player.togglePlayPause();
			return;
		}
		// Plays the list as it currently reads, from the song clicked — the
		// filtered, sorted order on screen is the only ordering this page has,
		// and starting a lone single-track queue would strand the reader with
		// nothing to play next.
		const tracks = toQueueTracks(filteredVideoIds);
		const startIndex = tracks.findIndex((track) => track.videoId === entry.videoId);
		await player.playQueue(tracks, Math.max(0, startIndex));
	}

	async function handleDownload(videoId: string) {
		// Already cached: re-requesting would presign a fresh stream URL only
		// for the service worker to satisfy it from its own cache.
		if (cachedVideoIds.has(videoId)) {
			toast.success('Already downloaded for offline playback');
			return;
		}
		workingVideoId = videoId;
		downloadingVideoId = videoId;
		try {
			const entry = entries.find((e) => e.videoId === videoId);
			const ok = await downloadSongForOffline(
				videoId,
				entry && { title: entry.title, durationSeconds: entry.durationSeconds }
			);
			if (ok) cachedVideoIds = new Set([...cachedVideoIds, videoId]);
			toast[ok ? 'success' : 'error'](
				ok ? 'Downloaded for offline playback' : 'Failed to download song'
			);
		} finally {
			workingVideoId = null;
			downloadingVideoId = null;
		}
	}

	async function handleClearCached(videoId: string) {
		workingVideoId = videoId;
		try {
			await clearCachedAudio([videoId]);
			cachedVideoIds = new Set([...cachedVideoIds].filter((id) => id !== videoId));
			toast.success('Removed from offline cache');
		} catch {
			toast.error('Failed to remove from offline cache');
		} finally {
			workingVideoId = null;
		}
	}

	async function handleDeleteOne(videoId: string) {
		workingVideoId = videoId;
		try {
			const response = await fetch(`/api/songs/${videoId}`, { method: 'DELETE' });
			if (!response.ok) {
				toast.error(await apiErrorMessage(response, 'Failed to delete song'));
				return;
			}
			entries = entries.filter((e) => e.videoId !== videoId);
			cachedVideoIds = new Set([...cachedVideoIds].filter((id) => id !== videoId));
			selection.retain(new Set(entries.map((e) => e.videoId)));
			toast.success('Song deleted');
			await invalidateAll();
		} catch {
			toast.error('Failed to delete song');
		} finally {
			workingVideoId = null;
		}
	}

	async function handleBatchDownload() {
		// Skip anything already cached rather than re-requesting a fresh
		// stream URL for a cache.match the service worker would satisfy
		// immediately — with a large selection that is a lot of pointless
		// API calls, and it also made the progress count include songs that
		// were never going to download anything.
		const videoIds = [...selection.ids].filter((id) => !cachedVideoIds.has(id));
		if (videoIds.length === 0) {
			toast.success('Already downloaded for offline playback');
			selection.clear();
			return;
		}
		batchWorking = true;
		batchDownloadProgress = { completed: 0, total: videoIds.length };
		try {
			let failures = 0;
			const metadataFor = (videoId: string) => {
				const entry = entries.find((e) => e.videoId === videoId);
				return entry && { title: entry.title, durationSeconds: entry.durationSeconds };
			};
			await downloadSongsForOffline(
				videoIds,
				(videoId, ok) => {
					// Merged into whatever is current rather than into a set
					// snapshotted before the batch began: a single download
					// finishing mid-batch would otherwise be erased when the
					// next one settles. A fresh Set each time because
					// reassigning the same reference is not a change as far as
					// reactivity is concerned.
					if (ok) cachedVideoIds = new Set([...cachedVideoIds, videoId]);
					else failures++;
					if (batchDownloadProgress) batchDownloadProgress.completed++;
				},
				metadataFor
			);
			toast[failures === 0 ? 'success' : 'error'](
				failures === 0
					? 'Downloaded for offline playback'
					: `Failed to download ${failures} song(s)`
			);
			selection.clear();
		} finally {
			batchWorking = false;
			batchDownloadProgress = null;
		}
	}

	async function handleBatchClearCached() {
		batchWorking = true;
		try {
			const ids = [...selection.ids];
			await clearCachedAudio(ids);
			cachedVideoIds = new Set([...cachedVideoIds].filter((id) => !selection.has(id)));
			toast.success('Removed from offline cache');
			selection.clear();
		} catch {
			toast.error('Failed to remove from offline cache');
		} finally {
			batchWorking = false;
		}
	}

	// copyTarget === null means "copy the current selection"; otherwise it's a
	// single song's videoId. Always adds and never removes — this page spans
	// the whole library, not one playlist, so there is no source a move could
	// take the song out of.
	async function handleCopy(toPlaylistId: string) {
		const isBatchCopy = copyTarget === null;
		const videoIds = isBatchCopy ? [...selection.ids] : [copyTarget];
		if (videoIds.length === 0) return;
		copySubmitting = true;
		try {
			// allSettled, not all: a dropped connection rejects Promise.all
			// outright, leaving the dialog open with no toast for a copy that
			// partly went through.
			const results = await Promise.allSettled(
				videoIds.map((videoId) =>
					fetch(`/api/playlists/${toPlaylistId}/songs`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ videoId })
					})
				)
			);
			const failures = results.filter((r) => r.status === 'rejected' || !r.value.ok).length;
			toast[failures === 0 ? 'success' : 'error'](
				failures === 0
					? videoIds.length === 1
						? 'Copied to playlist'
						: `Copied ${videoIds.length} songs`
					: `Failed to copy ${failures} song(s)`
			);
			copyDialogOpen = false;
			copyTarget = null;
			if (isBatchCopy) selection.clear();
		} finally {
			copySubmitting = false;
		}
	}

	async function handleBatchDelete() {
		batchWorking = true;
		try {
			// allSettled, not all: a dropped connection part-way through rejects
			// Promise.all outright, so the toast, the local pruning and the
			// refetch below are all skipped and the reader is told nothing at
			// all about a batch that partly went through.
			const results = await Promise.allSettled(
				[...selection.ids].map((videoId) => fetch(`/api/songs/${videoId}`, { method: 'DELETE' }))
			);
			const failures = results.filter((r) => r.status === 'rejected' || !r.value.ok).length;
			entries = entries.filter((e) => !selection.has(e.videoId));
			cachedVideoIds = new Set([...cachedVideoIds].filter((id) => !selection.has(id)));
			toast[failures === 0 ? 'success' : 'error'](
				failures === 0 ? 'Songs deleted' : `Failed to delete ${failures} song(s)`
			);
			batchDeleteConfirm = false;
			selection.clear();
			await invalidateAll();
		} finally {
			batchWorking = false;
		}
	}
</script>

<svelte:head>
	<title>Manage storage · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-screen-2xl p-4 md:p-8">
	<div class="mb-6 flex items-center gap-2">
		<Button href="/settings" variant="ghost" size="sm" class="-ml-2">← Settings</Button>
	</div>
	<h1 class="mb-6 text-lg font-medium">Manage storage</h1>

	<div class="border-border mb-4 rounded-xl border p-4">
		<div class="mb-2 flex items-center justify-between text-sm">
			<span class="text-muted-foreground flex items-center gap-1.5">
				<HardDriveIcon class="size-4" />
				Account storage (cloud)
			</span>
			<span class="text-muted-foreground"
				>{formatBytes(data.usageBytes)} / {formatBytes(data.quotaBytes)}</span
			>
		</div>
		<div class="bg-muted h-1.5 overflow-hidden rounded-full">
			<div
				class="bg-foreground h-full transition-all duration-300"
				style="width: {usagePercent}%"
			></div>
		</div>
	</div>

	<div class="border-border mb-6 rounded-xl border p-4">
		<div class="mb-2 flex items-center justify-between text-sm">
			<span class="text-muted-foreground flex items-center gap-1.5">
				<GlobeIcon class="size-4" />
				Browser offline cache (this device)
			</span>
			{#if browserStorage}
				<span class="text-muted-foreground">
					{formatBytes(browserStorage.usageBytes)} / {formatBytes(data.quotaBytes)}
				</span>
			{/if}
		</div>
		{#if browserStorage}
			<div class="bg-muted h-1.5 overflow-hidden rounded-full">
				<div
					class="bg-foreground h-full transition-all duration-300"
					style="width: {browserUsagePercent}%"
				></div>
			</div>
		{:else}
			<p class="text-muted-foreground text-xs">Not available in this browser.</p>
		{/if}
		<p class="text-muted-foreground mt-2 text-xs">
			Download a song to keep it available for offline playback. Downloaded songs stay cached until
			you clear them here.
		</p>
	</div>

	{#if entries.length === 0}
		<EmptyState message="No songs in your library yet.">
			{#snippet icon()}
				<HardDriveIcon class="text-muted-foreground size-8" />
			{/snippet}
		</EmptyState>
	{:else}
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<SearchField bind:value={searchQuery} placeholder="Search songs…" />
			<SongSortFilterBar
				bind:sortField
				bind:sortDirection
				sortOptions={SORT_OPTIONS}
				bind:artistFilter
				{artistOptions}
				extraActiveFilters={cachedOnly ? 1 : 0}
			/>
			<Button
				size="sm"
				variant={cachedOnly ? 'default' : 'outline'}
				onclick={() => (cachedOnly = !cachedOnly)}
			>
				Downloaded only
			</Button>
			<Button size="sm" variant="outline" onclick={() => selection.toggleAll(filteredVideoIds)}>
				{allFilteredSelected ? 'Deselect all' : 'Select all'}
			</Button>
			<ViewModeToggle />
		</div>

		{#if selection.size > 0}
			<SelectionToolbar
				count={selection.size}
				busy={batchWorking}
				downloadProgress={batchDownloadProgress}
				onClear={() => selection.clear()}
				onAddToQueue={addSelectionToQueue}
				onDownload={handleBatchDownload}
			>
				{#snippet actions()}
					<Button
						size="sm"
						variant="outline"
						class="gap-1.5"
						disabled={batchWorking}
						onclick={handleBatchClearCached}
					>
						<GlobeIcon class="size-3.5" />
						Clear cache
					</Button>
					{#if data.playlists.length > 0}
						<Button
							size="sm"
							variant="outline"
							class="gap-1.5"
							disabled={batchWorking}
							onclick={openCopyDialogForSelection}
						>
							<ListMusicIcon class="size-3.5" />
							Copy to…
						</Button>
					{/if}
					<Button
						size="sm"
						variant="destructive"
						class="gap-1.5"
						disabled={batchWorking}
						onclick={() => (batchDeleteConfirm = true)}
					>
						<Trash2Icon class="size-3.5" />
						Delete
					</Button>
				{/snippet}
			</SelectionToolbar>
		{/if}

		{#if filteredEntries.length === 0}
			<p class="text-muted-foreground py-8 text-center text-sm">
				{searchQuery.trim().length > 0
					? `No songs match "${searchQuery}".`
					: 'No songs match the current filters.'}
			</p>
		{:else if viewMode.mode === 'grid'}
			<div
				class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8"
			>
				{#each visibleEntries as entry (entry.videoId)}
					<SongCard song={toRowData(entry)} flags={rowFlags(entry)} actions={rowActions(entry)} />
				{/each}
			</div>
			{#if visibleCount < filteredEntries.length}
				<InfiniteScrollSentinel onIntersect={loadMore} />
			{/if}
		{:else}
			<ul class="flex flex-col">
				{#each visibleEntries as entry (entry.videoId)}
					<SongRow song={toRowData(entry)} flags={rowFlags(entry)} actions={rowActions(entry)} />
				{/each}
			</ul>
			{#if visibleCount < filteredEntries.length}
				<InfiniteScrollSentinel onIntersect={loadMore} />
			{/if}
		{/if}
	{/if}
</div>

<Dialog.Root
	open={copyDialogOpen}
	onOpenChange={(open) => {
		copyDialogOpen = open;
		if (!open) copyTarget = null;
	}}
>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Copy to playlist</Dialog.Title>
			<Dialog.Description>
				{copyTarget !== null ? 'This song' : `${selection.size} song(s)`} will be added to the playlist
				you pick.
			</Dialog.Description>
		</Dialog.Header>
		<ul class="flex max-h-64 flex-col gap-1 overflow-y-auto">
			{#each data.playlists as playlist (playlist.id)}
				<li>
					<Button
						variant="outline"
						class="w-full justify-start"
						disabled={copySubmitting}
						onclick={() => handleCopy(playlist.id)}
					>
						{playlist.name}
					</Button>
				</li>
			{/each}
		</ul>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (copyDialogOpen = false)}>Cancel</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root
	open={batchDeleteConfirm}
	onOpenChange={(open) => !open && (batchDeleteConfirm = false)}
>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Delete {selection.size} songs?</Dialog.Title>
			<Dialog.Description>
				This deletes them from your library entirely — they'll disappear from every playlist. This
				can't be undone.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (batchDeleteConfirm = false)}>Cancel</Button>
			<Button variant="destructive" disabled={batchWorking} onclick={handleBatchDelete}>
				{batchWorking ? 'Deleting…' : 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
