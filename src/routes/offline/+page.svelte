<script lang="ts">
	import { onMount } from 'svelte';
	import SearchField from '$lib/components/search-field.svelte';
	import { player } from '$lib/client/player.svelte';
	import { viewMode } from '$lib/client/view-mode.svelte';
	import { listCachedTracks, cachedCoverUrl, readLibrarySnapshot } from '$lib/client/offline-cache';
	import type { CachedPlaylist, CachedTrackMetadata } from '$lib/shared/audio-cache-key';
	import { PLAYLIST_MOSAIC_COVER_COUNT } from '$lib/shared/playlist-cover';
	import AppShell from '$lib/components/app-shell.svelte';
	import SongRow from '$lib/components/song-row.svelte';
	import SongCard from '$lib/components/song-card.svelte';
	import PlaylistCard from '$lib/components/playlist-card.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import ViewModeToggle from '$lib/components/view-mode-toggle.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import CloudOffIcon from '@lucide/svelte/icons/cloud-off';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import PlayIcon from '@lucide/svelte/icons/play';
	import ShuffleIcon from '@lucide/svelte/icons/shuffle';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import type { SongRowActions, SongRowData, SongRowFlags } from '$lib/components/song-row-types';

	// Mirrors the online library: the same shell, the same playlist grid, the
	// same song rows. Only the source differs — the cache rather than the
	// server — so this is the app with no connection, not a separate screen.
	let tracks = $state<CachedTrackMetadata[]>([]);
	let playlists = $state<CachedPlaylist[]>([]);
	// Cover blob URLs by videoId, minted once and revoked on teardown since
	// each holds its blob alive until released.
	let coverUrls = $state<Record<string, string>>({});
	let loaded = $state(false);
	let searchQuery = $state('');
	/** null is the library index; otherwise the playlist being viewed. */
	let openPlaylistId = $state<string | null>(null);

	const byVideoId = $derived(new Map(tracks.map((track) => [track.videoId, track])));

	/**
	 * Playlists with something actually downloaded, keeping their own order.
	 *
	 * One that is entirely still in the cloud would be an empty shelf here, so
	 * it isn't offered at all.
	 */
	const availablePlaylists = $derived.by(() =>
		playlists
			.map((playlist) => ({
				...playlist,
				videoIds: playlist.videoIds.filter((videoId) => byVideoId.has(videoId))
			}))
			.filter((playlist) => playlist.videoIds.length > 0)
	);

	const userPlaylists = $derived(availablePlaylists.filter((p) => p.kind === 'user'));
	const smartPlaylists = $derived(availablePlaylists.filter((p) => p.kind !== 'user'));

	const openPlaylist = $derived(
		availablePlaylists.find((playlist) => playlist.id === openPlaylistId) ?? null
	);

	/** Up to four covers, for a playlist card's mosaic — same as online. */
	function mosaicFor(playlist: { videoIds: string[] }): string[] {
		return playlist.videoIds
			.map((videoId) => coverUrls[videoId])
			.filter((url): url is string => url !== undefined)
			.slice(0, PLAYLIST_MOSAIC_COVER_COUNT);
	}

	const allDownloaded = $derived([...tracks].sort((a, b) => a.title.localeCompare(b.title)));

	const visibleTracks = $derived.by(() => {
		const base = openPlaylist
			? openPlaylist.videoIds
					.map((videoId) => byVideoId.get(videoId))
					.filter((track): track is CachedTrackMetadata => track !== undefined)
			: allDownloaded;
		const query = searchQuery.trim().toLowerCase();
		if (query.length === 0) return base;
		return base.filter((track) => track.title.toLowerCase().includes(query));
	});

	const queueTracks = $derived(
		visibleTracks.map((track) => ({
			videoId: track.videoId,
			title: track.title,
			durationSeconds: track.durationSeconds
		}))
	);

	/** Playlists matching the search, so the index filters like the online one. */
	const matchingUserPlaylists = $derived.by(() => {
		const query = searchQuery.trim().toLowerCase();
		if (query.length === 0) return userPlaylists;
		return userPlaylists.filter((p) => p.name.toLowerCase().includes(query));
	});
	const matchingSmartPlaylists = $derived.by(() => {
		const query = searchQuery.trim().toLowerCase();
		if (query.length === 0) return smartPlaylists;
		return smartPlaylists.filter((p) => p.name.toLowerCase().includes(query));
	});

	onMount(() => {
		let disposed = false;
		const minted: string[] = [];

		Promise.all([listCachedTracks(), readLibrarySnapshot()]).then(async ([found, snapshot]) => {
			if (disposed) return;
			tracks = found;
			playlists = snapshot?.playlists ?? [];
			loaded = true;

			// Covers fill in after the page is up, so it appears at once rather
			// than waiting on every blob.
			for (const track of found) {
				const url = await cachedCoverUrl(track.videoId);
				if (!url) continue;
				if (disposed) {
					URL.revokeObjectURL(url);
					return;
				}
				minted.push(url);
				coverUrls = { ...coverUrls, [track.videoId]: url };
			}
		});

		return () => {
			disposed = true;
			for (const url of minted) URL.revokeObjectURL(url);
		};
	});

	function toRowData(track: CachedTrackMetadata): SongRowData {
		return {
			videoId: track.videoId,
			title: track.title,
			durationSeconds: track.durationSeconds,
			// The cover comes from the cache, keyed by videoId — a presigned URL
			// can't be signed offline. No audio spec, though: that arrives with
			// the stream URL, which needs a server.
			coverUrl: coverUrls[track.videoId] ?? null,
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
			// Everything listed is cached by definition — that is why it appears.
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
			canCopy: false,
			isFirst: false,
			isLast: false,
			canClearCache: false
		};
	}

	function rowActions(index: number): SongRowActions {
		const noop = () => {};
		return {
			// Editing playlists, copying and deleting all need the server, so
			// rows are play-only rather than offering actions that would fail.
			onSelect: noop,
			onPlay: () => void playFrom(index),
			onDownload: noop,
			onMenuOpenChange: noop,
			onAddToQueue: () => void addToQueue(index),
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
		const track = visibleTracks[index];
		if (!track) return;
		if (player.currentTrack?.videoId === track.videoId) {
			await player.togglePlayPause();
			return;
		}
		await player.playQueue(queueTracks, index);
	}

	async function addToQueue(index: number) {
		const track = queueTracks[index];
		if (track) await player.addToQueue([track]);
	}

	async function playAll(shuffle = false) {
		if (queueTracks.length === 0) return;
		await player.playQueue(queueTracks, 0, shuffle);
	}

	function openPlaylistView(id: string) {
		openPlaylistId = id;
		searchQuery = '';
	}

	function backToIndex() {
		openPlaylistId = null;
		searchQuery = '';
	}
</script>

<svelte:head>
	<title>Offline · KRSZ Music</title>
</svelte:head>

{#snippet offlineBadge()}
	<span
		class="bg-muted text-muted-foreground flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px]"
	>
		<CloudOffIcon class="size-3" />
		Offline
	</span>
{/snippet}

{#snippet playlistGrid(items: typeof availablePlaylists)}
	<div
		class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7"
	>
		{#each items as playlist (playlist.id)}
			<PlaylistCard
				name={playlist.name}
				coverUrls={mosaicFor(playlist)}
				subtitle="{playlist.videoIds.length} {playlist.videoIds.length === 1
					? 'song'
					: 'songs'} downloaded"
				onclick={() => openPlaylistView(playlist.id)}
			>
				{#snippet emptyIcon()}
					<ListMusicIcon class="text-muted-foreground size-8" />
				{/snippet}
			</PlaylistCard>
		{/each}
	</div>
{/snippet}

{#snippet songs()}
	{#if viewMode.mode === 'grid'}
		<div
			class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8"
		>
			{#each visibleTracks as track, index (track.videoId)}
				<SongCard song={toRowData(track)} flags={rowFlags(track)} actions={rowActions(index)} />
			{/each}
		</div>
	{:else}
		<ul class="flex flex-col">
			{#each visibleTracks as track, index (track.videoId)}
				<SongRow song={toRowData(track)} flags={rowFlags(track)} actions={rowActions(index)} />
			{/each}
		</ul>
	{/if}
{/snippet}

<AppShell
	sidebarPlaylists={userPlaylists.map((p) => ({ id: p.id, name: p.name }))}
	sidebarSmartPlaylists={smartPlaylists.map((p) => ({ id: p.id, name: p.name }))}
	statusBadge={offlineBadge}
	onPlaylistSelect={openPlaylistView}
	offline
>
	<div class="mx-auto max-w-screen-2xl p-4 md:p-8">
		{#if !loaded}
			<div class="text-muted-foreground py-16 text-center text-sm">Loading…</div>
		{:else if tracks.length === 0}
			<EmptyState message="No songs are downloaded on this device.">
				{#snippet icon()}
					<CloudOffIcon class="text-muted-foreground size-8" />
				{/snippet}
				<p class="text-muted-foreground max-w-sm text-xs">
					Download songs while you're online — from a playlist, or from Settings → Manage storage —
					and they'll play here with no connection.
				</p>
			</EmptyState>
		{:else if openPlaylist}
			<!-- A playlist, laid out like its online counterpart. -->
			<Button variant="ghost" size="sm" class="mb-4 -ml-2 gap-1.5" onclick={backToIndex}>
				<ArrowLeftIcon class="size-4" />
				Library
			</Button>

			<div class="mb-6 flex flex-wrap items-center justify-between gap-4">
				<div class="min-w-0">
					<h1 class="truncate text-lg font-medium">{openPlaylist.name}</h1>
					<p class="text-muted-foreground text-xs">
						{openPlaylist.videoIds.length}
						{openPlaylist.videoIds.length === 1 ? 'song' : 'songs'} downloaded
					</p>
				</div>
				<div class="flex items-center gap-2">
					<Button size="sm" class="gap-1.5" onclick={() => playAll()}>
						<PlayIcon class="size-4" />
						Play
					</Button>
					<Button size="sm" variant="outline" class="gap-1.5" onclick={() => playAll(true)}>
						<ShuffleIcon class="size-4" />
						Shuffle
					</Button>
				</div>
			</div>

			<div class="mb-3 flex flex-wrap items-center gap-2">
				<SearchField bind:value={searchQuery} placeholder="Search songs…" />
				<ViewModeToggle />
			</div>

			{#if visibleTracks.length === 0}
				<p class="text-muted-foreground py-8 text-center text-sm">
					No downloaded songs match "{searchQuery}".
				</p>
			{:else}
				{@render songs()}
			{/if}
		{:else}
			<!-- The library index, laid out like its online counterpart. -->
			<div class="mb-6 flex flex-wrap items-center gap-2">
				<SearchField bind:value={searchQuery} placeholder="Search playlists and songs…" />
				<ViewModeToggle />
			</div>

			{#if matchingUserPlaylists.length > 0}
				<h1 class="mb-6 text-lg font-medium">Your playlists</h1>
				<div class="mb-8">
					{@render playlistGrid(matchingUserPlaylists)}
				</div>
			{/if}

			{#if matchingSmartPlaylists.length > 0}
				<h2 class="text-muted-foreground mb-4 text-sm font-medium">Smart Playlists</h2>
				<div class="mb-8">
					{@render playlistGrid(matchingSmartPlaylists)}
				</div>
			{/if}

			<div class="mb-4 flex flex-wrap items-center justify-between gap-4">
				<div>
					<h2 class="text-lg font-medium">All downloaded</h2>
					<p class="text-muted-foreground text-xs">
						{visibleTracks.length}
						{visibleTracks.length === 1 ? 'song' : 'songs'} · available without a connection
					</p>
				</div>
				{#if visibleTracks.length > 0}
					<div class="flex items-center gap-2">
						<Button size="sm" class="gap-1.5" onclick={() => playAll()}>
							<PlayIcon class="size-4" />
							Play
						</Button>
						<Button size="sm" variant="outline" class="gap-1.5" onclick={() => playAll(true)}>
							<ShuffleIcon class="size-4" />
							Shuffle
						</Button>
					</div>
				{/if}
			</div>

			{#if visibleTracks.length === 0}
				<p class="text-muted-foreground py-8 text-center text-sm">
					No downloaded songs match "{searchQuery}".
				</p>
			{:else}
				{@render songs()}
			{/if}
		{/if}
	</div>
</AppShell>
