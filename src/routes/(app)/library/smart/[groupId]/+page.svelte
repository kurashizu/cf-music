<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { player } from '$lib/client/player.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import ShuffleIcon from '@lucide/svelte/icons/shuffle';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import MusicIcon from '@lucide/svelte/icons/music';
	import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ListPlusIcon from '@lucide/svelte/icons/list-plus';
	import XIcon from '@lucide/svelte/icons/x';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { onMount } from 'svelte';
	import { flip } from 'svelte/animate';
	import { scale } from 'svelte/transition';
	import { motionParams } from '$lib/client/motion';
	import { downloadSongForOffline, listCachedVideoIds } from '$lib/client/offline-cache';
	import { viewMode } from '$lib/client/view-mode.svelte';
	import ViewModeToggle from '$lib/components/view-mode-toggle.svelte';
	import InfiniteScrollSentinel from '$lib/components/infinite-scroll-sentinel.svelte';
	import ThrottledImage from '$lib/components/throttled-image.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let cachedVideoIds = $state<Set<string>>(new Set());
	onMount(() => {
		listCachedVideoIds().then((ids) => {
			cachedVideoIds = new Set(ids);
		});
	});

	const isThisGroupPlaying = $derived(
		player.isPlaying && data.songs.some((s) => s.videoId === player.currentTrack?.videoId)
	);

	let searchQuery = $state('');
	const filteredSongs = $derived(
		searchQuery.trim().length === 0
			? data.songs
			: data.songs.filter((s) => s.title.toLowerCase().includes(searchQuery.trim().toLowerCase()))
	);

	const PAGE_SIZE = 20;
	let visibleCount = $state(PAGE_SIZE);
	$effect(() => {
		filteredSongs;
		visibleCount = PAGE_SIZE;
	});
	const visibleSongs = $derived(filteredSongs.slice(0, visibleCount));
	function loadMore() {
		visibleCount = Math.min(filteredSongs.length, visibleCount + PAGE_SIZE);
	}

	let selected = $state<Set<string>>(new Set());
	let lastSelectedIndex = $state<number | null>(null);
	let batchWorking = $state(false);
	// Separate from batchWorking (shared by every other batch action) since
	// downloads need to report how many of the selection have finished so
	// far — see the playlist detail page's own version of this state for
	// the full reasoning (each download now genuinely waits to complete).
	let batchDownloadProgress = $state<{ completed: number; total: number } | null>(null);
	let batchDeleteConfirm = $state(false);
	let downloadingVideoId = $state<string | null>(null);
	let deleteTarget = $state<{ videoId: string; title: string } | null>(null);
	let deleteSubmitting = $state(false);
	let copyTarget = $state<string | null>(null); // videoId, or null when copying the current selection
	let copyDialogOpen = $state(false);
	let copySubmitting = $state(false);

	const allVisibleSelected = $derived(
		filteredSongs.length > 0 && filteredSongs.every((s) => selected.has(s.videoId))
	);

	function toggleSelectAll() {
		if (allVisibleSelected) {
			clearSelection();
			return;
		}
		selected = new Set(filteredSongs.map((s) => s.videoId));
		lastSelectedIndex = filteredSongs.length - 1;
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

	// File-manager-style click selection, same as the playlist detail page —
	// against visibleSongs, since that's the order actually rendered.
	function handleRowClick(event: MouseEvent, index: number) {
		const videoId = visibleSongs[index].videoId;
		if (event.shiftKey && lastSelectedIndex !== null) {
			const [from, to] = [lastSelectedIndex, index].sort((a, b) => a - b);
			const next = new Set(selected);
			for (let i = from; i <= to; i++) next.add(visibleSongs[i].videoId);
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

	function toQueueTracks() {
		return data.songs.map((s) => ({
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
		if (data.songs.length === 0) return;
		await player.playQueue(toQueueTracks(), 0, shuffle);
	}

	async function playFrom(index: number) {
		const song = visibleSongs[index];
		const actualIndex = data.songs.findIndex((s) => s.videoId === song.videoId);
		if (player.currentTrack?.videoId === song.videoId) {
			await player.togglePlayPause();
			return;
		}
		await player.playQueue(toQueueTracks(), actualIndex);
	}

	async function addToQueue(videoId: string) {
		const song = data.songs.find((s) => s.videoId === videoId);
		if (!song) return;
		await player.addToQueue([
			{ videoId: song.videoId, title: song.title, durationSeconds: song.durationSeconds }
		]);
		toast.success('Added to queue');
	}

	async function addSelectionToQueue() {
		const tracks = data.songs
			.filter((s) => selected.has(s.videoId))
			.map((s) => ({ videoId: s.videoId, title: s.title, durationSeconds: s.durationSeconds }));
		if (tracks.length === 0) return;
		await player.addToQueue(tracks);
		toast.success(`Added ${tracks.length} song(s) to queue`);
		clearSelection();
	}

	async function handleDownload(videoId: string) {
		// Already cached — re-downloading would just re-presign a stream
		// URL and round-trip to the service worker only to have it find
		// its own cache.match already satisfied, for no benefit.
		if (cachedVideoIds.has(videoId)) {
			toast.success('Already downloaded for offline playback');
			return;
		}
		downloadingVideoId = videoId;
		try {
			const ok = await downloadSongForOffline(videoId);
			if (ok) cachedVideoIds = new Set([...cachedVideoIds, videoId]);
			toast[ok ? 'success' : 'error'](ok ? 'Downloaded for offline playback' : 'Failed to download song');
		} finally {
			downloadingVideoId = null;
		}
	}

	// Same limited-concurrency approach as the playlist detail page's own
	// handleBatchDownload — see that copy's comment for why neither fully
	// serial nor fully parallel is right now that each download genuinely
	// waits for the service worker to finish it.
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
		// Skip anything already cached rather than re-requesting a fresh
		// stream URL and round-tripping to the service worker for a
		// cache.match it would just satisfy immediately anyway — with a
		// large selection that's a lot of pointless API calls, and it
		// also kept the progress count ("Downloading N/M") including
		// songs that were never actually going to download anything.
		const videoIds = [...selected].filter((id) => !cachedVideoIds.has(id));
		if (videoIds.length === 0) {
			toast.success('Already downloaded for offline playback');
			clearSelection();
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
				cachedVideoIds = downloaded;
				if (batchDownloadProgress) batchDownloadProgress.completed++;
			});
			toast[failures === 0 ? 'success' : 'error'](
				failures === 0 ? 'Downloaded for offline playback' : `Failed to download ${failures} song(s)`
			);
			clearSelection();
		} finally {
			batchWorking = false;
			batchDownloadProgress = null;
		}
	}

	function openCopyDialogForSong(videoId: string) {
		copyTarget = videoId;
		copyDialogOpen = true;
	}

	function openCopyDialogForSelection() {
		copyTarget = null;
		copyDialogOpen = true;
	}

	async function handleCopy(toPlaylistId: string) {
		const isBatchCopy = copyTarget === null;
		const videoIds = isBatchCopy ? [...selected] : [copyTarget];
		if (videoIds.length === 0) return;
		copySubmitting = true;
		try {
			const results = await Promise.all(
				videoIds.map((videoId) =>
					fetch(`/api/playlists/${toPlaylistId}/songs`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ videoId })
					})
				)
			);
			const failures = results.filter((r) => !r.ok).length;
			toast[failures === 0 ? 'success' : 'error'](
				failures === 0
					? videoIds.length === 1
						? 'Copied to playlist'
						: `Copied ${videoIds.length} songs`
					: `Failed to copy ${failures} song(s)`
			);
			copyDialogOpen = false;
			copyTarget = null;
			if (isBatchCopy) clearSelection();
		} finally {
			copySubmitting = false;
		}
	}

	async function handleDeleteOne() {
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
		} finally {
			deleteSubmitting = false;
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
</script>

<svelte:head>
	<title>{data.value} · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-screen-2xl p-4 md:p-8">
	<div class="mb-6 flex flex-wrap items-center justify-between gap-4">
		<div class="min-w-0">
			<p class="text-xs text-muted-foreground capitalize">{data.field}</p>
			<h1 class="truncate text-lg font-medium">{data.value}</h1>
			<p class="text-sm text-muted-foreground">
				{data.songs.length} {data.songs.length === 1 ? 'song' : 'songs'}
			</p>
		</div>
		<div class="flex items-center gap-2">
			<Button size="sm" class="gap-1.5" disabled={data.songs.length === 0} onclick={() => playAll()}>
				{#if isThisGroupPlaying}
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
				disabled={data.songs.length === 0}
				onclick={() => playAll(true)}
			>
				<ShuffleIcon class="size-4" />
				Shuffle
			</Button>
		</div>
	</div>

	{#if data.songs.length > 0}
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
					{#if batchDownloadProgress}
						<LoaderCircleIcon class="size-3.5 animate-spin" />
						Downloading {batchDownloadProgress.completed}/{batchDownloadProgress.total}
					{:else}
						<DownloadIcon class="size-3.5" />
						Download
					{/if}
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
			</div>
		</div>
	{/if}

	{#if data.songs.length === 0}
		<div class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
			<ListMusicIcon class="size-8 text-muted-foreground" />
			<p class="text-sm text-muted-foreground">Nothing here.</p>
		</div>
	{:else if filteredSongs.length === 0}
		<p class="py-8 text-center text-sm text-muted-foreground">No songs match "{searchQuery}".</p>
	{:else if viewMode.mode === 'grid'}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
			{#each visibleSongs as song, index (song.videoId)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="group relative flex flex-col gap-2 rounded-xl border border-transparent p-2 transition-colors active:bg-muted hover:bg-muted {selected.has(
						song.videoId
					)
						? 'border-ring/50 bg-muted'
						: ''}"
					onclick={(e) => handleRowClick(e, index)}
					animate:flip={motionParams({ duration: 200 })}
				>
					<div class="relative aspect-square overflow-hidden rounded-lg bg-muted">
						{#if song.coverUrl}
							<ThrottledImage src={song.coverUrl} class="size-full object-cover" />
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
							class="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors active:bg-black/40 sm:group-hover:bg-black/40"
							onclick={(e) => {
								e.stopPropagation();
								playFrom(index);
							}}
							aria-label={player.currentTrack?.videoId === song.videoId && player.isPlaying
								? 'Pause'
								: 'Play'}
						>
							{#key player.currentTrack?.videoId === song.videoId && player.isPlaying}
								<span
									class="flex size-9 items-center justify-center rounded-full bg-black/50 opacity-100 backdrop-blur-sm transition-opacity sm:bg-black/60 sm:opacity-0 sm:group-hover:opacity-100"
									transition:scale={motionParams({ duration: 100, start: 0.7 })}
								>
									{#if player.currentTrack?.videoId === song.videoId && player.isPlaying}
										<PauseIcon class="size-4 text-white" />
									{:else}
										<PlayIcon class="size-4 text-white" />
									{/if}
								</span>
							{/key}
						</button>
						<span class="absolute top-1 right-1" onclick={(e) => e.stopPropagation()}>
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="secondary"
											size="icon-sm"
											class="opacity-100 backdrop-blur-sm transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:data-[state=open]:opacity-100"
										>
											<MoreHorizontalIcon class="size-4" />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end" class="min-w-52">
									<DropdownMenu.Item onclick={() => addToQueue(song.videoId)}>
										<ListPlusIcon class="size-4" />
										Add to queue
									</DropdownMenu.Item>
									{#if data.playlists.length > 0}
										<DropdownMenu.Item onclick={() => openCopyDialogForSong(song.videoId)}>
											<ListMusicIcon class="size-4" />
											Copy to playlist…
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
		{#if visibleCount < filteredSongs.length}
			<InfiniteScrollSentinel onIntersect={loadMore} />
		{/if}
	{:else}
		<ul class="flex flex-col">
			{#each visibleSongs as song, index (song.videoId)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<li
					class="group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors active:bg-muted hover:bg-muted {selected.has(
						song.videoId
					)
						? 'bg-muted ring-1 ring-inset ring-ring/50'
						: player.currentTrack?.videoId === song.videoId
							? 'bg-muted'
							: ''}"
					onclick={(e) => handleRowClick(e, index)}
					animate:flip={motionParams({ duration: 200 })}
				>
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
							<ThrottledImage src={song.coverUrl} class="size-8 object-cover" />
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
						class="opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
						disabled={downloadingVideoId === song.videoId}
						onclick={(e) => {
							e.stopPropagation();
							handleDownload(song.videoId);
						}}
						aria-label={downloadingVideoId === song.videoId
							? 'Downloading for offline playback'
							: 'Download for offline playback'}
					>
						{#if downloadingVideoId === song.videoId}
							<LoaderCircleIcon class="size-4 animate-spin" />
						{:else}
							<DownloadIcon class="size-4" />
						{/if}
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
										class="opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:data-[state=open]:opacity-100"
									>
										<MoreHorizontalIcon class="size-4" />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="end" class="min-w-52">
								<DropdownMenu.Item onclick={() => addToQueue(song.videoId)}>
									<ListPlusIcon class="size-4" />
									Add to queue
								</DropdownMenu.Item>
								{#if data.playlists.length > 0}
									<DropdownMenu.Item onclick={() => openCopyDialogForSong(song.videoId)}>
										<ListMusicIcon class="size-4" />
										Copy to playlist…
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
		{#if visibleCount < filteredSongs.length}
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
			<Dialog.Title>Copy to playlist</Dialog.Title>
			<Dialog.Description>
				{copyTarget !== null ? 'This song' : `${selected.size} song(s)`} will be added to the playlist
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

<Dialog.Root open={deleteTarget !== null} onOpenChange={(open) => !open && (deleteTarget = null)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Delete "{deleteTarget?.title}"?</Dialog.Title>
			<Dialog.Description>
				This deletes the song from your library entirely — it disappears from every playlist it's
				in. This can't be undone.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteTarget = null)}>Cancel</Button>
			<Button variant="destructive" disabled={deleteSubmitting} onclick={handleDeleteOne}>
				{deleteSubmitting ? 'Deleting…' : 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={batchDeleteConfirm} onOpenChange={(open) => !open && (batchDeleteConfirm = false)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Delete {selected.size} songs?</Dialog.Title>
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
