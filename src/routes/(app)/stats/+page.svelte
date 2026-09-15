<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import MusicIcon from '@lucide/svelte/icons/music';
	import UsersIcon from '@lucide/svelte/icons/users';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import TrendingUpIcon from '@lucide/svelte/icons/trending-up';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

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

	function formatDuration(totalSeconds: number): string {
		const h = Math.floor(totalSeconds / 3600);
		const m = Math.floor((totalSeconds % 3600) / 60);
		if (h === 0) return `${m}m`;
		return `${h}h ${m}m`;
	}

	const totalDurationSeconds = $derived(
		data.songs.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0)
	);
	const totalBytes = $derived(data.songs.reduce((sum, s) => sum + s.fileSizeBytes, 0));
	const totalPlays = $derived(data.songs.reduce((sum, s) => sum + s.playCount, 0));
	const uniqueArtists = $derived(
		new Set(data.songs.map((s) => s.artist).filter((a): a is string => a !== null)).size
	);

	// Ties broken by title so the top-N lists don't reorder arbitrarily
	// between loads when several songs/artists share a play count.
	const topSongs = $derived(
		[...data.songs]
			.filter((s) => s.playCount > 0)
			.sort((a, b) => b.playCount - a.playCount || a.title.localeCompare(b.title))
			.slice(0, 5)
	);

	const topArtists = $derived.by(() => {
		const playsByArtist = new Map<string, number>();
		for (const song of data.songs) {
			if (song.artist === null) continue;
			playsByArtist.set(song.artist, (playsByArtist.get(song.artist) ?? 0) + song.playCount);
		}
		return [...playsByArtist.entries()]
			.filter(([, plays]) => plays > 0)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, 5);
	});

	const codecBreakdown = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const song of data.songs) counts.set(song.codec, (counts.get(song.codec) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => b[1] - a[1]);
	});

	const recentlyImportedCount = $derived.by(() => {
		const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
		return data.songs.filter((s) => new Date(s.importedAt).getTime() >= thirtyDaysAgo).length;
	});
</script>

<svelte:head>
	<title>Stats · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-screen-2xl p-4 md:p-8">
	<h1 class="mb-6 text-lg font-medium">Stats</h1>

	{#if data.songs.length === 0}
		<div class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
			<TrendingUpIcon class="size-8 text-muted-foreground" />
			<p class="text-sm text-muted-foreground">Import some songs to see stats here.</p>
		</div>
	{:else}
		<div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
			<Card.Root>
				<Card.Content class="flex flex-col gap-1">
					<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<MusicIcon class="size-3.5" />
						Songs
					</span>
					<span class="text-2xl font-medium">{data.songs.length}</span>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Content class="flex flex-col gap-1">
					<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<UsersIcon class="size-3.5" />
						Artists
					</span>
					<span class="text-2xl font-medium">{uniqueArtists}</span>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Content class="flex flex-col gap-1">
					<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<ListMusicIcon class="size-3.5" />
						Playlists
					</span>
					<span class="text-2xl font-medium">{data.playlistCount + data.smartPlaylistCount}</span>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Content class="flex flex-col gap-1">
					<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<ClockIcon class="size-3.5" />
						Total time
					</span>
					<span class="text-2xl font-medium">{formatDuration(totalDurationSeconds)}</span>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Content class="flex flex-col gap-1">
					<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<HardDriveIcon class="size-3.5" />
						Storage used
					</span>
					<span class="text-2xl font-medium">{formatBytes(totalBytes)}</span>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Content class="flex flex-col gap-1">
					<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<TrendingUpIcon class="size-3.5" />
						Total plays
					</span>
					<span class="text-2xl font-medium">{totalPlays}</span>
				</Card.Content>
			</Card.Root>
		</div>

		<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
			<Card.Root>
				<Card.Content>
					<h2 class="mb-3 text-sm font-medium">Most played songs</h2>
					{#if topSongs.length === 0}
						<p class="text-xs text-muted-foreground">Nothing played yet.</p>
					{:else}
						<div class="flex flex-col gap-2">
							{#each topSongs as song, i (song.videoId)}
								<div class="flex items-center gap-2 text-sm">
									<span class="w-4 shrink-0 text-right text-xs text-muted-foreground">{i + 1}</span>
									<span class="min-w-0 flex-1 truncate">{song.title}</span>
									<span class="shrink-0 text-xs text-muted-foreground">
										{song.playCount} {song.playCount === 1 ? 'play' : 'plays'}
									</span>
								</div>
							{/each}
						</div>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Content>
					<h2 class="mb-3 text-sm font-medium">Most played artists</h2>
					{#if topArtists.length === 0}
						<p class="text-xs text-muted-foreground">Nothing played yet.</p>
					{:else}
						<div class="flex flex-col gap-2">
							{#each topArtists as [artist, plays], i (artist)}
								<div class="flex items-center gap-2 text-sm">
									<span class="w-4 shrink-0 text-right text-xs text-muted-foreground">{i + 1}</span>
									<span class="min-w-0 flex-1 truncate">{artist}</span>
									<span class="shrink-0 text-xs text-muted-foreground">
										{plays} {plays === 1 ? 'play' : 'plays'}
									</span>
								</div>
							{/each}
						</div>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Content>
					<h2 class="mb-3 text-sm font-medium">Library</h2>
					<div class="flex flex-col gap-2 text-sm">
						<div class="flex items-center justify-between">
							<span class="text-muted-foreground">Imported in last 30 days</span>
							<span>{recentlyImportedCount}</span>
						</div>
						<div class="flex items-center justify-between">
							<span class="text-muted-foreground">Cloud storage quota</span>
							<span>{formatBytes(data.usageBytes)} / {formatBytes(data.quotaBytes)}</span>
						</div>
						{#each codecBreakdown as [codec, count] (codec)}
							<div class="flex items-center justify-between">
								<span class="text-muted-foreground">{codec} files</span>
								<span>{count}</span>
							</div>
						{/each}
					</div>
				</Card.Content>
			</Card.Root>
		</div>
	{/if}
</div>
