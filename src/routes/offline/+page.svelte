<script lang="ts">
	import { onMount } from 'svelte';
	import { player } from '$lib/client/player.svelte';
	import { viewMode } from '$lib/client/view-mode.svelte';
	import {
		listCachedTracks,
		cachedCoverUrl,
		readLibrarySnapshot
	} from '$lib/client/offline-cache';
	import type { CachedPlaylist, CachedTrackMetadata } from '$lib/shared/audio-cache-key';
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
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import { isTouchDevice } from '$lib/client/motion';
	import type { SongRowActions, SongRowData, SongRowFlags } from '$lib/components/song-row-types';

	// The same components the online library uses, so this is the app rather
	// than a fallback page — the only difference is where the songs come from,
	// which is the cache instead of the server.
	let tracks = $state<CachedTrackMetadata[]>([]);
	let playlists = $state<CachedPlaylist[]>([]);
	// Cover blob URLs by videoId. Resolved once and revoked on teardown, since
	// each createObjectURL holds its blob alive until it is released.
	let coverUrls = $state<Record<string, string>>({});
	let loaded = $state(false);
	let searchQuery = $state('');
	let backOnline = $state(false);
	/** null means "everything downloaded"; otherwise a playlist id. */
	let selectedPlaylistId = $state<string | null>(null);

	const tooltipsDisabled = isTouchDevice();

	const byVideoId = $derived(new Map(tracks.map((track) => [track.videoId, track])));

	/**
	 * Only playlists with something actually downloaded, in their own order.
	 *
	 * A playlist whose songs are all still in the cloud would be an empty
	 * shelf offline, so it isn't offered at all.
	 */
	const availablePlaylists = $derived.by(() =>
		playlists
			.map((playlist) => ({
				...playlist,
				videoIds: playlist.videoIds.filter((videoId) => byVideoId.has(videoId))
			}))
			.filter((playlist) => playlist.videoIds.length > 0)
	);

	const selectedPlaylist = $derived(
		availablePlaylists.find((playlist) => playlist.id === selectedPlaylistId) ?? null
	);

	const visibleTracks = $derived.by(() => {
		// A playlist keeps its own stored order; the all-downloaded view has no
		// order of its own, so it sorts by title.
		const base = selectedPlaylist
			? selectedPlaylist.videoIds
					.map((videoId) => byVideoId.get(videoId))
					.filter((track): track is CachedTrackMetadata => track !== undefined)
			: [...tracks].sort((a, b) => a.title.localeCompare(b.title));

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

	onMount(() => {
		let disposed = false;
		const minted: string[] = [];

		Promise.all([listCachedTracks(), readLibrarySnapshot()]).then(async ([found, snapshot]) => {
			if (disposed) return;
			tracks = found;
			playlists = snapshot?.playlists ?? [];
			loaded = true;

			// Covers resolve after the list is up, so the page appears at once
			// and fills in rather than waiting on every blob.
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

		const onOnline = () => (backOnline = true);
		window.addEventListener('online', onOnline);
		if (navigator.onLine) backOnline = true;

		return () => {
			disposed = true;
			window.removeEventListener('online', onOnline);
			for (const url of minted) URL.revokeObjectURL(url);
		};
	});

	function toRowData(track: CachedTrackMetadata): SongRowData {
		return {
			videoId: track.videoId,
			title: track.title,
			durationSeconds: track.durationSeconds,
			// The cover comes from the cache, keyed by videoId — a presigned URL
			// can't be minted offline. No audio spec, though: that arrives with
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
			// Everything listed is cached by definition — that is the only
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

	function rowActions(index: number): SongRowActions {
		const noop = () => {};
		return {
			// Editing a playlist, copying or deleting all need the server, so
			// rows are play-only here rather than offering actions that fail.
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
</script>

<svelte:head>
	<title>Offline · KRSZ Music</title>
</svelte:head>

<Tooltip.Provider disabled={tooltipsDisabled}>
	<div class="flex h-svh flex-col bg-background">
		<header class="flex shrink-0 items-center gap-2 border-b border-border p-3">
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
					<div class="min-w-0">
						<h1 class="truncate text-lg font-medium">
							{selectedPlaylist ? selectedPlaylist.name : 'Downloaded'}
						</h1>
						<p class="text-xs text-muted-foreground">
							{#if !loaded}
								Looking for downloaded songs…
							{:else if tracks.length === 0}
								Nothing on this device yet
							{:else}
								{visibleTracks.length}
								{visibleTracks.length === 1 ? 'song' : 'songs'} · available without a connection
							{/if}
						</p>
					</div>
					<div class="flex items-center gap-2">
						{#if loaded && visibleTracks.length > 0}
							<Button size="sm" class="gap-1.5" onclick={() => playAll()}>Play</Button>
							<Button size="sm" variant="outline" class="gap-1.5" onclick={() => playAll(true)}>
								Shuffle
							</Button>
						{/if}
						{#if backOnline}
							<Button href="/library" size="sm" variant="outline" class="gap-1.5">
								<RefreshCwIcon class="size-4" />
								Back online
							</Button>
						{/if}
					</div>
				</div>

				{#if loaded && availablePlaylists.length > 0}
					<!-- Horizontal rather than a sidebar: this page is one column,
					     and the list is short since only playlists with something
					     downloaded appear. -->
					<div class="mb-4 flex gap-2 overflow-x-auto pb-1">
						<Button
							size="sm"
							variant={selectedPlaylistId === null ? 'default' : 'outline'}
							class="shrink-0 gap-1.5"
							onclick={() => (selectedPlaylistId = null)}
						>
							All downloaded
						</Button>
						{#each availablePlaylists as playlist (playlist.id)}
							<Button
								size="sm"
								variant={selectedPlaylistId === playlist.id ? 'default' : 'outline'}
								class="shrink-0 gap-1.5"
								onclick={() => (selectedPlaylistId = playlist.id)}
							>
								<ListMusicIcon class="size-3.5" />
								{playlist.name}
								<span class="text-[11px] opacity-70">{playlist.videoIds.length}</span>
							</Button>
						{/each}
					</div>
				{/if}

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
				{:else if visibleTracks.length === 0}
					<p class="py-8 text-center text-sm text-muted-foreground">
						{searchQuery.trim().length > 0
							? `No downloaded songs match "${searchQuery}".`
							: 'Nothing downloaded from this playlist yet.'}
					</p>
				{:else if viewMode.mode === 'grid'}
					<div
						class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8"
					>
						{#each visibleTracks as track, index (track.videoId)}
							<SongCard
								song={toRowData(track)}
								flags={rowFlags(track)}
								actions={rowActions(index)}
							/>
						{/each}
					</div>
				{:else}
					<ul class="flex flex-col">
						{#each visibleTracks as track, index (track.videoId)}
							<SongRow song={toRowData(track)} flags={rowFlags(track)} actions={rowActions(index)} />
						{/each}
					</ul>
				{/if}
			</div>
		</main>

		<PlayerBar />
	</div>
</Tooltip.Provider>
