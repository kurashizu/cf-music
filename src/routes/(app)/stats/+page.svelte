<script lang="ts">
	import { formatBytes, formatCompactDuration } from '$lib/shared/format';
	import * as Card from '$lib/components/ui/card/index.js';
	import MusicIcon from '@lucide/svelte/icons/music';
	import UsersIcon from '@lucide/svelte/icons/users';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import TrendingUpIcon from '@lucide/svelte/icons/trending-up';
	import FlameIcon from '@lucide/svelte/icons/flame';
	import AreaChart from '$lib/components/charts/area-chart.svelte';
	import DonutChart from '$lib/components/charts/donut-chart.svelte';
	import BarList from '$lib/components/charts/bar-list.svelte';
	import ActivityHeatmap from '$lib/components/charts/activity-heatmap.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const totalDurationSeconds = $derived(
		data.songs.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0)
	);
	const totalBytes = $derived(data.songs.reduce((sum, s) => sum + s.fileSizeBytes, 0));
	const totalPlays = $derived(data.songs.reduce((sum, s) => sum + s.playCount, 0));
	const uniqueArtists = $derived(
		new Set(data.songs.map((s) => s.artist).filter((a): a is string => a !== null)).size
	);
	const usagePercent = $derived(
		data.quotaBytes > 0 ? Math.min(100, (data.usageBytes / data.quotaBytes) * 100) : 0
	);

	// Ties broken by title so the top-N lists don't reorder arbitrarily
	// between loads when several songs/artists share a play count.
	const topSongs = $derived(
		[...data.songs]
			.filter((s) => s.playCount > 0)
			.sort((a, b) => b.playCount - a.playCount || a.title.localeCompare(b.title))
			.slice(0, 8)
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
			.slice(0, 8);
	});

	const DONUT_STROKES = [
		{ stroke: 'text-primary', dot: 'bg-primary' },
		{ stroke: 'text-sky-400', dot: 'bg-sky-400' },
		{ stroke: 'text-amber-400', dot: 'bg-amber-400' },
		{ stroke: 'text-emerald-400', dot: 'bg-emerald-400' },
		{ stroke: 'text-fuchsia-400', dot: 'bg-fuchsia-400' },
		{ stroke: 'text-muted-foreground', dot: 'bg-muted-foreground' }
	];

	function toDonutSlices(entries: [string, number][]) {
		return entries.map(([label, value], i) => ({
			label,
			value,
			strokeClass: DONUT_STROKES[i % DONUT_STROKES.length].stroke,
			dotClass: DONUT_STROKES[i % DONUT_STROKES.length].dot
		}));
	}

	const codecBreakdown = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const song of data.songs) counts.set(song.codec, (counts.get(song.codec) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => b[1] - a[1]);
	});
	const codecSlices = $derived(toDonutSlices(codecBreakdown));

	const genreBreakdown = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const song of data.songs) {
			counts.set(song.genre ?? 'Unknown', (counts.get(song.genre ?? 'Unknown') ?? 0) + 1);
		}
		const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
		// Collapse the long tail into "Other" so the donut/legend stays
		// readable instead of listing every one-off genre string yt-dlp
		// happened to extract.
		if (sorted.length <= 6) return sorted;
		const top = sorted.slice(0, 5);
		const otherCount = sorted.slice(5).reduce((sum, [, count]) => sum + count, 0);
		return [...top, ['Other', otherCount] as [string, number]];
	});
	const genreSlices = $derived(toDonutSlices(genreBreakdown));

	// Duration histogram, bucketed into fixed-width bands rather than
	// per-song, so it reads as a distribution shape at a glance.
	const durationBuckets = $derived.by(() => {
		const bands = [
			{ label: '<2m', max: 120 },
			{ label: '2-3m', max: 180 },
			{ label: '3-4m', max: 240 },
			{ label: '4-5m', max: 300 },
			{ label: '5-7m', max: 420 },
			{ label: '7m+', max: Infinity }
		];
		const counts = bands.map(() => 0);
		for (const song of data.songs) {
			const d = song.durationSeconds ?? 0;
			const idx = bands.findIndex((b) => d < b.max);
			counts[idx === -1 ? bands.length - 1 : idx]++;
		}
		return bands.map((b, i) => ({ label: b.label, value: counts[i] }));
	});

	// Imports-over-time: real per-song importedAt dates bucketed into
	// months, going back to the earliest import (or 6 months, whichever
	// is shorter) — a genuine time series, not synthesized data.
	const importsOverTime = $derived.by(() => {
		if (data.songs.length === 0) return [];
		const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
		const counts = new Map<string, number>();
		for (const song of data.songs) {
			const key = monthKey(new Date(song.importedAt));
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		const earliest = data.songs.reduce(
			(min, s) => Math.min(min, new Date(s.importedAt).getTime()),
			Date.now()
		);
		const start = new Date(earliest);
		start.setDate(1);
		const monthsSpan = Math.max(
			1,
			(new Date().getFullYear() - start.getFullYear()) * 12 +
				(new Date().getMonth() - start.getMonth())
		);
		const months = Math.min(monthsSpan + 1, 24);
		const cursor = new Date();
		cursor.setDate(1);
		cursor.setMonth(cursor.getMonth() - (months - 1));

		const result: { label: string; value: number }[] = [];
		let cumulative = 0;
		// Cumulative library growth reads more naturally as an area chart
		// than raw monthly import counts would (which look noisy/spiky for
		// a personal library with irregular import bursts).
		const priorCount = [...counts.entries()]
			.filter(([key]) => key < monthKey(cursor))
			.reduce((sum, [, c]) => sum + c, 0);
		cumulative = priorCount;
		for (let i = 0; i < months; i++) {
			const key = monthKey(cursor);
			cumulative += counts.get(key) ?? 0;
			result.push({
				label: cursor.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }),
				value: cumulative
			});
			cursor.setMonth(cursor.getMonth() + 1);
		}
		return result;
	});

	// Recency of last play per song, as a calendar heatmap — real data
	// (lastPlayedAt per song), though it's "songs last played on day X",
	// not a full per-play-event log (which the schema doesn't track).
	const lastPlayedCounts = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const song of data.songs) {
			if (!song.lastPlayedAt) continue;
			const key = new Date(song.lastPlayedAt).toISOString().slice(0, 10);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return counts;
	});

	const recentlyImportedCount = $derived.by(() => {
		const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
		return data.songs.filter((s) => new Date(s.importedAt).getTime() >= thirtyDaysAgo).length;
	});

	const avgDurationSeconds = $derived(
		data.songs.length > 0 ? totalDurationSeconds / data.songs.length : 0
	);
