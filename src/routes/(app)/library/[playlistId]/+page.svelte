<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { player } from '$lib/client/player.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import ShuffleIcon from '@lucide/svelte/icons/shuffle';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
	import MusicIcon from '@lucide/svelte/icons/music';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import XIcon from '@lucide/svelte/icons/x';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ListPlusIcon from '@lucide/svelte/icons/list-plus';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { untrack, onMount } from 'svelte';
	import { downloadSongForOffline, listCachedVideoIds } from '$lib/client/offline-cache';
	import { viewMode } from '$lib/client/view-mode.svelte';
	import ViewModeToggle from '$lib/components/view-mode-toggle.svelte';
	import InfiniteScrollSentinel from '$lib/components/infinite-scroll-sentinel.svelte';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let cachedVideoIds = $state<Set<string>>(new Set());
	onMount(() => {
		listCachedVideoIds().then((ids) => {
			cachedVideoIds = new Set(ids);
		});
	});

	// Mirrors data.playlist.songs into local mutable state so drag-to-reorder
	// can preview the new order instantly, before the PUT /reorder request
	// resolves. Re-synced only when the *server* value changes reference
	// (playlist navigation, or invalidateAll() after a remove) — comparing
	// against the local `songs` state itself would snap a live drag back to
	// the server order the instant it diverges, so the sync check reads
	// data.playlist.songs (reactive) without also depending on `songs`.
	let songs = $state(untrack(() => data.playlist.songs));
	let lastServerSongs = untrack(() => data.playlist.songs);
	$effect(() => {
		if (data.playlist.songs !== lastServerSongs) {
			lastServerSongs = data.playlist.songs;
			songs = data.playlist.songs;
		}
	});

	// draggingIndex/overIndex describe the drag purely in terms of the
	// *original* indices in `songs`. The list below renders using this
	// pair to compute each row's visual `order` (CSS), instead of
	// splicing `songs` itself on every dragover — splicing would move the
	// keyed DOM node the browser is actively tracking mid-drag, which is
	// what caused focus/hover state to jump around during a drag.
	// `songs` is only actually reordered once, on drop.
	let draggingIndex = $state<number | null>(null);
	let overIndex = $state<number | null>(null);
	let removeTarget = $state<{ videoId: string; title: string } | null>(null);
	let removeSubmitting = $state(false);
	let deleteTarget = $state<{ videoId: string; title: string } | null>(null);
	let deleteSubmitting = $state(false);
	let downloadingVideoId = $state<string | null>(null);
	let copyTarget = $state<string | null>(null); // videoId, or null when copying/moving the current selection
	let copyDialogOpen = $state(false);
	let copyDialogMode = $state<'copy' | 'move'>('copy');
	let copySubmitting = $state(false);

	function openCopyDialogForSong(videoId: string, mode: 'copy' | 'move') {
		copyTarget = videoId;
		copyDialogMode = mode;
		copyDialogOpen = true;
	}

	function openCopyDialogForSelection(mode: 'copy' | 'move') {
		copyTarget = null;
		copyDialogMode = mode;
		copyDialogOpen = true;
	}

	let selected = $state<Set<string>>(new Set());
	let batchWorking = $state(false);
	let batchRemoveConfirm = $state(false);
	let batchDeleteConfirm = $state(false);
	let searchQuery = $state('');

	// Indices into `songs`, filtered by title — drag-to-reorder (which is
	// index-based, see visualOrder/handleDragOver) only makes sense against
	// the full unfiltered order, so it's disabled while a search is active
	// rather than taught to reorder through a filtered view.
	const visibleIndices = $derived(
		searchQuery.trim().length === 0
			? songs.map((_, i) => i)
			: songs
					.map((s, i) => [s, i] as const)
					.filter(([s]) => s.title.toLowerCase().includes(searchQuery.trim().toLowerCase()))
					.map(([, i]) => i)
	);

	const PAGE_SIZE = 20;
	let visibleCount = $state(PAGE_SIZE);
	$effect(() => {
		visibleIndices;
		visibleCount = PAGE_SIZE;
	});
	// What's actually rendered — a further slice of visibleIndices. Drag
	// stays index-correct either way (visualOrder/handleDragOver work off
	// real indices into `songs`, not the windowed render position), but
	// it's disabled while windowed anyway (see `draggable` below) since
	// dragging a song past the last *rendered* row while more remain
	// unloaded below it would be confusing.
	const windowedIndices = $derived(visibleIndices.slice(0, visibleCount));
	function loadMore() {
		visibleCount = Math.min(visibleIndices.length, visibleCount + PAGE_SIZE);
	}

	let lastSelectedIndex = $state<number | null>(null);

	// "Select all" only ever targets what's actually visible (the filtered/
	// searched view) — selecting rows hidden by a search would be
	// surprising, since the toolbar's count wouldn't match what's on screen.
	const allVisibleSelected = $derived(
		visibleIndices.length > 0 && visibleIndices.every((i) => selected.has(songs[i].videoId))
	);

	function toggleSelectAll() {
		if (allVisibleSelected) {
			clearSelection();
			return;
		}
		selected = new Set(visibleIndices.map((i) => songs[i].videoId));
		lastSelectedIndex = visibleIndices[visibleIndices.length - 1] ?? null;
	}

	function toggleSelected(videoId: string) {
		const next = new Set(selected);
		if (next.has(videoId)) next.delete(videoId);
		else next.add(videoId);
		selected = next;
	}

	function clearSelection() {
		selected = new Set();
		lastSelectedIndex = null;
	}

	// File-manager-style row selection: plain click selects only this row,
	// ctrl/cmd-click toggles it into/out of the existing selection, and
	// shift-click extends the selection from the last click to here — all
	// against `visibleIndices` (the filtered/rendered order), since a range
	// select while searching should span what's on screen, not the full
	// underlying playlist.
	function handleRowClick(event: MouseEvent, index: number) {
		const videoId = songs[index].videoId;
		if (event.shiftKey && lastSelectedIndex !== null) {
			const [from, to] = [lastSelectedIndex, index].sort((a, b) => a - b);
			const range = visibleIndices.filter((i) => i >= from && i <= to);
			const next = new Set(selected);
			for (const i of range) next.add(songs[i].videoId);
			selected = next;
			return;
		}
		if (event.metaKey || event.ctrlKey) {
			toggleSelected(videoId);
			lastSelectedIndex = index;
			return;
		}
		selected = selected.size === 1 && selected.has(videoId) ? new Set() : new Set([videoId]);
		lastSelectedIndex = index;
	}

	const isThisPlaylistPlaying = $derived(
		player.isPlaying && songs.some((s) => s.videoId === player.currentTrack?.videoId)
	);

	function toQueueTracks() {
		return songs.map((s) => ({
			videoId: s.videoId,
			title: s.title,
			durationSeconds: s.durationSeconds
		}));
	}

	function formatDuration(seconds: number | null): string {
		if (seconds === null) return '—';
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${m}:${s.toString().padStart(2, '0')}`;
	}

	function formatAudioSpec(codec: string, bitrateKbps: number | null): string {
		return bitrateKbps ? `${codec} · ${bitrateKbps}kbps` : codec;
	}

	async function playAll(shuffle = false) {
		if (songs.length === 0) return;
		await player.playQueue(toQueueTracks(), 0, shuffle);
	}

	async function playFrom(index: number) {
		if (player.currentTrack?.videoId === songs[index].videoId) {
			await player.togglePlayPause();
			return;
		}
		await player.playQueue(toQueueTracks(), index);
	}

	async function addToQueue(index: number) {
		const song = songs[index];
		await player.addToQueue([
			{ videoId: song.videoId, title: song.title, durationSeconds: song.durationSeconds }
		]);
		toast.success('Added to queue');
	}

	async function addSelectionToQueue() {
		const tracks = songs
			.filter((s) => selected.has(s.videoId))
			.map((s) => ({ videoId: s.videoId, title: s.title, durationSeconds: s.durationSeconds }));
		if (tracks.length === 0) return;
		await player.addToQueue(tracks);
		toast.success(`Added ${tracks.length} song(s) to queue`);
		clearSelection();
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
	// DELETE /api/songs/[videoId] — evictSongForUser), not just its
	// membership in this one playlist. It disappears from every playlist
	// it was in, and its storage is freed if no one else still references
	// it (songs are deduplicated/shared across users' libraries).
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

	// copyTarget === null means "act on the current selection"; otherwise
	// it's a single song's videoId (from a row's own dropdown menu). Shared
	// by both Copy To and Move To — copyDialogMode decides which the
	// server actually does (see the PUT route's own mode handling).
	async function handleCopyOrMove(toPlaylistId: string) {
		const isBatch = copyTarget === null;
		const videoIds = isBatch ? [...selected] : [copyTarget];
		if (videoIds.length === 0) return;
		const mode = copyDialogMode;
		copySubmitting = true;
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
			const failures = results.filter((r) => !r.ok).length;
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
			if (isBatch) clearSelection();
		} finally {
			copySubmitting = false;
		}
	}

	async function handleDownload(videoId: string) {
		downloadingVideoId = videoId;
		try {
			const ok = await downloadSongForOffline(videoId);
			if (ok) cachedVideoIds = new Set([...cachedVideoIds, videoId]);
			toast[ok ? 'success' : 'error'](ok ? 'Downloaded for offline playback' : 'Failed to download song');
		} finally {
			downloadingVideoId = null;
		}
	}

	async function handleBatchDownload() {
		batchWorking = true;
		try {
			let failures = 0;
			const downloaded = new Set(cachedVideoIds);
			for (const videoId of selected) {
				const ok = await downloadSongForOffline(videoId);
				if (ok) downloaded.add(videoId);
				else failures++;
			}
			cachedVideoIds = downloaded;
			toast[failures === 0 ? 'success' : 'error'](
				failures === 0 ? 'Downloaded for offline playback' : `Failed to download ${failures} song(s)`
			);
			clearSelection();
		} finally {
			batchWorking = false;
		}
	}

	async function handleBatchRemove() {
		batchWorking = true;
		try {
			const results = await Promise.all(
				[...selected].map((videoId) =>
					fetch(`/api/playlists/${data.playlist.id}/songs/${videoId}`, { method: 'DELETE' })
				)
			);
			const failures = results.filter((r) => !r.ok).length;
			toast[failures === 0 ? 'success' : 'error'](
				failures === 0 ? 'Removed from playlist' : `Failed to remove ${failures} song(s)`
			);
			batchRemoveConfirm = false;
			clearSelection();
			await invalidateAll();
		} finally {
			batchWorking = false;
		}
	}

	async function handleBatchDelete() {
		batchWorking = true;
		try {
			const results = await Promise.all(
				[...selected].map((videoId) => fetch(`/api/songs/${videoId}`, { method: 'DELETE' }))
			);
			const failures = results.filter((r) => !r.ok).length;
			toast[failures === 0 ? 'success' : 'error'](
				failures === 0 ? 'Songs deleted' : `Failed to delete ${failures} song(s)`
			);
			batchDeleteConfirm = false;
			clearSelection();
			await invalidateAll();
		} finally {
			batchWorking = false;
		}
	}

	function handleDragStart(index: number) {
		draggingIndex = index;
		overIndex = index;
	}

	function handleDragOver(event: DragEvent, index: number) {
		event.preventDefault();
		if (draggingIndex === null) return;
		overIndex = index;
	}

	function visualOrder(index: number): number {
		if (draggingIndex === null || overIndex === null || draggingIndex === index) return index;
		if (draggingIndex < overIndex) {
			if (index > draggingIndex && index <= overIndex) return index - 1;
		} else if (index >= overIndex && index < draggingIndex) {
			return index + 1;
		}
		return index;
	}

	async function handleDragEnd() {
		if (draggingIndex !== null && overIndex !== null && draggingIndex !== overIndex) {
			const reordered = [...songs];
			const [moved] = reordered.splice(draggingIndex, 1);
			reordered.splice(overIndex, 0, moved);
			songs = reordered;
		}
		draggingIndex = null;
		overIndex = null;
		try {
			const response = await fetch(`/api/playlists/${data.playlist.id}/reorder`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ orderedVideoIds: songs.map((s) => s.videoId) })
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
</script>

<svelte:head>
	<title>{data.playlist.name} · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-3xl p-4 md:p-8">
	<div class="mb-6 flex flex-wrap items-center justify-between gap-4">
		<div class="min-w-0">
			<h1 class="truncate text-lg font-medium">{data.playlist.name}</h1>
			<p class="text-sm text-muted-foreground">
				{songs.length} {songs.length === 1 ? 'song' : 'songs'}
				{data.isDefaultPlaylist ? '· Your whole library' : ''}
			</p>
		</div>
		<div class="flex items-center gap-2">
			<Button size="sm" class="gap-1.5" disabled={songs.length === 0} onclick={() => playAll()}>
				{#if isThisPlaylistPlaying}
					<PauseIcon class="size-4" />
					Playing
				{:else}
					<PlayIcon class="size-4" />
					Play
				{/if}
			</Button>
			<Button
				size="sm"
				variant="outline"
				class="gap-1.5"
				disabled={songs.length === 0}
				onclick={() => playAll(true)}
			>
				<ShuffleIcon class="size-4" />
				Shuffle
			</Button>
		</div>
	</div>

	{#if songs.length > 0}
		<div class="mb-3 flex items-center gap-2">
			<div class="relative flex-1">
				<SearchIcon class="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input placeholder="Search songs…" bind:value={searchQuery} class="pl-9" />
			</div>
			<Button size="sm" variant="outline" onclick={toggleSelectAll}>
				{allVisibleSelected ? 'Deselect all' : 'Select all'}
			</Button>
			<ViewModeToggle />
		</div>
	{/if}

	{#if selected.size > 0}
		<div
			class="sticky top-0 z-10 mb-2 flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2"
		>
			<div class="flex items-center gap-2">
				<Button variant="ghost" size="icon-sm" onclick={clearSelection} aria-label="Clear selection">
					<XIcon class="size-4" />
				</Button>
				<span class="text-sm text-muted-foreground">{selected.size} selected</span>
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
					<DownloadIcon class="size-3.5" />
					Download
				</Button>
				{#if data.otherPlaylists.length > 0}
					<Button
						size="sm"
						variant="outline"
						class="gap-1.5"
						disabled={batchWorking}
						onclick={() => openCopyDialogForSelection('copy')}
					>
						<ListMusicIcon class="size-3.5" />
						Copy to…
					</Button>
					{#if !data.isDefaultPlaylist}
						<Button
							size="sm"
							variant="outline"
							class="gap-1.5"
							disabled={batchWorking}
							onclick={() => openCopyDialogForSelection('move')}
						>
							<ListMusicIcon class="size-3.5" />
							Move to…
						</Button>
					{/if}
				{/if}
				{#if !data.isDefaultPlaylist}
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

	{#if songs.length === 0}
		<div class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
			<ListMusicIcon class="size-8 text-muted-foreground" />
			<p class="text-sm text-muted-foreground">This playlist is empty. Import some songs to get started.</p>
		</div>
	{:else if visibleIndices.length === 0}
		<p class="py-8 text-center text-sm text-muted-foreground">No songs match "{searchQuery}".</p>
	{:else if viewMode.mode === 'grid'}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
			{#each windowedIndices as index (songs[index].videoId)}
				{@const song = songs[index]}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="group relative flex flex-col gap-2 rounded-xl border border-transparent p-2 transition-colors hover:bg-muted {selected.has(
						song.videoId
					)
						? 'border-ring/50 bg-muted'
						: ''}"
					onclick={(e) => handleRowClick(e, index)}
				>
					<div class="relative aspect-square overflow-hidden rounded-lg bg-muted">
						{#if song.coverUrl}
							<img src={song.coverUrl} alt="" class="size-full object-cover" />
						{:else}
							<div class="flex size-full items-center justify-center">
								<MusicIcon class="size-8 text-muted-foreground" />
							</div>
						{/if}
						{#if cachedVideoIds.has(song.videoId)}
							<span
								class="absolute top-1 left-1 flex items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] text-white backdrop-blur-sm"
							>
								<CheckIcon class="size-2.5" />
								Cached
							</span>
						{/if}
						<button
							type="button"
							class="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100"
							onclick={(e) => {
								e.stopPropagation();
								playFrom(index);
							}}
							aria-label={player.currentTrack?.videoId === song.videoId && player.isPlaying
								? 'Pause'
								: 'Play'}
						>
							{#if player.currentTrack?.videoId === song.videoId && player.isPlaying}
								<PauseIcon class="size-8 text-white" />
							{:else}
								<PlayIcon class="size-8 text-white" />
							{/if}
						</button>
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<span
							class="absolute top-1 right-1"
							onclick={(e) => e.stopPropagation()}
						>
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="secondary"
											size="icon-sm"
											class="opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
										>
											<MoreHorizontalIcon class="size-4" />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end" class="min-w-52">
									<DropdownMenu.Item onclick={() => addToQueue(index)}>
										<ListPlusIcon class="size-4" />
										Add to queue
									</DropdownMenu.Item>
									{#if data.otherPlaylists.length > 0}
										<DropdownMenu.Item onclick={() => openCopyDialogForSong(song.videoId, 'copy')}>
											<ListMusicIcon class="size-4" />
											Copy to playlist…
										</DropdownMenu.Item>
										{#if !data.isDefaultPlaylist}
											<DropdownMenu.Item onclick={() => openCopyDialogForSong(song.videoId, 'move')}>
												<ListMusicIcon class="size-4" />
												Move to playlist…
											</DropdownMenu.Item>
										{/if}
									{/if}
									{#if !data.isDefaultPlaylist}
										<DropdownMenu.Item
											onclick={() => (removeTarget = { videoId: song.videoId, title: song.title })}
										>
											<ListMusicIcon class="size-4" />
											Remove from playlist
										</DropdownMenu.Item>
									{/if}
									<DropdownMenu.Item
										variant="destructive"
										onclick={() => (deleteTarget = { videoId: song.videoId, title: song.title })}
									>
										<Trash2Icon class="size-4" />
										Delete from library
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</span>
					</div>
					<div class="min-w-0">
						<p
							class="truncate text-sm {player.currentTrack?.videoId === song.videoId
								? 'text-foreground'
								: 'text-foreground/90'}"
						>
							{song.title}
						</p>
						<p class="truncate text-xs text-muted-foreground">
							{formatDuration(song.durationSeconds)}
						</p>
					</div>
				</div>
			{/each}
		</div>
		{#if visibleCount < visibleIndices.length}
			<InfiniteScrollSentinel onIntersect={loadMore} />
		{/if}
	{:else}
		<ul class="flex flex-col">
			{#each windowedIndices as index (songs[index].videoId)}
				{@const song = songs[index]}
				{@const draggable = searchQuery.trim().length === 0 && visibleCount >= visibleIndices.length}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<li
					class="group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted {selected.has(
						song.videoId
					)
						? 'bg-muted ring-1 ring-inset ring-ring/50'
						: player.currentTrack?.videoId === song.videoId
							? 'bg-muted'
							: ''} {draggingIndex === index ? 'opacity-50' : ''}"
					style="order: {visualOrder(index)}"
					draggable={draggable}
					ondragstart={() => draggable && handleDragStart(index)}
					ondragover={(e) => draggable && handleDragOver(e, index)}
					ondragend={() => draggable && handleDragEnd()}
					onclick={(e) => handleRowClick(e, index)}
				>
					<button
						type="button"
						class="cursor-grab touch-none text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing {draggable
							? ''
							: 'invisible'}"
						aria-label="Drag to reorder"
						tabindex={draggable ? 0 : -1}
						onclick={(e) => e.stopPropagation()}
					>
						<GripVerticalIcon class="size-4" />
					</button>

					<button
						type="button"
						class="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
						onclick={(e) => {
							e.stopPropagation();
							playFrom(index);
						}}
						aria-label={player.currentTrack?.videoId === song.videoId && player.isPlaying
							? 'Pause'
							: 'Play'}
					>
						{#if player.currentTrack?.videoId === song.videoId && player.isPlaying}
							<PauseIcon class="size-4" />
						{:else}
							<PlayIcon class="size-4" />
						{/if}
					</button>

					<div class="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
						{#if song.coverUrl}
							<img src={song.coverUrl} alt="" class="size-8 object-cover" />
						{:else}
							<MusicIcon class="size-3.5 text-muted-foreground" />
						{/if}
					</div>

					<div class="min-w-0 flex-1">
						<p
							class="truncate text-sm {player.currentTrack?.videoId === song.videoId
								? 'text-foreground'
								: 'text-foreground/90'}"
						>
							{song.title}
						</p>
					</div>

					{#if cachedVideoIds.has(song.videoId)}
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

					<span class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
						<ClockIcon class="size-3" />
						{formatDuration(song.durationSeconds)}
					</span>

					<Button
						variant="ghost"
						size="icon-sm"
						class="opacity-0 transition-opacity group-hover:opacity-100"
						disabled={downloadingVideoId === song.videoId}
						onclick={(e) => {
							e.stopPropagation();
							handleDownload(song.videoId);
						}}
						aria-label="Download for offline playback"
					>
						<DownloadIcon class="size-4" />
					</Button>

					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<span onclick={(e) => e.stopPropagation()}>
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										variant="ghost"
										size="icon-sm"
										class="opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
									>
										<MoreHorizontalIcon class="size-4" />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" class="min-w-52">
							<DropdownMenu.Item onclick={() => addToQueue(index)}>
								<ListPlusIcon class="size-4" />
								Add to queue
							</DropdownMenu.Item>
							{#if data.otherPlaylists.length > 0}
								<DropdownMenu.Item onclick={() => openCopyDialogForSong(song.videoId, 'copy')}>
									<ListMusicIcon class="size-4" />
									Copy to playlist…
								</DropdownMenu.Item>
								{#if !data.isDefaultPlaylist}
									<DropdownMenu.Item onclick={() => openCopyDialogForSong(song.videoId, 'move')}>
										<ListMusicIcon class="size-4" />
										Move to playlist…
									</DropdownMenu.Item>
								{/if}
							{/if}
							{#if !data.isDefaultPlaylist}
								<DropdownMenu.Item
									onclick={() => (removeTarget = { videoId: song.videoId, title: song.title })}
								>
									<ListMusicIcon class="size-4" />
									Remove from playlist
								</DropdownMenu.Item>
							{/if}
							<DropdownMenu.Item
								variant="destructive"
								onclick={() => (deleteTarget = { videoId: song.videoId, title: song.title })}
							>
								<Trash2Icon class="size-4" />
								Delete from library
							</DropdownMenu.Item>
						</DropdownMenu.Content>
						</DropdownMenu.Root>
					</span>
				</li>
			{/each}
		</ul>
		{#if visibleCount < visibleIndices.length}
			<InfiniteScrollSentinel onIntersect={loadMore} />
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
				{copyTarget !== null ? 'This song' : `${selected.size} song(s)`}
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
						class="w-full justify-start"
						disabled={copySubmitting}
						onclick={() => handleCopyOrMove(playlist.id)}
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

<Dialog.Root open={batchRemoveConfirm} onOpenChange={(open) => !open && (batchRemoveConfirm = false)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Remove {selected.size} songs?</Dialog.Title>
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

<Dialog.Root open={batchDeleteConfirm} onOpenChange={(open) => !open && (batchDeleteConfirm = false)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Delete {selected.size} songs?</Dialog.Title>
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
