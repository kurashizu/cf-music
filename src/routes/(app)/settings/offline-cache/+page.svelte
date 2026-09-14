<script lang="ts">
	import { untrack, onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import PinIcon from '@lucide/svelte/icons/pin';
	import { precachePinnedSongs, reconcileAudioCache } from '$lib/client/offline-cache';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Seeded once from the server-loaded list, then updated locally via
	// togglePin's optimistic write — see the playlist detail page for the
	// same pattern (and why untrack, not a $derived, is the right tool here).
	let entries = $state(untrack(() => data.entries));
	let pendingVideoId = $state<string | null>(null);

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
		// Best-effort background warm-up — not awaited, since there's
		// nothing on this page that needs to block on it finishing.
		const pinnedVideoIds = entries.filter((e) => e.cacheType === 'pinned').map((e) => e.videoId);
		precachePinnedSongs(pinnedVideoIds);

		// Reconciles the service worker's audio cache against this page's
		// own account-storage view of the library — see reconcileAudioCache
		// for why a song removed from the library entirely (not just
		// unpinned) can otherwise leave its cached bytes behind forever.
		reconcileAudioCache(entries.map((e) => e.videoId));
	});

	async function togglePin(videoId: string, currentlyPinned: boolean) {
		pendingVideoId = videoId;
		try {
			const response = await fetch(`/api/cache/${videoId}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ cacheType: currentlyPinned ? 'lazy' : 'pinned' })
			});
			if (!response.ok) {
				toast.error('Failed to update cache preference');
				return;
			}
			entries = entries.map((entry) =>
				entry.videoId === videoId
					? { ...entry, cacheType: currentlyPinned ? 'lazy' : 'pinned' }
					: entry
			);
			if (!currentlyPinned) {
				// Pinning triggers an immediate offline warm-up rather than
				// waiting for the next page load; unpinning doesn't evict —
				// the song stays lazily cached until something else reclaims
				// the space (see reconcileAudioCache).
				precachePinnedSongs([videoId]);
			}
		} catch {
			toast.error('Failed to update cache preference');
		} finally {
			pendingVideoId = null;
		}
	}
</script>

<svelte:head>
	<title>Offline cache · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-2xl p-4 md:p-8">
	<div class="mb-6 flex items-center gap-2">
		<Button href="/settings" variant="ghost" size="sm" class="-ml-2">← Settings</Button>
	</div>
	<h1 class="mb-6 text-lg font-medium">Offline cache</h1>

	{#if entries.length === 0}
		<div class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
			<HardDriveIcon class="size-8 text-muted-foreground" />
			<p class="text-sm text-muted-foreground">No songs in your library yet.</p>
		</div>
	{:else}
		<ul class="flex flex-col">
			{#each entries as entry (entry.videoId)}
				<li class="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted">
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm">{entry.title}</p>
						<p class="text-xs text-muted-foreground">{formatBytes(entry.fileSizeBytes)}</p>
					</div>
					<Button
						size="sm"
						variant={entry.cacheType === 'pinned' ? 'default' : 'outline'}
						class="gap-1.5"
						disabled={pendingVideoId === entry.videoId}
						onclick={() => togglePin(entry.videoId, entry.cacheType === 'pinned')}
					>
						<PinIcon class="size-3.5" />
						{entry.cacheType === 'pinned' ? 'Pinned' : 'Pin'}
					</Button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
