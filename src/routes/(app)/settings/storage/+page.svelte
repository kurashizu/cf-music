<script lang="ts">
	import { untrack, onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import XIcon from '@lucide/svelte/icons/x';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import MusicIcon from '@lucide/svelte/icons/music';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
	import CheckIcon from '@lucide/svelte/icons/check';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { player } from '$lib/client/player.svelte';
	import { viewMode } from '$lib/client/view-mode.svelte';
	import ViewModeToggle from '$lib/components/view-mode-toggle.svelte';
	import {
		reconcileAudioCache,
		listCachedVideoIds,
		clearCachedAudio,
		downloadSongForOffline,
		estimateBrowserStorage,
		type StorageEstimate
	} from '$lib/client/offline-cache';
	import InfiniteScrollSentinel from '$lib/components/infinite-scroll-sentinel.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let entries = $state(untrack(() => data.entries));
	let cachedVideoIds = $state<Set<string>>(new Set());
	let workingVideoId = $state<string | null>(null);
	let browserStorage = $state<StorageEstimate | null>(null);

	let selected = $state<Set<string>>(new Set());
	let batchWorking = $state(false);
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

	type SortOption = 'size-desc' | 'title-asc' | 'cached-first';
	let sortOption = $state<SortOption>('size-desc');
	const sortOptionLabels: Record<SortOption, string> = {
		'size-desc': 'Largest first',
		'title-asc': 'Title (A–Z)',
		'cached-first': 'Downloaded first'
	};

	const filteredEntries = $derived.by(() => {
		const matching =
			searchQuery.trim().length === 0
				? entries
				: entries.filter((e) => e.title.toLowerCase().includes(searchQuery.trim().toLowerCase()));

		// A plain [...array].sort() is stable in every modern JS engine
		// (ES2019+), so ties (e.g. two cached songs) keep their original
		// relative order instead of being shuffled arbitrarily.
		switch (sortOption) {
			case 'size-desc':
				return [...matching].sort((a, b) => b.fileSizeBytes - a.fileSizeBytes);
			case 'title-asc':
				return [...matching].sort((a, b) => a.title.localeCompare(b.title));
			case 'cached-first':
				return [...matching].sort(
					(a, b) => Number(cachedVideoIds.has(b.videoId)) - Number(cachedVideoIds.has(a.videoId))
				);
		}
	});

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
	function loadMore() {
		visibleCount = Math.min(filteredEntries.length, visibleCount + PAGE_SIZE);
	}

	const usagePercent = $derived(
		data.quotaBytes > 0 ? Math.min(100, (data.usageBytes / data.quotaBytes) * 100) : 0
	);
	const browserUsagePercent = $derived(
		browserStorage && data.quotaBytes > 0
			? Math.min(100, (browserStorage.usageBytes / data.quotaBytes) * 100)
			: 0
	);

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		const units = ['KB', 'MB', 'GB'];
		let value = bytes / 1024;
		let unitIndex = 0;
		while (value >= 1024 && unitIndex < units.length - 1) {
			value /= 1024;
			unitIndex++;
		}
		return `${value.toFixed(1)} ${units[unitIndex]}`;
	}

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
	});

	let lastSelectedIndex = $state<number | null>(null);

	const allVisibleSelected = $derived(
		filteredEntries.length > 0 && filteredEntries.every((e) => selected.has(e.videoId))
	);

	function toggleSelectAll() {
		if (allVisibleSelected) {
			clearSelection();
			return;
		}
		selected = new Set(filteredEntries.map((e) => e.videoId));
		lastSelectedIndex = filteredEntries.length - 1;
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

	// File-manager-style click selection: plain click selects only this
	// row, ctrl/cmd-click toggles it, and shift-click extends from the
	// last click — against visibleEntries, the order actually on screen
	// (only what's been scrolled into view so far).
	function handleRowClick(event: MouseEvent, index: number) {
		const videoId = visibleEntries[index].videoId;
		if (event.shiftKey && lastSelectedIndex !== null) {
			const [from, to] = [lastSelectedIndex, index].sort((a, b) => a - b);
			const next = new Set(selected);
			for (let i = from; i <= to; i++) next.add(visibleEntries[i].videoId);
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

	async function playEntry(entry: { videoId: string; title: string }) {
		if (player.currentTrack?.videoId === entry.videoId) {
			await player.togglePlayPause();
			return;
		}
		// This page has no natural "queue" of its own (it spans the whole
		// library, not one ordered playlist) — playing a song here just
		// starts a single-track queue, same as if it were the only result.
		await player.playQueue([{ videoId: entry.videoId, title: entry.title, durationSeconds: null }], 0);
	}

	async function handleDownload(videoId: string) {
		workingVideoId = videoId;
		try {
			const ok = await downloadSongForOffline(videoId);
			if (ok) cachedVideoIds = new Set([...cachedVideoIds, videoId]);
			toast[ok ? 'success' : 'error'](ok ? 'Downloaded for offline playback' : 'Failed to download song');
		} finally {
			workingVideoId = null;
		}
	}

	async function handleClearCached(videoId: string) {
		workingVideoId = videoId;
		try {
			await clearCachedAudio([videoId]);
			cachedVideoIds = new Set([...cachedVideoIds].filter((id) => id !== videoId));
			toast.success('Removed from offline cache');
		} finally {
			workingVideoId = null;
		}
	}

	async function handleDeleteOne(videoId: string) {
		workingVideoId = videoId;
		try {
			const response = await fetch(`/api/songs/${videoId}`, { method: 'DELETE' });
			if (!response.ok) {
				toast.error('Failed to delete song');
				return;
			}
			entries = entries.filter((e) => e.videoId !== videoId);
			cachedVideoIds = new Set([...cachedVideoIds].filter((id) => id !== videoId));
			toast.success('Song deleted');
			await invalidateAll();
		} finally {
			workingVideoId = null;
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

	async function handleBatchClearCached() {
		batchWorking = true;
		try {
			await clearCachedAudio([...selected]);
			cachedVideoIds = new Set([...cachedVideoIds].filter((id) => !selected.has(id)));
			toast.success('Removed from offline cache');
			clearSelection();
		} finally {
			batchWorking = false;
		}
	}

	// copyTarget === null means "copy the current selection"; otherwise
	// it's a single song's videoId (from a row's own actions). Always adds
	// (never removes from anywhere) — this page spans the whole library,
	// not one playlist, so there's no single "source" a move could remove
	// the song from.
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

	async function handleBatchDelete() {
		batchWorking = true;
		try {
			const results = await Promise.all(
				[...selected].map((videoId) => fetch(`/api/songs/${videoId}`, { method: 'DELETE' }))
			);
			const failures = results.filter((r) => !r.ok).length;
			entries = entries.filter((e) => !selected.has(e.videoId));
			cachedVideoIds = new Set([...cachedVideoIds].filter((id) => !selected.has(id)));
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
	<title>Manage storage · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-2xl p-4 md:p-8">
	<div class="mb-6 flex items-center gap-2">
		<Button href="/settings" variant="ghost" size="sm" class="-ml-2">← Settings</Button>
	</div>
	<h1 class="mb-6 text-lg font-medium">Manage storage</h1>

	<div class="mb-4 rounded-xl border border-border p-4">
		<div class="mb-2 flex items-center justify-between text-sm">
			<span class="flex items-center gap-1.5 text-muted-foreground">
				<HardDriveIcon class="size-4" />
				Account storage (cloud)
			</span>
			<span class="text-muted-foreground">{formatBytes(data.usageBytes)} / {formatBytes(data.quotaBytes)}</span>
		</div>
		<div class="h-1.5 overflow-hidden rounded-full bg-muted">
			<div class="h-full bg-foreground transition-all duration-300" style="width: {usagePercent}%"></div>
		</div>
	</div>

	<div class="mb-6 rounded-xl border border-border p-4">
		<div class="mb-2 flex items-center justify-between text-sm">
			<span class="flex items-center gap-1.5 text-muted-foreground">
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
			<div class="h-1.5 overflow-hidden rounded-full bg-muted">
				<div
					class="h-full bg-foreground transition-all duration-300"
					style="width: {browserUsagePercent}%"
				></div>
			</div>
		{:else}
			<p class="text-xs text-muted-foreground">Not available in this browser.</p>
		{/if}
		<p class="mt-2 text-xs text-muted-foreground">
			Download a song to keep it available for offline playback. Downloaded songs stay cached
			until you clear them here.
		</p>
	</div>

	{#if entries.length === 0}
		<div class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
			<HardDriveIcon class="size-8 text-muted-foreground" />
			<p class="text-sm text-muted-foreground">No songs in your library yet.</p>
		</div>
	{:else}
		<div class="mb-3 flex items-center gap-2">
			<div class="relative flex-1">
				<SearchIcon class="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input placeholder="Search songs…" bind:value={searchQuery} class="pl-9" />
			</div>
			<Button size="sm" variant="outline" onclick={toggleSelectAll}>
				{allVisibleSelected ? 'Deselect all' : 'Select all'}
			</Button>
			<Select.Root type="single" bind:value={sortOption}>
				<Select.Trigger class="w-40">
					{sortOptionLabels[sortOption]}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="size-desc" label="Largest first">Largest first</Select.Item>
					<Select.Item value="title-asc" label="Title (A–Z)">Title (A–Z)</Select.Item>
					<Select.Item value="cached-first" label="Downloaded first">Downloaded first</Select.Item>
				</Select.Content>
			</Select.Root>
			<ViewModeToggle />
		</div>

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
				</div>
			</div>
		{/if}

		{#if filteredEntries.length === 0}
			<p class="py-8 text-center text-sm text-muted-foreground">No songs match "{searchQuery}".</p>
		{:else if viewMode.mode === 'grid'}
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
				{#each visibleEntries as entry, index (entry.videoId)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="group relative flex flex-col gap-2 rounded-xl border border-transparent p-2 transition-colors hover:bg-muted {selected.has(
							entry.videoId
						)
							? 'border-ring/50 bg-muted'
							: ''}"
						onclick={(e) => handleRowClick(e, index)}
					>
						<div class="relative aspect-square overflow-hidden rounded-lg bg-muted">
							{#if entry.coverUrl}
								<img src={entry.coverUrl} alt="" class="size-full object-cover" />
							{:else}
								<div class="flex size-full items-center justify-center">
									<MusicIcon class="size-8 text-muted-foreground" />
								</div>
							{/if}
							{#if cachedVideoIds.has(entry.videoId)}
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
									playEntry(entry);
								}}
								aria-label={player.currentTrack?.videoId === entry.videoId && player.isPlaying
									? 'Pause'
									: 'Play'}
							>
								{#if player.currentTrack?.videoId === entry.videoId && player.isPlaying}
									<PauseIcon class="size-8 text-white" />
								{:else}
									<PlayIcon class="size-8 text-white" />
								{/if}
							</button>
							<span class="absolute top-1 right-1" onclick={(e) => e.stopPropagation()}>
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
										{#if cachedVideoIds.has(entry.videoId)}
											<DropdownMenu.Item onclick={() => handleClearCached(entry.videoId)}>
												<GlobeIcon class="size-4" />
												Clear from cache
											</DropdownMenu.Item>
										{:else}
											<DropdownMenu.Item onclick={() => handleDownload(entry.videoId)}>
												<DownloadIcon class="size-4" />
												Download
											</DropdownMenu.Item>
										{/if}
										{#if data.playlists.length > 0}
											<DropdownMenu.Item onclick={() => openCopyDialogForSong(entry.videoId)}>
												<ListMusicIcon class="size-4" />
												Copy to playlist…
											</DropdownMenu.Item>
										{/if}
										<DropdownMenu.Item variant="destructive" onclick={() => handleDeleteOne(entry.videoId)}>
											<Trash2Icon class="size-4" />
											Delete from library
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</span>
						</div>
						<div class="min-w-0">
							<p class="truncate text-sm">{entry.title}</p>
							<p class="truncate text-xs text-muted-foreground">{formatBytes(entry.fileSizeBytes)}</p>
						</div>
					</div>
				{/each}
			</div>
			{#if visibleCount < filteredEntries.length}
				<InfiniteScrollSentinel onIntersect={loadMore} />
			{/if}
		{:else}
			<ul class="flex flex-col">
				{#each visibleEntries as entry, index (entry.videoId)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<li
					class="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted {selected.has(
						entry.videoId
					)
						? 'bg-muted ring-1 ring-inset ring-ring/50'
						: ''}"
					onclick={(e) => handleRowClick(e, index)}
				>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm">{entry.title}</p>
						<p class="text-xs text-muted-foreground">
							{formatBytes(entry.fileSizeBytes)}
							{cachedVideoIds.has(entry.videoId) ? '· Downloaded' : ''}
						</p>
					</div>
					{#if cachedVideoIds.has(entry.videoId)}
						<Button
							size="sm"
							variant="ghost"
							class="gap-1.5 text-muted-foreground"
							disabled={workingVideoId === entry.videoId}
							onclick={(e) => {
								e.stopPropagation();
								handleClearCached(entry.videoId);
							}}
						>
							<GlobeIcon class="size-3.5" />
							Clear
						</Button>
					{:else}
						<Button
							size="sm"
							variant="ghost"
							class="gap-1.5 text-muted-foreground"
							disabled={workingVideoId === entry.videoId}
							onclick={(e) => {
								e.stopPropagation();
								handleDownload(entry.videoId);
							}}
						>
							<DownloadIcon class="size-3.5" />
							Download
						</Button>
					{/if}
					{#if data.playlists.length > 0}
						<Button
							size="sm"
							variant="ghost"
							class="text-muted-foreground"
							onclick={(e) => {
								e.stopPropagation();
								openCopyDialogForSong(entry.videoId);
							}}
							aria-label="Copy {entry.title} to playlist"
						>
							<ListMusicIcon class="size-3.5" />
						</Button>
					{/if}
					<Button
						size="sm"
						variant="ghost"
						class="text-muted-foreground hover:text-destructive"
						disabled={workingVideoId === entry.videoId}
						onclick={(e) => {
							e.stopPropagation();
							handleDeleteOne(entry.videoId);
						}}
						aria-label="Delete {entry.title} from library"
					>
						<Trash2Icon class="size-3.5" />
					</Button>
				</li>
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
