<script lang="ts">
	import { player } from '$lib/client/player.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import ShuffleIcon from '@lucide/svelte/icons/shuffle';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const isThisGroupPlaying = $derived(
		player.isPlaying && data.songs.some((s) => s.videoId === player.currentTrack?.videoId)
	);

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

	async function playAll(shuffle = false) {
		if (data.songs.length === 0) return;
		await player.playQueue(toQueueTracks(), 0, shuffle);
	}

	async function playFrom(index: number) {
		if (player.currentTrack?.videoId === data.songs[index].videoId) {
			await player.togglePlayPause();
			return;
		}
		await player.playQueue(toQueueTracks(), index);
	}
</script>

<svelte:head>
	<title>{data.value} · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-3xl p-4 md:p-8">
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

	{#if data.songs.length === 0}
		<div class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
			<ListMusicIcon class="size-8 text-muted-foreground" />
			<p class="text-sm text-muted-foreground">Nothing here.</p>
		</div>
	{:else}
		<ul class="flex flex-col">
			{#each data.songs as song, index (song.videoId)}
				<li
					class="group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted {player
						.currentTrack?.videoId === song.videoId
						? 'bg-muted'
						: ''}"
				>
					<button
						type="button"
						class="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
						onclick={() => playFrom(index)}
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

					<div class="min-w-0 flex-1">
						<p
							class="truncate text-sm {player.currentTrack?.videoId === song.videoId
								? 'text-foreground'
								: 'text-foreground/90'}"
						>
							{song.title}
						</p>
					</div>

					<span class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
						<ClockIcon class="size-3" />
						{formatDuration(song.durationSeconds)}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>
