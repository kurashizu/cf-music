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
	import {
		reconcileAudioCache,
		listCachedVideoIds,
		clearCachedAudio,
		downloadSongForOffline,
		estimateBrowserStorage,
		type StorageEstimate
	} from '$lib/client/offline-cache';
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

	const filteredEntries = $derived(
		searchQuery.trim().length === 0
			? entries
			: entries.filter((e) => e.title.toLowerCase().includes(searchQuery.trim().toLowerCase()))
	);

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
	// last click — against filteredEntries, the order actually on screen.
	function handleRowClick(event: MouseEvent, index: number) {
		const videoId = filteredEntries[index].videoId;
		if (event.shiftKey && lastSelectedIndex !== null) {
			const [from, to] = [lastSelectedIndex, index].sort((a, b) => a - b);
			const next = new Set(selected);
			for (let i = from; i <= to; i++) next.add(filteredEntries[i].videoId);
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
		<div class="relative mb-3">
			<SearchIcon class="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
			<Input placeholder="Search songs…" bind:value={searchQuery} class="pl-9" />
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
		{/if}
		<ul class="flex flex-col">
			{#each filteredEntries as entry, index (entry.videoId)}
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
	{/if}
</div>

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