</script>

<svelte:head>
	<title>Stats · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-screen-2xl p-4 md:p-8">
	<h1 class="mb-6 text-lg font-medium">Stats</h1>

	{#if data.songs.length === 0}
		<div
			class="border-border flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center"
		>
			<TrendingUpIcon class="text-muted-foreground size-8" />
			<p class="text-muted-foreground text-sm">Import some songs to see stats here.</p>
		</div>
	{:else}
		<div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
			<Card.Root
				class="transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md"
			>
				<Card.Content class="flex flex-col gap-1">
					<span class="text-muted-foreground flex items-center gap-1.5 text-xs">
						<MusicIcon class="size-3.5" />
						Songs
					</span>
					<span class="text-2xl font-medium">{data.songs.length}</span>
				</Card.Content>
			</Card.Root>
			<Card.Root
				class="transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md"
			>
				<Card.Content class="flex flex-col gap-1">
					<span class="text-muted-foreground flex items-center gap-1.5 text-xs">
						<UsersIcon class="size-3.5" />
						Artists
					</span>
					<span class="text-2xl font-medium">{uniqueArtists}</span>
				</Card.Content>
			</Card.Root>
			<Card.Root
				class="transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md"
			>
				<Card.Content class="flex flex-col gap-1">
					<span class="text-muted-foreground flex items-center gap-1.5 text-xs">
						<ListMusicIcon class="size-3.5" />
						Playlists
					</span>
					<span class="text-2xl font-medium">{data.playlistCount + data.smartPlaylistCount}</span>
				</Card.Content>
			</Card.Root>
			<Card.Root
				class="transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md"
			>
				<Card.Content class="flex flex-col gap-1">
					<span class="text-muted-foreground flex items-center gap-1.5 text-xs">
						<ClockIcon class="size-3.5" />
						Total time
					</span>
					<span class="text-2xl font-medium">{formatCompactDuration(totalDurationSeconds)}</span>
				</Card.Content>
			</Card.Root>
			<Card.Root
				class="transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md"
			>
				<Card.Content class="flex flex-col gap-1">
					<span class="text-muted-foreground flex items-center gap-1.5 text-xs">
						<HardDriveIcon class="size-3.5" />
						Storage used
					</span>
					<span class="text-2xl font-medium">{formatBytes(totalBytes)}</span>
					<div class="bg-muted mt-1 h-1 overflow-hidden rounded-full">
						<div
							class="h-full rounded-full transition-all duration-500 {usagePercent > 90
								? 'bg-amber-400'
								: 'bg-sky-400'}"
							style="width: {usagePercent}%"
						></div>
					</div>
				</Card.Content>
			</Card.Root>
			<Card.Root
				class="transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md"
			>
				<Card.Content class="flex flex-col gap-1">
					<span class="flex items-center gap-1.5 text-xs text-sky-400/80">
						<TrendingUpIcon class="size-3.5" />
						Total plays
					</span>
					<span class="text-2xl font-medium text-sky-400">{totalPlays}</span>
				</Card.Content>
			</Card.Root>
		</div>

		<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
			<Card.Root class="lg:col-span-2">
				<Card.Content>
					<div class="mb-3 flex items-center justify-between">
						<h2 class="text-sm font-medium">Library growth</h2>
						<span class="text-muted-foreground text-xs">cumulative songs imported</span>
					</div>
					<AreaChart points={importsOverTime} formatValue={(v) => `${v} songs`} />
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Content>
					<h2 class="mb-3 text-sm font-medium">Codec breakdown</h2>
					<DonutChart slices={codecSlices} />
				</Card.Content>
			</Card.Root>
		</div>

		<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
			<Card.Root class="lg:col-span-2">
				<Card.Content class="flex h-full flex-col">
					<div class="mb-3 flex items-center gap-1.5">
						<FlameIcon class="text-muted-foreground size-3.5" />
						<h2 class="text-sm font-medium">Recently played</h2>
						<span class="text-muted-foreground text-xs">— by last-played date</span>
					</div>
					<div class="flex flex-1 flex-col justify-center">
						<ActivityHeatmap counts={lastPlayedCounts} />
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Content>
					<h2 class="mb-3 text-sm font-medium">Genres</h2>
					<DonutChart slices={genreSlices} />
				</Card.Content>
			</Card.Root>
		</div>

		<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
			<Card.Root>
				<Card.Content>
					<h2 class="mb-3 text-sm font-medium">Most played songs</h2>
					{#if topSongs.length === 0}
						<p class="text-muted-foreground text-xs">Nothing played yet.</p>
					{:else}
						<BarList
							bars={topSongs.map((s) => ({
								label: s.title,
								value: s.playCount,
								suffix: s.playCount === 1 ? ' play' : ' plays'
							}))}
						/>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Content>
					<h2 class="mb-3 text-sm font-medium">Most played artists</h2>
					{#if topArtists.length === 0}
						<p class="text-muted-foreground text-xs">Nothing played yet.</p>
					{:else}
						<BarList
							bars={topArtists.map(([artist, plays]) => ({
								label: artist,
								value: plays,
								suffix: plays === 1 ? ' play' : ' plays'
							}))}
						/>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Content>
					<h2 class="mb-3 text-sm font-medium">Song lengths</h2>
					<BarList bars={durationBuckets} />
				</Card.Content>
			</Card.Root>
		</div>

		<div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
			<Card.Root>
				<Card.Content>
					<h2 class="mb-3 text-sm font-medium">Library details</h2>
					<div class="flex flex-col gap-2 text-sm">
						<div class="flex items-center justify-between">
							<span class="text-muted-foreground">Imported in last 30 days</span>
							<span>{recentlyImportedCount}</span>
						</div>
						<div class="flex items-center justify-between">
							<span class="text-muted-foreground">Average song length</span>
							<span>{formatCompactDuration(avgDurationSeconds)}</span>
						</div>
						<div class="flex items-center justify-between">
							<span class="text-muted-foreground">Cloud storage quota</span>
							<span>{formatBytes(data.usageBytes)} / {formatBytes(data.quotaBytes)}</span>
						</div>
					</div>
				</Card.Content>
			</Card.Root>
		</div>
	{/if}
</div>
