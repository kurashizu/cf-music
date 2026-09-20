<script lang="ts">
	import { onMount } from 'svelte';
	import { player } from '$lib/client/player.svelte';
	import { viewMode } from '$lib/client/view-mode.svelte';
	import { listCachedTracks } from '$lib/client/offline-cache';
	import type { CachedTrackMetadata } from '$lib/shared/audio-cache-key';
	import SongRow from '$lib/components/song-row.svelte';
	import SongCard from '$lib/components/song-card.svelte';
	import ViewModeToggle from '$lib/components/view-mode-toggle.svelte';
	import PlayerBar from '$lib/components/player-bar.svelte';
	import Logo from '$lib/components/logo.svelte';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import SearchIcon from '@lucide/svelte/icons/search';
	import CloudOffIcon from '@lucide/svelte/icons/cloud-off';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { isTouchDevice } from '$lib/client/motion';
	import type { SongRowActions, SongRowData, SongRowFlags } from '$lib/components/song-row-types';

	// The same components the online library uses, so this looks like the app
	// rather than a fallback page — the only thing that differs is where the
	// songs come from, which is the cache instead of the server.
	let tracks = $state<CachedTrackMetadata[]>([]);
	let loaded = $state(false);
	let searchQuery = $state('');
	let backOnline = $state(false);

	const tooltipsDisabled = isTouchDevice();

	const filtered = $derived.by(() => {
		const query = searchQuery.trim().toLowerCase();
		if (query.length === 0) return tracks;
		return tracks.filter((track) => track.title.toLowerCase().includes(query));
	});

	const queueTracks = $derived(
		filtered.map((track) => ({
			videoId: track.videoId,
			title: track.title,
			durationSeconds: track.durationSeconds
		}))
	);

	onMount(() => {
		listCachedTracks().then((found) => {
			// Alphabetical: there is no playlist order to honour here, and a
			// Cache Storage listing comes back in whatever order it pleases.
			tracks = found.sort((a, b) => a.title.localeCompare(b.title));
			loaded = true;
		});

		const onOnline = () => (backOnline = true);
		window.addEventListener('online', onOnline);
		if (navigator.onLine) backOnline = true;
		return () => window.removeEventListener('online', onOnline);
	});

	function toRowData(track: CachedTrackMetadata): SongRowData {
		return {
			videoId: track.videoId,
			title: track.title,
			durationSeconds: track.durationSeconds,
			// No cover and no audio spec offline: covers are presigned per
			// request and the spec comes back with the stream URL, neither of
			// which exists without a server. The row renders its placeholder.
			coverUrl: null,
			codec: null,
			bitrateKbps: null,
			embeddingStatus: null
		};
	}

	function rowFlags(track: CachedTrackMetadata): SongRowFlags {
		return {
			selected: false,
			current: player.currentTrack?.videoId === track.videoId,
			playing: player.isPlaying,
			// Everything listed here is cached by definition — that is the only
			// reason it appears at all.
			cached: true,
			downloading: false,
			busy: false,
			menuOpen: false,
			draggable: false,
			dragging: false,
			dragOrder: null,
			reorderable: false,
			canReorder: false,
			canRemove: false,
			hasOtherPlaylists: false,
			isFirst: false,
			isLast: false,
			canClearCache: false
		};
	}

	function rowActions(index: number, track: CachedTrackMetadata): SongRowActions {
		const noop = () => {};
		return {
			// Selection, playlists and deletion all need the server, so the row
			// is play-only here rather than offering actions that would fail.
			onSelect: noop,
			onPlay: () => void playFrom(index),
			onDownload: noop,
			onMenuOpenChange: noop,
			onAddToQueue: noop,
			onCopy: noop,
			onMove: noop,
			onRemove: noop,
			onDelete: noop,
			onMoveUp: noop,
			onMoveDown: noop,
			onDragStart: noop,
			onDragOver: noop,
			onDragEnd: noop,
			onClearCache: noop
		};
	}

	async function playFrom(index: number) {
		const track = filtered[index];
		if (!track) return;
		if (player.currentTrack?.videoId === track.videoId) {
			await player.togglePlayPause();
			return;
		}
		await player.playQueue(queueTracks, index);
	}
</script>

<svelte:head>
	<title>Offline · KRSZ Music</title>
</svelte:head>

<Tooltip.Provider disabled={tooltipsDisabled}>
	<div class="flex h-svh flex-col bg-background">
		<header class="flex items-center gap-2 border-b border-border p-3">
			<Logo size={22} />
			<span class="text-sm font-medium">KRSZ Music</span>
			<span
				class="ml-auto flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
			>
				<CloudOffIcon class="size-3" />
				Offline
			</span>
		</header>

		<main class="min-h-0 flex-1 overflow-y-auto">
			<div class="mx-auto max-w-screen-2xl p-4 md:p-8">
				<div class="mb-6 flex flex-wrap items-center justify-between gap-3">
					<div>
						<h1 class="text-lg font-medium">Downloaded</h1>
						<p class="text-xs text-muted-foreground">
							{#if !loaded}
								Looking for downloaded songs…
							{:else if tracks.length === 0}
								Nothing on this device yet
							{:else}
								{tracks.length}
								{tracks.length === 1 ? 'song' : 'songs'} · available without a connection
							{/if}
						</p>
					</div>
					{#if backOnline}
						<Button href="/library" size="sm" class="gap-1.5">
							<RefreshCwIcon class="size-4" />
							Back online
						</Button>
					{/if}
				</div>

				{#if loaded && tracks.length > 0}
					<div class="mb-3 flex flex-wrap items-center gap-2">
						<div class="relative min-w-48 flex-1">
							<SearchIcon
								class="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
							/>
							<Input placeholder="Search songs…" bind:value={searchQuery} class="pl-9" />
						</div>
						<ViewModeToggle />
					</div>
				{/if}

				{#if !loaded}
					<div class="py-16 text-center text-sm text-muted-foreground">Loading…</div>
				{:else if tracks.length === 0}
					<div
						class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center"
					>
						<CloudOffIcon class="size-8 text-muted-foreground" />
						<p class="text-sm text-muted-foreground">No songs are downloaded on this device.</p>
						<p class="max-w-sm text-xs text-muted-foreground">
							Download songs while you're online — from a playlist, or from Settings → Manage
							storage — and they'll play here with no connection.
						</p>
					</div>
				{:else if filtered.length === 0}
					<p class="py-8 text-center text-sm text-muted-foreground">
						No downloaded songs match "{searchQuery}".
					</p>
				{:else if viewMode.mode === 'grid'}
					<div
						class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8"
					>
						{#each filtered as track, index (track.videoId)}
							<SongCard
								song={toRowData(track)}
								flags={rowFlags(track)}
								actions={rowActions(index, track)}
							/>
						{/each}
					</div>
				{:else}
					<ul class="flex flex-col">
						{#each filtered as track, index (track.videoId)}
							<SongRow
								song={toRowData(track)}
								flags={rowFlags(track)}
								actions={rowActions(index, track)}
							/>
						{/each}
					</ul>
				{/if}
			</div>
		</main>

		<PlayerBar />
	</div>
</Tooltip.Provider>
