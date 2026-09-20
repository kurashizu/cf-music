<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { untrack, onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import { player } from '$lib/client/player.svelte';
	import { motionParams } from '$lib/client/motion';
	import { viewMode } from '$lib/client/view-mode.svelte';
	import { PagedList } from '$lib/client/paged-list.svelte';
	import { SongSelection } from '$lib/client/song-selection.svelte';
	import { downloadSongForOffline, listCachedVideoIds } from '$lib/client/offline-cache';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import ViewModeToggle from '$lib/components/view-mode-toggle.svelte';
	import InfiniteScrollSentinel from '$lib/components/infinite-scroll-sentinel.svelte';
	import SongSortFilterBar from '$lib/components/song-sort-filter-bar.svelte';
	import SongRow from '$lib/components/song-row.svelte';
	import SongCard from '$lib/components/song-card.svelte';
	import type { SongRowActions, SongRowFlags } from '$lib/components/song-row-types';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import ShuffleIcon from '@lucide/svelte/icons/shuffle';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import ListPlusIcon from '@lucide/svelte/icons/list-plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import SearchIcon from '@lucide/svelte/icons/search';
	import XIcon from '@lucide/svelte/icons/x';
	import {
		sortIndices,
		matchesDurationRange,
		type SongSortField,
		type SortDirection
	} from '$lib/shared/song-sort-filter';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Song = (typeof data.playlist.songs)[number];

	const SORT_OPTIONS = [
		{ value: 'custom' as const, label: 'Custom order' },
		{ value: 'title' as const, label: 'Title' },
		{ value: 'artist' as const, label: 'Artist' },
		{ value: 'duration' as const, label: 'Duration' },
		{ value: 'addedAt' as const, label: 'Date added' }
	];

	async function fetchSongRange(offset: number, count: number): Promise<Song[]> {
		const response = await fetch(
			`/api/playlists/${data.playlist.id}/songs?offset=${offset}&limit=${count}`
		);
		if (!response.ok) return [];
		const body = (await response.json()) as { songs: Song[] };
		return body.songs;
	}

	// The pager is sized once, to the playlist as it stood at mount. Navigating
	// to a different playlist remounts this component, and a mutation to this
	// one arrives through the re-seed below.
	const list = new PagedList<Song>({
		total: untrack(() => data.totalSongCount),
		initial: untrack(() => data.playlist.songs),
		fetchRange: fetchSongRange
	});

	// Re-seed only when the server payload itself changes identity — navigating
	// to another playlist, or invalidateAll() after a mutation. Comparing
	// against the list's own contents instead would undo a local reorder the
	// moment it diverged from the server's copy.
	let lastServerSongs = untrack(() => data.playlist.songs);
	$effect(() => {
		if (data.playlist.songs !== lastServerSongs) {
			lastServerSongs = data.playlist.songs;
			list.reset(data.playlist.songs);
		}
	});

	const selection = new SongSelection();

	let cachedVideoIds = $state<Set<string>>(new Set());
	onMount(() => {
		listCachedVideoIds().then((ids) => {
			cachedVideoIds = new Set(ids);
		});
	});

	let searchQuery = $state('');
	let sortField = $state<SongSortField>('custom');
	let sortDirection = $state<SortDirection>('asc');
	let artistFilter = $state('all');
	let minDurationMinutes = $state('');
	let maxDurationMinutes = $state('');

	let openMenuVideoId = $state<string | null>(null);
	let downloadingVideoId = $state<string | null>(null);
	let draggingIndex = $state<number | null>(null);
	let dragOverIndex = $state<number | null>(null);

	let removeTarget = $state<{ videoId: string; title: string } | null>(null);
	let removeSubmitting = $state(false);
	let deleteTarget = $state<{ videoId: string; title: string } | null>(null);
	let deleteSubmitting = $state(false);
	let batchRemoveConfirm = $state(false);
	let batchDeleteConfirm = $state(false);
	let batchWorking = $state(false);
	// Separate from batchWorking because a download reports how many of the
	// selection have finished, not merely that something is running.
	let batchDownloadProgress = $state<{ completed: number; total: number } | null>(null);

	// null means "act on the current selection"; a videoId means a single song
	// picked from its own row menu.
	let copyTarget = $state<string | null>(null);
	let copyDialogOpen = $state(false);
	let copyDialogMode = $state<'copy' | 'move'>('copy');
	let copySubmitting = $state(false);
	let copyingPlaylistId = $state<string | null>(null);

	// Auto-generated playlists (Artists groupings, play-history recommendations)
	// are read-only, matching assertNotAutoGenerated on the server. The default
	// playlist is equally protected from having songs removed out of it.
	const isAutoGenerated = $derived(data.playlist.kind === 'auto_generated');
	const isReadOnly = $derived(data.isDefaultPlaylist || isAutoGenerated);

	/** True while the list shows every song in its stored order. */
	const isCustomUnfilteredView = $derived(
		searchQuery.trim().length === 0 &&
			sortField === 'custom' &&
			artistFilter === 'all' &&
			minDurationMinutes.trim() === '' &&
			maxDurationMinutes.trim() === ''
	);

	// Searching, sorting and filtering all have to see the whole playlist to
	// give correct answers, so any view other than the stored order pulls
	// everything in first.
	$effect(() => {
		if (!isCustomUnfilteredView) list.loadAll();
	});

	const artistOptions = $derived(
		[
			...new Set(
				list.items
					.filter((song): song is Song => song !== undefined)
					.map((song) => song.artist)
					.filter((artist): artist is string => artist !== null)
			)
		].sort((a, b) => a.localeCompare(b))
	);

	/**
	 * Playlist positions to render, in display order.
	 *
	 * In the stored order this is just the window the pager holds. Any other
	 * view filters and sorts across everything loaded, which the effect above
	 * guarantees is the entire playlist by the time it matters.
	 */
	const renderIndices = $derived.by(() => {
		if (isCustomUnfilteredView) return list.windowIndices;

		const query = searchQuery.trim().toLowerCase();
		const minSeconds = minDurationMinutes.trim() === '' ? null : Number(minDurationMinutes) * 60;
		const maxSeconds = maxDurationMinutes.trim() === '' ? null : Number(maxDurationMinutes) * 60;

		const matching = list.items
			.map((song, index) => ({ song, index }))
			.filter((entry): entry is { song: Song; index: number } => entry.song !== undefined)
			.filter(({ song }) => {
				if (query.length > 0 && !song.title.toLowerCase().includes(query)) return false;
				if (artistFilter !== 'all' && song.artist !== artistFilter) return false;
				return matchesDurationRange(song.durationSeconds, { minSeconds, maxSeconds });
			})
			.map(({ index }) => index);

		return sortIndices(list.items as Song[], matching, sortField, sortDirection);
	});

	const renderVideoIds = $derived(renderIndices.map((index) => list.items[index]!.videoId));
	const allRenderedSelected = $derived(
		renderVideoIds.length > 0 && renderVideoIds.every((videoId) => selection.has(videoId))
	);

	const isThisPlaylistPlaying = $derived(
		player.isPlaying &&
			list.items.some((song) => song?.videoId === player.currentTrack?.videoId)
	);

	/** Reordering rewrites the playlist's whole order, so it needs every song. */
	const canReorder = $derived(!isAutoGenerated && isCustomUnfilteredView && list.isComplete);

	function loadedSongs(): Song[] {
		return list.items.filter((song): song is Song => song !== undefined);
	}

	function toQueueTracks() {
		return loadedSongs().map((song) => ({
			videoId: song.videoId,
			title: song.title,
			durationSeconds: song.durationSeconds
		}));
	}

	async function playAll(shuffle = false) {
		if (data.totalSongCount === 0) return;
		await list.loadAll();
		await player.playQueue(toQueueTracks(), 0, shuffle);
	}

	async function playFrom(index: number) {
		const song = list.items[index];
		if (!song) return;
		if (player.currentTrack?.videoId === song.videoId) {
			await player.togglePlayPause();
			return;
		}
		// The queue is the whole playlist, so the position to start from is
		// resolved against the full list rather than the rendered window.
		await list.loadAll();
		const queueIndex = loadedSongs().findIndex((candidate) => candidate.videoId === song.videoId);
		await player.playQueue(toQueueTracks(), Math.max(0, queueIndex));
	}

	async function addToQueue(index: number) {
		const song = list.items[index];
		if (!song) return;
		await player.addToQueue([
			{ videoId: song.videoId, title: song.title, durationSeconds: song.durationSeconds }
		]);
		toast.success('Added to queue');
	}

	async function addSelectionToQueue() {
		const tracks = loadedSongs()
			.filter((song) => selection.has(song.videoId))
			.map((song) => ({
				videoId: song.videoId,
				title: song.title,
				durationSeconds: song.durationSeconds
			}));
		if (tracks.length === 0) return;
		await player.addToQueue(tracks);
		toast.success(`Added ${tracks.length} song(s) to queue`);
		selection.clear();
	}

	function openCopyDialog(target: string | null, mode: 'copy' | 'move') {
		copyTarget = target;
		copyDialogMode = mode;
		copyDialogOpen = true;
	}

	async function handleRemove() {
		if (!removeTarget) return;
		removeSubmitting = true;
		try {
			const response = await fetch(
				`/api/playlists/${data.playlist.id}/songs/${removeTarget.videoId}`,
				{ method: 'DELETE' }
			);
			if (!response.ok) {
				toast.error('Failed to remove song');
				return;
			}
			toast.success('Removed from playlist');
			removeTarget = null;
			await invalidateAll();
		} catch {
			toast.error('Failed to remove song');
		} finally {
			removeSubmitting = false;
		}
	}

	// Distinct from handleRemove: this deletes the song itself (see
	// DELETE /api/songs/[videoId] — evictSongForUser), not just its membership
	// in this playlist. It disappears from every playlist it was in, and its
	// storage is freed once nothing else references it.
	async function handleDelete() {
		if (!deleteTarget) return;
		deleteSubmitting = true;
		try {
			const response = await fetch(`/api/songs/${deleteTarget.videoId}`, { method: 'DELETE' });
			if (!response.ok) {
				toast.error('Failed to delete song');
				return;
			}
			toast.success('Song deleted');
			deleteTarget = null;
			await invalidateAll();
		} catch {
			toast.error('Failed to delete song');
		} finally {
			deleteSubmitting = false;
		}
	}

	async function handleCopyOrMove(toPlaylistId: string) {
		const isBatch = copyTarget === null;
		const videoIds = isBatch ? [...selection.ids] : [copyTarget];
		if (videoIds.length === 0) return;
		const mode = copyDialogMode;
		copySubmitting = true;
		copyingPlaylistId = toPlaylistId;
		try {
			const results = await Promise.all(
				videoIds.map((videoId) =>
					fetch(`/api/playlists/${data.playlist.id}/songs/${videoId}`, {
						method: 'PUT',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ toPlaylistId, mode })
					})
				)
			);
			const failures = results.filter((response) => !response.ok).length;
			const verb = mode === 'move' ? 'Moved' : 'Copied';
			toast[failures === 0 ? 'success' : 'error'](
				failures === 0
					? videoIds.length === 1
						? `${verb} to playlist`
						: `${verb} ${videoIds.length} songs`
					: `Failed to ${mode} ${failures} song(s)`
			);
			copyDialogOpen = false;
			copyTarget = null;
			if (mode === 'move' || isBatch) await invalidateAll();
			if (isBatch) selection.clear();
		} finally {
			copySubmitting = false;
			copyingPlaylistId = null;
		}
	}

	async function handleDownload(videoId: string) {
		// Already cached: re-requesting would presign a fresh stream URL only
		// for the service worker to satisfy it from its own cache.
		if (cachedVideoIds.has(videoId)) {
			toast.success('Already downloaded for offline playback');
			return;
		}
		downloadingVideoId = videoId;
		try {
			const ok = await downloadSongForOffline(videoId);
			if (ok) cachedVideoIds = new Set([...cachedVideoIds, videoId]);
			toast[ok ? 'success' : 'error'](
				ok ? 'Downloaded for offline playback' : 'Failed to download song'
			);
		} finally {
			downloadingVideoId = null;
		}
	}

	// Each download genuinely waits for the service worker to finish writing
	// (see offline-cache.ts), so starting every selected song at once would
	// pile dozens of large concurrent fetches onto the S3 origin. Fully serial
	// would be needlessly slow for a large selection.
	const BATCH_DOWNLOAD_CONCURRENCY = 3;
	async function downloadWithLimitedConcurrency(
		videoIds: string[],
		onEachSettled: (videoId: string, ok: boolean) => void
	): Promise<void> {
		let nextIndex = 0;
		async function worker(): Promise<void> {
			while (nextIndex < videoIds.length) {
				const videoId = videoIds[nextIndex++];
				const ok = await downloadSongForOffline(videoId);
				onEachSettled(videoId, ok);
			}
		}
		await Promise.all(
			Array.from({ length: Math.min(BATCH_DOWNLOAD_CONCURRENCY, videoIds.length) }, worker)
		);
	}

	async function handleBatchDownload() {
		// Cached songs are skipped so the progress count reflects work that is
		// actually happening.
		const videoIds = [...selection.ids].filter((videoId) => !cachedVideoIds.has(videoId));
		if (videoIds.length === 0) {
			toast.success('Already downloaded for offline playback');
			selection.clear();
			return;
		}
		batchWorking = true;
		batchDownloadProgress = { completed: 0, total: videoIds.length };
		try {
			let failures = 0;
			const downloaded = new Set(cachedVideoIds);
			await downloadWithLimitedConcurrency(videoIds, (videoId, ok) => {
				if (ok) downloaded.add(videoId);
				else failures++;
				cachedVideoIds = new Set(downloaded);
				if (batchDownloadProgress) batchDownloadProgress.completed++;
			});
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

	async function handleBatchRemove() {
		batchWorking = true;
		try {
			const results = await Promise.all(
				[...selection.ids].map((videoId) =>
					fetch(`/api/playlists/${data.playlist.id}/songs/${videoId}`, { method: 'DELETE' })
				)
			);
			const failures = results.filter((response) => !response.ok).length;
			toast[failures === 0 ? 'success' : 'error'](
				failures === 0 ? 'Removed from playlist' : `Failed to remove ${failures} song(s)`
			);
			batchRemoveConfirm = false;
			selection.clear();
			await invalidateAll();
		} finally {
			batchWorking = false;
		}
	}

	async function handleBatchDelete() {
		batchWorking = true;
		try {
			const results = await Promise.all(
				[...selection.ids].map((videoId) => fetch(`/api/songs/${videoId}`, { method: 'DELETE' }))
			);
			const failures = results.filter((response) => !response.ok).length;
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

	/**
	 * Where a row sits while a drag is in progress.
	 *
	 * Rows are shifted with CSS `order` rather than by splicing the list, so the
	 * keyed DOM node the browser is tracking mid-drag never moves — splicing it
	 * made focus and hover state jump around. The list is only really reordered
	 * on drop.
	 */
	function dragOrderFor(index: number): number | null {
		if (draggingIndex === null || dragOverIndex === null) return null;
		if (draggingIndex === index) return index;
		if (draggingIndex < dragOverIndex) {
			if (index > draggingIndex && index <= dragOverIndex) return index - 1;
		} else if (index >= dragOverIndex && index < draggingIndex) {
			return index + 1;
		}
		return index;
	}

	/** Writes the playlist's full order to the server, reverting on failure. */
	async function persistReorder() {
		try {
			const response = await fetch(`/api/playlists/${data.playlist.id}/reorder`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ orderedVideoIds: loadedSongs().map((song) => song.videoId) })
			});
			if (!response.ok) {
				toast.error('Failed to save the new order');
				await invalidateAll();
			}
		} catch {
			toast.error('Failed to save the new order');
			await invalidateAll();
		}
	}

	/**
	 * Moves one song within the playlist.
	 *
	 * Guarded on the whole list being held rather than trusting callers: the
	 * move rewrites every position, so doing it over a partially loaded list
	 * would submit an order missing the songs that were never fetched.
	 */
	async function moveSong(fromIndex: number, toIndex: number) {
		if (!list.isComplete) return;
		if (toIndex < 0 || toIndex >= data.totalSongCount || fromIndex === toIndex) return;
		const reordered = loadedSongs();
		const [moved] = reordered.splice(fromIndex, 1);
		reordered.splice(toIndex, 0, moved);
		list.reset(reordered);
		await persistReorder();
	}

	async function handleDragEnd() {
		const from = draggingIndex;
		const to = dragOverIndex;
		draggingIndex = null;
		dragOverIndex = null;
		if (from === null || to === null || from === to) return;
		await moveSong(from, to);
	}

	function rowFlags(index: number, song: Song): SongRowFlags {
		const isCurrent = player.currentTrack?.videoId === song.videoId;
		return {
			selected: selection.has(song.videoId),
			current: isCurrent,
			playing: player.isPlaying,
			cached: cachedVideoIds.has(song.videoId),
			downloading: downloadingVideoId === song.videoId,
			menuOpen: openMenuVideoId === song.videoId,
			// Dragging past the end of what is rendered would be meaningless, so
			// it stays off until the whole list is on screen.
			draggable: canReorder && renderIndices.length >= data.totalSongCount,
			dragging: draggingIndex === index,
			dragOrder: dragOrderFor(index),
			canReorder,
			canRemove: !isReadOnly,
			hasOtherPlaylists: data.otherPlaylists.length > 0,
			isFirst: index === 0,
			isLast: index === data.totalSongCount - 1
		};
	}

	function rowActions(index: number, song: Song): SongRowActions {
		return {
			onSelect: (event) => selection.click(song.videoId, event, renderVideoIds),
			onPlay: () => playFrom(index),
			onDownload: () => handleDownload(song.videoId),
			onMenuOpenChange: (open) => {
				openMenuVideoId = open ? song.videoId : null;
				// Move up/down rewrite the whole order, so the list has to be
				// complete by the time either is chosen.
				if (open && isCustomUnfilteredView) list.loadAll();
			},
			onAddToQueue: () => addToQueue(index),
			onCopy: () => openCopyDialog(song.videoId, 'copy'),
			onMove: () => openCopyDialog(song.videoId, 'move'),
			onRemove: () => (removeTarget = { videoId: song.videoId, title: song.title }),
			onDelete: () => (deleteTarget = { videoId: song.videoId, title: song.title }),
			onMoveUp: () => moveSong(index, index - 1),
			onMoveDown: () => moveSong(index, index + 1),
			onDragStart: () => {
				draggingIndex = index;
				dragOverIndex = index;
			},
			onDragOver: (event) => {
				event.preventDefault();
				if (draggingIndex !== null) dragOverIndex = index;
			},
			onDragEnd: handleDragEnd
		};
	}
</script>

<svelte:head>
	<title>{data.playlist.name} · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-screen-2xl p-4 md:p-8">
	<div class="mb-6 flex flex-wrap items-center justify-between gap-4">
		<div class="min-w-0">
			<h1 class="truncate text-lg font-medium">{data.playlist.name}</h1>
			<p class="text-sm text-muted-foreground">
				{data.totalSongCount}
				{data.totalSongCount === 1 ? 'song' : 'songs'}
				{data.isDefaultPlaylist ? '· Your whole library' : ''}
			</p>
		</div>
		<div class="flex items-center gap-2">
			<Button
				size="sm"
				class="gap-1.5"
				disabled={data.totalSongCount === 0}
				onclick={() => playAll()}
			>
				<!-- Fixed width: "Playing" is wider than "Play", and letting the
				     button resize slides Shuffle sideways mid-playback. -->
				{#if isThisPlaylistPlaying}
					<PauseIcon class="size-4" />
					<span class="w-12 text-left">Playing</span>
				{:else}
					<PlayIcon class="size-4" />
					<span class="w-12 text-left">Play</span>
				{/if}
			</Button>
			<Button
				size="sm"
				variant="outline"
				class="gap-1.5"
				disabled={data.totalSongCount === 0}
				onclick={() => playAll(true)}
			>
				<ShuffleIcon class="size-4" />
				Shuffle
			</Button>
		</div>
	</div>

	{#if data.totalSongCount > 0}
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<div class="relative min-w-48 flex-1">
				<SearchIcon class="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input placeholder="Search songs…" bind:value={searchQuery} class="pl-9" />
			</div>
			<SongSortFilterBar
				bind:sortField
				bind:sortDirection
				sortOptions={SORT_OPTIONS}
				bind:artistFilter
				{artistOptions}
				bind:minDurationMinutes
				bind:maxDurationMinutes
				showDurationFilter
			/>
			<Button size="sm" variant="outline" onclick={() => selection.toggleAll(renderVideoIds)}>
				{allRenderedSelected ? 'Deselect all' : 'Select all'}
			</Button>
			<ViewModeToggle />
		</div>
	{/if}

	<!-- Overlaid rather than inserted into the flow: taking layout space would
	     push the list down the moment a song is selected, moving the row that
	     was just clicked out from under the pointer — so a second click lands
	     on a different song. -->
	{#if selection.size > 0}
		<div
			class="sticky top-0 z-20 -mb-12 flex h-12 items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 shadow-sm"
			transition:slide={motionParams({ duration: 150 })}
		>
			<div class="flex items-center gap-2">
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={() => selection.clear()}
					aria-label="Clear selection"
				>
					<XIcon class="size-4" />
				</Button>
				<span class="text-sm text-muted-foreground">{selection.size} selected</span>
			</div>
			<div class="flex items-center gap-2">
				<Button size="sm" variant="outline" class="gap-1.5" onclick={addSelectionToQueue}>
					<ListPlusIcon class="size-3.5" />
					Add to queue
				</Button>
				<Button
					size="sm"
					variant="outline"
					class="gap-1.5"
					disabled={batchWorking}
					onclick={handleBatchDownload}
				>
					{#if batchDownloadProgress}
						<LoaderCircleIcon class="size-3.5 animate-spin" />
						Downloading {batchDownloadProgress.completed}/{batchDownloadProgress.total}
					{:else}
						<DownloadIcon class="size-3.5" />
						Download
					{/if}
				</Button>
				{#if data.otherPlaylists.length > 0}
					<Button
						size="sm"
						variant="outline"
						class="gap-1.5"
						disabled={batchWorking}
						onclick={() => openCopyDialog(null, 'copy')}
					>
						<ListMusicIcon class="size-3.5" />
						Copy to…
					</Button>
					{#if !isReadOnly}
						<Button
							size="sm"
							variant="outline"
							class="gap-1.5"
							disabled={batchWorking}
							onclick={() => openCopyDialog(null, 'move')}
						>
							<ListMusicIcon class="size-3.5" />
							Move to…
						</Button>
					{/if}
				{/if}
				{#if !isReadOnly}
					<Button
						size="sm"
						variant="outline"
						class="gap-1.5"
						disabled={batchWorking}
						onclick={() => (batchRemoveConfirm = true)}
					>
						<ListMusicIcon class="size-3.5" />
						Remove
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
			</div>
		</div>
	{/if}

	{#if data.totalSongCount === 0}
		<div
			class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center"
		>
			<ListMusicIcon class="size-8 text-muted-foreground" />
			<p class="text-sm text-muted-foreground">
				This playlist is empty. Import some songs to get started.
			</p>
		</div>
	{:else if renderIndices.length === 0}
		<p class="py-8 text-center text-sm text-muted-foreground">
			{searchQuery.trim().length > 0
				? `No songs match "${searchQuery}".`
				: 'No songs match the current filters.'}
		</p>
	{:else if viewMode.mode === 'grid'}
		<div
			class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8"
		>
			{#each renderIndices as index (list.items[index]!.videoId)}
				{@const song = list.items[index]!}
				<SongCard {song} flags={rowFlags(index, song)} actions={rowActions(index, song)} />
			{/each}
		</div>
		{#if list.hasMore && isCustomUnfilteredView}
			<InfiniteScrollSentinel onIntersect={() => list.extend()} />
		{/if}
	{:else}
		<ul class="flex flex-col">
			{#each renderIndices as index (list.items[index]!.videoId)}
				{@const song = list.items[index]!}
				<SongRow {song} flags={rowFlags(index, song)} actions={rowActions(index, song)} />
			{/each}
		</ul>
		{#if list.hasMore && isCustomUnfilteredView}
			<InfiniteScrollSentinel onIntersect={() => list.extend()} />
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
			<Dialog.Title>{copyDialogMode === 'move' ? 'Move' : 'Copy'} to playlist</Dialog.Title>
			<Dialog.Description>
				{copyTarget !== null ? 'This song' : `${selection.size} song(s)`}
				{copyDialogMode === 'move'
					? 'will be moved to the playlist you pick, removed from here.'
					: 'will also be added to the playlist you pick — it stays here too.'}
			</Dialog.Description>
		</Dialog.Header>
		<ul class="flex max-h-64 flex-col gap-1 overflow-y-auto">
			{#each data.otherPlaylists as playlist (playlist.id)}
				<li>
					<Button
						variant="outline"
						class="w-full justify-start gap-2"
						disabled={copySubmitting}
						onclick={() => handleCopyOrMove(playlist.id)}
					>
						{#if copyingPlaylistId === playlist.id}
							<LoaderCircleIcon class="size-3.5 animate-spin" />
						{/if}
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

<Dialog.Root open={removeTarget !== null} onOpenChange={(open) => !open && (removeTarget = null)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Remove "{removeTarget?.title}"?</Dialog.Title>
			<Dialog.Description>This only removes it from this playlist.</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (removeTarget = null)}>Cancel</Button>
			<Button variant="destructive" disabled={removeSubmitting} onclick={handleRemove}>
				{removeSubmitting ? 'Removing…' : 'Remove'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root
	open={batchRemoveConfirm}
	onOpenChange={(open) => !open && (batchRemoveConfirm = false)}
>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Remove {selection.size} songs?</Dialog.Title>
			<Dialog.Description>This only removes them from this playlist.</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (batchRemoveConfirm = false)}>Cancel</Button>
			<Button variant="destructive" disabled={batchWorking} onclick={handleBatchRemove}>
				{batchWorking ? 'Removing…' : 'Remove'}
			</Button>
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
				This deletes them from your library entirely, not just this playlist. This can't be undone.
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

<Dialog.Root open={deleteTarget !== null} onOpenChange={(open) => !open && (deleteTarget = null)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Delete "{deleteTarget?.title}"?</Dialog.Title>
			<Dialog.Description>
				This deletes the song from your library entirely, not just this playlist — it disappears from
				every playlist it's in. This can't be undone.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteTarget = null)}>Cancel</Button>
			<Button variant="destructive" disabled={deleteSubmitting} onclick={handleDelete}>
				{deleteSubmitting ? 'Deleting…' : 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
