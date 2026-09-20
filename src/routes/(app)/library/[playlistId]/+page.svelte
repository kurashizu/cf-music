<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { player } from '$lib/client/player.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import ShuffleIcon from '@lucide/svelte/icons/shuffle';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
	import MusicIcon from '@lucide/svelte/icons/music';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import XIcon from '@lucide/svelte/icons/x';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ListPlusIcon from '@lucide/svelte/icons/list-plus';
	import CheckIcon from '@lucide/svelte/icons/check';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import { untrack, onMount } from 'svelte';
	import { flip } from 'svelte/animate';
	import { slide, scale } from 'svelte/transition';
	import { motionParams } from '$lib/client/motion';
	import { downloadSongForOffline, listCachedVideoIds } from '$lib/client/offline-cache';
	import { viewMode } from '$lib/client/view-mode.svelte';
	import ViewModeToggle from '$lib/components/view-mode-toggle.svelte';
	import InfiniteScrollSentinel from '$lib/components/infinite-scroll-sentinel.svelte';
	import ThrottledImage from '$lib/components/throttled-image.svelte';
	import { Input } from '$lib/components/ui/input/index.js';
	import SongSortFilterBar from '$lib/components/song-sort-filter-bar.svelte';
	import { sortIndices, matchesDurationRange, type SongSortField, type SortDirection } from '$lib/shared/song-sort-filter';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let cachedVideoIds = $state<Set<string>>(new Set());
	onMount(() => {
		listCachedVideoIds().then((ids) => {
			cachedVideoIds = new Set(ids);
		});
	});

	type Song = (typeof data.playlist.songs)[number];

	/**
	 * Every song in the playlist by its position, with holes where a page
	 * hasn't been fetched yet — the server only sends the first screenful
	 * (see +page.server.ts) and the rest arrives as the list is scrolled,
	 * searched or queued.
	 *
	 * Sparse rather than "however many are loaded so far" deliberately: a
	 * dense array conflates position with loaded-ness, so `songs[i]` was only
	 * the i-th song while every earlier page happened to be present, and a
	 * fetch landing out of order silently misaligned the list. Holes make
	 * "not loaded yet" a property of the slot instead.
	 *
	 * Mirrored into local state so drag-to-reorder can preview a new order
	 * before the PUT resolves; re-synced only when the *server* value changes
	 * reference (navigation, or invalidateAll() after a remove), since
	 * comparing against the local copy would snap a live drag back the
	 * instant it diverges.
	 */
	function seedSongs(loaded: Song[]): (Song | undefined)[] {
		// .fill() matters: a bare `new Array(n)` has genuine holes, which
		// map/filter skip entirely rather than visiting as undefined — so the
		// "which positions are still missing" scan would come back empty.
		const all = new Array<Song | undefined>(data.totalSongCount).fill(undefined);
		loaded.forEach((song, i) => (all[i] = song));
		return all;
	}
	let songs = $state<(Song | undefined)[]>(untrack(() => seedSongs(data.playlist.songs)));
	let lastServerSongs = untrack(() => data.playlist.songs);
	$effect(() => {
		if (data.playlist.songs !== lastServerSongs) {
			lastServerSongs = data.playlist.songs;
			songs = seedSongs(data.playlist.songs);
		}
	});

	/** Songs actually fetched so far, in playlist order — holes dropped. */
	const loadedSongs = $derived(songs.filter((s): s is Song => s !== undefined));

	// draggingIndex/overIndex describe the drag purely in terms of the
	// *original* indices in `songs`. The list below renders using this
	// pair to compute each row's visual `order` (CSS), instead of
	// splicing `songs` itself on every dragover — splicing would move the
	// keyed DOM node the browser is actively tracking mid-drag, which is
	// what caused focus/hover state to jump around during a drag.
	// `songs` is only actually reordered once, on drop.
	let draggingIndex = $state<number | null>(null);
	let overIndex = $state<number | null>(null);
	let removeTarget = $state<{ videoId: string; title: string } | null>(null);
	let removeSubmitting = $state(false);
	let deleteTarget = $state<{ videoId: string; title: string } | null>(null);
	let deleteSubmitting = $state(false);
	let downloadingVideoId = $state<string | null>(null);
	let copyTarget = $state<string | null>(null); // videoId, or null when copying/moving the current selection
	let copyDialogOpen = $state(false);
	let copyDialogMode = $state<'copy' | 'move'>('copy');
	let copySubmitting = $state(false);
	let copyingPlaylistId = $state<string | null>(null);

	function openCopyDialogForSong(videoId: string, mode: 'copy' | 'move') {
		copyTarget = videoId;
		copyDialogMode = mode;
		copyDialogOpen = true;
	}

	function openCopyDialogForSelection(mode: 'copy' | 'move') {
		copyTarget = null;
		copyDialogMode = mode;
		copyDialogOpen = true;
	}

	let selected = $state<Set<string>>(new Set());
	let batchWorking = $state(false);
	let batchRemoveConfirm = $state(false);
	let batchDeleteConfirm = $state(false);
	let searchQuery = $state('');
	let sortField = $state<SongSortField>('custom');
	let sortDirection = $state<SortDirection>('asc');
	let artistFilter = $state<string>('all');
	let minDurationMinutes = $state('');
	let maxDurationMinutes = $state('');

	const artistOptions = $derived(
		[...new Set(loadedSongs.map((s) => s.artist).filter((a): a is string => a !== null))].sort((a, b) =>
			a.localeCompare(b)
		)
	);

	const SORT_OPTIONS = [
		{ value: 'custom' as const, label: 'Custom order' },
		{ value: 'title' as const, label: 'Title' },
		{ value: 'artist' as const, label: 'Artist' },
		{ value: 'duration' as const, label: 'Duration' },
		{ value: 'addedAt' as const, label: 'Date added' }
	];
	// Separate from batchWorking (shared by every other batch action) since
	// downloads need to report how many of the selection have finished so
	// far, not just "still running" — each one now genuinely waits for its
	// own download to complete (see offline-cache.ts), so a plain spinner
	// with no count would sit there for however long the whole batch takes
	// with zero indication of progress.
	let batchDownloadProgress = $state<{ completed: number; total: number } | null>(null);

	// Auto-generated playlists (Artists groupings, play-history
	// recommendations — see smart-playlists.ts) are wholly read-only: no
	// remove/move-out/reorder, same restriction the server enforces via
	// assertNotAutoGenerated in playlists.ts. Combined with the existing
	// default-playlist restriction below since every one of these UI gates
	// already had to check that.
	const isAutoGenerated = $derived(data.playlist.kind === 'auto_generated');
	const isReadOnly = $derived(data.isDefaultPlaylist || isAutoGenerated);

	// Whether the view is showing every song in its real playlist order —
	// drag-to-reorder (index-based, see visualOrder/handleDragOver) only
	// makes sense against that order, so it's disabled the instant a
	// search, filter, or non-custom sort changes what's rendered.
	const isCustomUnfilteredView = $derived(
		searchQuery.trim().length === 0 &&
			sortField === 'custom' &&
			artistFilter === 'all' &&
			minDurationMinutes.trim() === '' &&
			maxDurationMinutes.trim() === ''
	);

	// A large playlist's own song *data* (not just covers — title, artist,
	// duration, everything) is only loaded a page at a time, same idea as
	// the cover presigning further down — see totalSongCount/loadMore.
	// Search, sort, and any filter besides "custom order" all need to see
	// every song to give correct results, not just whatever's scrolled
	// into view so far, so leaving the plain custom-order view loads
	// everything still missing up front rather than searching/sorting a
	// partial list.
	const allSongsLoaded = $derived(loadedSongs.length >= data.totalSongCount);
	let loadingAllSongs = $state(false);
	async function ensureAllSongsLoaded() {
		if (allSongsLoaded || loadingAllSongs) return;
		loadingAllSongs = true;
		try {
			const missing = songs.map((song, i) => (song ? -1 : i)).filter((i) => i >= 0);
			await fetchMissingSongData(missing);
		} finally {
			loadingAllSongs = false;
		}
	}
	$effect(() => {
		if (!isCustomUnfilteredView) ensureAllSongsLoaded();
	});

	// Indices, filtered by title/artist/duration and reordered by the
	// active sort — see isCustomUnfilteredView above for why drag is
	// disabled whenever this diverges from the plain identity order.
	//
	// The plain custom-order case (no search/sort/filter engaged) is the
	// only one that can run before every song is loaded — ensureAllSongsLoaded
	// guarantees `songs.length === data.totalSongCount` for every other
	// case, so it's the only branch that needs to reach past `songs`' own
	// current length up to the playlist's real size, letting loadMore/the
	// scroll sentinel keep revealing (and thus fetching) indices beyond
	// what's loaded so far instead of stopping dead at songs.length.
	const visibleIndices = $derived.by(() => {
		if (isCustomUnfilteredView) {
			return Array.from({ length: data.totalSongCount }, (_, i) => i);
		}
		const query = searchQuery.trim().toLowerCase();
		const minSeconds = minDurationMinutes.trim() === '' ? null : Number(minDurationMinutes) * 60;
		const maxSeconds = maxDurationMinutes.trim() === '' ? null : Number(maxDurationMinutes) * 60;
		let indices = songs
			.map((s, i) => [s, i] as const)
			.filter((entry): entry is readonly [Song, number] => entry[0] !== undefined)
			.filter(([s]) => {
				if (query.length > 0 && !s.title.toLowerCase().includes(query)) return false;
				if (artistFilter !== 'all' && s.artist !== artistFilter) return false;
				if (!matchesDurationRange(s.durationSeconds, { minSeconds, maxSeconds })) return false;
				return true;
			})
			.map(([, i]) => i);
		return sortIndices(songs as Song[], indices, sortField, sortDirection);
	});

	const PAGE_SIZE = 20;
	/** Mirrors MAX_RANGE_LIMIT in the songs range endpoint, which clamps rather than errors. */
	const MAX_RANGE_PER_REQUEST = 100;
	let visibleCount = $state(PAGE_SIZE);
	// What's actually rendered — a further slice of visibleIndices, clamped
	// to indices `songs` actually has data for yet. In the custom-order
	// case, visibleIndices can extend past songs.length (see its own
	// comment) purely so loadMore has real indices to request — but until
	// that fetch resolves and songs grows, rendering one would be reading
	// past the array. Drag stays index-correct either way
	// (visualOrder/handleDragOver work off real indices into `songs`, not
	// the windowed render position), but it's disabled while windowed
	// anyway (see `draggable` below) since dragging a song past the last
	// *rendered* row while more remain unloaded below it would be
	// confusing.
	const windowedIndices = $derived(
		visibleIndices.slice(0, visibleCount).filter((i) => songs[i] !== undefined)
	);

	// The server only loads+presigns the first INITIAL_PAGE_SIZE songs on
	// initial load (see +page.server.ts) — `songs` starts shorter than the
	// playlist actually is, and grows in place as more real rows are
	// fetched here, rather than every song's full data being read from D1
	// (and its cover presigned) on every visit regardless of how much of
	// the playlist is ever actually scrolled to.
	const songFetchInFlight = new Set<number>();
	/**
	 * Fetches any of `indices` whose slot is still empty and writes each song
	 * to its own position.
	 *
	 * Writing by position (rather than appending) is what lets pages arrive in
	 * any order, overlap, or be requested out of sequence without the list
	 * losing alignment — the server returns a range starting at a known
	 * offset, so every row has an unambiguous home.
	 */
	async function fetchMissingSongData(indices: number[]) {
		const missing = indices.filter((i) => songs[i] === undefined && !songFetchInFlight.has(i));
		if (missing.length === 0) return;

		// One range request per contiguous run, rather than one per song, split
		// again at MAX_RANGE_PER_REQUEST: the endpoint silently clamps a larger
		// limit, so asking for more than it serves would leave the tail of the
		// range permanently unfilled.
		missing.sort((a, b) => a - b);
		const runs: [number, number][] = [];
		let start = missing[0];
		let prev = missing[0];
		for (const i of missing.slice(1)) {
			if (i !== prev + 1) {
				runs.push([start, prev]);
				start = i;
			}
			prev = i;
		}
		runs.push([start, prev]);

		const ranges: [number, number][] = [];
		for (const [from, to] of runs) {
			for (let at = from; at <= to; at += MAX_RANGE_PER_REQUEST) {
				ranges.push([at, Math.min(to, at + MAX_RANGE_PER_REQUEST - 1)]);
			}
		}

		for (const i of missing) songFetchInFlight.add(i);
		try {
			const results = await Promise.all(
				ranges.map(([from, to]) =>
					fetch(`/api/playlists/${data.playlist.id}/songs?offset=${from}&limit=${to - from + 1}`).then(
						(r) => (r.ok ? r.json() : { songs: [], offset: from }) as Promise<{
							songs: Song[];
							offset: number;
						}>
					)
				)
			);
			// One new array so Svelte sees the change; each song lands at the
			// offset the server reported it from.
			const next = [...songs];
			for (const result of results) {
				result.songs.forEach((song, i) => (next[result.offset + i] = song));
			}
			songs = next;
		} finally {
			for (const i of missing) songFetchInFlight.delete(i);
		}
	}

	function loadMore() {
		const nextCount = Math.min(visibleIndices.length, visibleCount + PAGE_SIZE);
		const newlyVisible = visibleIndices.slice(visibleCount, nextCount);
		visibleCount = nextCount;
		fetchMissingSongData(newlyVisible);
	}

	// A search/sort/filter change resets the window back to the first
	// PAGE_SIZE of whatever now matches — by the time this runs, either
	// everything is already loaded (ensureAllSongsLoaded, for any
	// non-custom-order view) or this is the plain scrolling case, where
	// the reset window may reach indices loadMore hasn't fetched yet.
	//
	// Keyed on the query/sort/filter values themselves, NOT on
	// visibleIndices. That array is rebuilt on every `songs` change, so
	// depending on it made loading a page undo itself: loadMore raised
	// visibleCount, the fetch it triggered grew `songs`, visibleIndices was
	// recomputed into a fresh array, and this effect reset visibleCount
	// straight back to PAGE_SIZE — pinning the list at its first page.
	$effect(() => {
		searchQuery;
		sortField;
		sortDirection;
		artistFilter;
		minDurationMinutes;
		maxDurationMinutes;
		visibleCount = PAGE_SIZE;
		fetchMissingSongData(untrack(() => visibleIndices).slice(0, PAGE_SIZE));
	});

	// Which row's "…" menu is open, if any — see the menus' own {#if} for why
	// only one is ever instantiated at a time.
	let openRowMenuVideoId = $state<string | null>(null);

	let lastSelectedIndex = $state<number | null>(null);

	// "Select all" only ever targets what's actually visible (the filtered/
	// searched view) — selecting rows hidden by a search would be
	// surprising, since the toolbar's count wouldn't match what's on
	// screen. Scoped to `windowedIndices`, not the full `visibleIndices`,
	// for the plain custom-order/scrolling case specifically: those can
	// include indices past what's loaded yet (see windowedIndices' own
	// comment), which selected.has()/videoId lookups can't resolve until
	// they're actually fetched. Every other view (search/sort/filter) has
	// already loaded everything by the time this runs (ensureAllSongsLoaded),
	// so windowedIndices and visibleIndices agree there regardless.
	const allVisibleSelected = $derived(
		windowedIndices.length > 0 && windowedIndices.every((i) => selected.has(songs[i]!.videoId))
	);

	function toggleSelectAll() {
		if (allVisibleSelected) {
			clearSelection();
			return;
		}
		selected = new Set(windowedIndices.map((i) => songs[i]!.videoId));
		lastSelectedIndex = windowedIndices[windowedIndices.length - 1] ?? null;
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

	// File-manager-style row selection: plain click selects only this row,
	// ctrl/cmd-click toggles it into/out of the existing selection, and
	// shift-click extends the selection from the last click to here — all
	// against `visibleIndices` (the filtered/rendered order), since a range
	// select while searching should span what's on screen, not the full
	// underlying playlist.
	function handleRowClick(event: MouseEvent, index: number) {
		const videoId = songs[index]?.videoId;
		if (!videoId) return;
		if (event.shiftKey && lastSelectedIndex !== null) {
			const [from, to] = [lastSelectedIndex, index].sort((a, b) => a - b);
			const range = visibleIndices.filter((i) => i >= from && i <= to);
			const next = new Set(selected);
			for (const i of range) {
				const atIndex = songs[i];
				if (atIndex) next.add(atIndex.videoId);
			}
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

	const isThisPlaylistPlaying = $derived(
		player.isPlaying && loadedSongs.some((s) => s.videoId === player.currentTrack?.videoId)
	);

	function toQueueTracks() {
		return loadedSongs.map((s) => ({
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
		if (data.totalSongCount === 0) return;
		// The queue needs every track, not just whatever's loaded so far —
		// see ensureAllSongsLoaded's own comment.
		await ensureAllSongsLoaded();
		await player.playQueue(toQueueTracks(), 0, shuffle);
	}

	async function playFrom(index: number) {
		if (player.currentTrack?.videoId === songs[index]?.videoId) {
			await player.togglePlayPause();
			return;
		}
		// Queueing the playlist needs every song, not just the rows rendered so
		// far. Rows already on screen keep their identity while the gaps fill
		// in (see `songs`), so this no longer disturbs the scroll position.
		await ensureAllSongsLoaded();
		await player.playQueue(toQueueTracks(), index);
	}

	async function addToQueue(index: number) {
		const song = songs[index];
		if (!song) return;
		await player.addToQueue([
			{ videoId: song.videoId, title: song.title, durationSeconds: song.durationSeconds }
		]);
		toast.success('Added to queue');
	}

	async function addSelectionToQueue() {
		const tracks = loadedSongs
			.filter((s) => selected.has(s.videoId))
			.map((s) => ({ videoId: s.videoId, title: s.title, durationSeconds: s.durationSeconds }));
		if (tracks.length === 0) return;
		await player.addToQueue(tracks);
		toast.success(`Added ${tracks.length} song(s) to queue`);
		clearSelection();
	}

	async function handleRemove() {
		if (!removeTarget) return;
		removeSubmitting = true;
		try {
			const response = await fetch(
				`/api/playlists/${data.playlist.id}/songs/${removeTarget.videoId}`,
				{ method: 'DELETE' }
			);
			if (!response.ok) {
				toast.error('Failed to remove song');
				return;
			}
			toast.success('Removed from playlist');
			removeTarget = null;
			await invalidateAll();
		} catch {
			toast.error('Failed to remove song');
		} finally {
			removeSubmitting = false;
		}
	}

	// Distinct from handleRemove: this deletes the song itself (see
	// DELETE /api/songs/[videoId] — evictSongForUser), not just its
	// membership in this one playlist. It disappears from every playlist
	// it was in, and its storage is freed if no one else still references
	// it (songs are deduplicated/shared across users' libraries).
	async function handleDelete() {
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
		} catch {
			toast.error('Failed to delete song');
		} finally {
			deleteSubmitting = false;
		}
	}

	// copyTarget === null means "act on the current selection"; otherwise
	// it's a single song's videoId (from a row's own dropdown menu). Shared
	// by both Copy To and Move To — copyDialogMode decides which the
	// server actually does (see the PUT route's own mode handling).
	async function handleCopyOrMove(toPlaylistId: string) {
		const isBatch = copyTarget === null;
		const videoIds = isBatch ? [...selected] : [copyTarget];
		if (videoIds.length === 0) return;
		const mode = copyDialogMode;
		copySubmitting = true;
		copyingPlaylistId = toPlaylistId;
		try {
			const results = await Promise.all(
				videoIds.map((videoId) =>
					fetch(`/api/playlists/${data.playlist.id}/songs/${videoId}`, {
						method: 'PUT',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ toPlaylistId, mode })
					})
				)
			);
			const failures = results.filter((r) => !r.ok).length;
			const verb = mode === 'move' ? 'Moved' : 'Copied';
			toast[failures === 0 ? 'success' : 'error'](
				failures === 0
					? videoIds.length === 1
						? `${verb} to playlist`
						: `${verb} ${videoIds.length} songs`
					: `Failed to ${mode} ${failures} song(s)`
			);
			copyDialogOpen = false;
			copyTarget = null;
			if (mode === 'move' || isBatch) await invalidateAll();
			if (isBatch) clearSelection();
		} finally {
			copySubmitting = false;
			copyingPlaylistId = null;
		}
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

	// Downloads a fixed number of songs at a time rather than all at once —
	// each call now genuinely waits for its own download to finish (see
	// offline-cache.ts's PRECACHE_AUDIO reply), so firing every selected
	// song's download simultaneously would pile dozens of concurrent large
	// fetches onto the service worker and the S3 origin behind it at once.
	// Fully serial (one at a time) would be correspondingly slow for a
	// large selection, with no benefit over a small concurrency window.
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

	async function handleBatchRemove() {
		batchWorking = true;
		try {
			const results = await Promise.all(
				[...selected].map((videoId) =>
					fetch(`/api/playlists/${data.playlist.id}/songs/${videoId}`, { method: 'DELETE' })
				)
			);
			const failures = results.filter((r) => !r.ok).length;
			toast[failures === 0 ? 'success' : 'error'](
				failures === 0 ? 'Removed from playlist' : `Failed to remove ${failures} song(s)`
			);
			batchRemoveConfirm = false;
			clearSelection();
			await invalidateAll();
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

	function handleDragStart(index: number) {
		draggingIndex = index;
		overIndex = index;
	}

	function handleDragOver(event: DragEvent, index: number) {
		event.preventDefault();
		if (draggingIndex === null) return;
		overIndex = index;
	}

	// FLIP measures every participating row on each list change, which is a
	// forced synchronous layout proportional to how many rows are mounted —
	// and this list only ever grows as you scroll (see visibleCount). The
	// animation only has anything to show during a reorder, so it's given a
	// real duration only when reordering is actually available, and 0
	// (Svelte skips the measure/animate work entirely) otherwise.
	const reorderAnimationDuration = $derived(
		isAutoGenerated || !isCustomUnfilteredView ? 0 : draggingIndex === null ? 200 : 0
	);

	function visualOrder(index: number): number {
		if (draggingIndex === null || overIndex === null || draggingIndex === index) return index;
		if (draggingIndex < overIndex) {
			if (index > draggingIndex && index <= overIndex) return index - 1;
		} else if (index >= overIndex && index < draggingIndex) {
			return index + 1;
		}
		return index;
	}

	/** Persists the current `songs` order to the server, reverting on failure. Shared by both the drag-and-drop and the touch-friendly "Move up/down" menu paths below. */
	async function persistReorder() {
		try {
			const response = await fetch(`/api/playlists/${data.playlist.id}/reorder`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ orderedVideoIds: loadedSongs.map((s) => s.videoId) })
			});
			if (!response.ok) {
				toast.error('Failed to save the new order');
				await invalidateAll();
			}
		} catch {
			toast.error('Failed to save the new order');
			await invalidateAll();
		}
	}

	async function handleDragEnd() {
		if (draggingIndex !== null && overIndex !== null && draggingIndex !== overIndex) {
			const reordered = [...songs];
			const [moved] = reordered.splice(draggingIndex, 1);
			reordered.splice(overIndex, 0, moved);
			songs = reordered;
		}
		draggingIndex = null;
		overIndex = null;
		await persistReorder();
	}

	/**
	 * Touch-friendly reorder fallback: HTML5 drag-and-drop (draggable/
	 * ondragstart/ondragover/ondragend above) never fires from touch
	 * gestures on mobile browsers, so a phone user has no way to reorder
	 * via drag at all — these "Move up"/"Move down" menu items are the
	 * only path that works there. Kept as a single swap (not full DnD
	 * mechanics) since that's all one tap can express.
	 */
	async function moveSong(fromIndex: number, toIndex: number) {
		if (toIndex < 0 || toIndex >= songs.length) return;
		const reordered = [...songs];
		const [moved] = reordered.splice(fromIndex, 1);
		reordered.splice(toIndex, 0, moved);
		songs = reordered;
		await persistReorder();
	}
</script>

<svelte:head>
	<title>{data.playlist.name} · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-screen-2xl p-4 md:p-8">
	<div class="mb-6 flex flex-wrap items-center justify-between gap-4">
		<div class="min-w-0">
			<h1 class="truncate text-lg font-medium">{data.playlist.name}</h1>
			<p class="text-sm text-muted-foreground">
				{data.totalSongCount} {data.totalSongCount === 1 ? 'song' : 'songs'}
				{data.isDefaultPlaylist ? '· Your whole library' : ''}
			</p>
		</div>
		<div class="flex items-center gap-2">
			<Button size="sm" class="gap-1.5" disabled={songs.length === 0} onclick={() => playAll()}>
				{#if isThisPlaylistPlaying}
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
				disabled={songs.length === 0}
				onclick={() => playAll(true)}
			>
				<ShuffleIcon class="size-4" />
				Shuffle
			</Button>
		</div>
	</div>

	{#if songs.length > 0}
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<div class="relative min-w-48 flex-1">
				<SearchIcon class="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input placeholder="Search songs…" bind:value={searchQuery} class="pl-9" />
			</div>
			<SongSortFilterBar
				bind:sortField
				bind:sortDirection
				sortOptions={SORT_OPTIONS}
				bind:artistFilter
				{artistOptions}
				bind:minDurationMinutes
				bind:maxDurationMinutes
				showDurationFilter
			/>
			<Button size="sm" variant="outline" onclick={toggleSelectAll}>
				{allVisibleSelected ? 'Deselect all' : 'Select all'}
			</Button>
			<ViewModeToggle />
		</div>
	{/if}

	{#if selected.size > 0}
		<div
			class="sticky top-0 z-10 mb-2 flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2"
			transition:slide={motionParams({ duration: 150 })}
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
				{#if data.otherPlaylists.length > 0}
					<Button
						size="sm"
						variant="outline"
						class="gap-1.5"
						disabled={batchWorking}
						onclick={() => openCopyDialogForSelection('copy')}
					>
						<ListMusicIcon class="size-3.5" />
						Copy to…
					</Button>
					{#if !isReadOnly}
						<Button
							size="sm"
							variant="outline"
							class="gap-1.5"
							disabled={batchWorking}
							onclick={() => openCopyDialogForSelection('move')}
						>
							<ListMusicIcon class="size-3.5" />
							Move to…
						</Button>
					{/if}
				{/if}
				{#if !isReadOnly}
					<Button
						size="sm"
						variant="outline"
						class="gap-1.5"
						disabled={batchWorking}
						onclick={() => (batchRemoveConfirm = true)}
					>
						<ListMusicIcon class="size-3.5" />
						Remove
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

	{#if songs.length === 0}
		<div class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
			<ListMusicIcon class="size-8 text-muted-foreground" />
			<p class="text-sm text-muted-foreground">This playlist is empty. Import some songs to get started.</p>
		</div>
	{:else if visibleIndices.length === 0}
		<p class="py-8 text-center text-sm text-muted-foreground">
			{searchQuery.trim().length > 0 ? `No songs match "${searchQuery}".` : 'No songs match the current filters.'}
		</p>
	{:else if viewMode.mode === 'grid'}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
			{#each windowedIndices as index (songs[index]!.videoId)}
				{@const song = songs[index]!}
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
								class="absolute top-1 left-1 flex items-center gap-0.5 rounded-full bg-black/75 px-1.5 py-0.5 text-[10px] text-white"
							>
								<CheckIcon class="size-2.5" />
								Cached
							</span>
						{/if}
						{#if song.embeddingStatus === 'done'}
							<span
								class="absolute top-1 right-1 flex items-center gap-0.5 rounded-full bg-black/75 px-1.5 py-0.5 text-[10px] text-white"
							>
								<SparklesIcon class="size-2.5" />
								Embedded
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
							<span
								class="relative flex size-9 items-center justify-center rounded-full bg-black/65 opacity-100 transition-opacity sm:bg-black/75 sm:opacity-0 sm:group-hover:opacity-100"
							>
								{#key player.currentTrack?.videoId === song.videoId && player.isPlaying}
									<span
										class="absolute inset-0 flex items-center justify-center"
										transition:scale={motionParams({ duration: 100, start: 0.7 })}
									>
										{#if player.currentTrack?.videoId === song.videoId && player.isPlaying}
											<PauseIcon class="size-4 text-white" />
										{:else}
											<PlayIcon class="size-4 text-white" />
										{/if}
									</span>
								{/key}
							</span>
						</button>
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<span
							class="absolute top-1 right-1"
							onclick={(e) => e.stopPropagation()}
						>
							<DropdownMenu.Root
								bind:open={
									() => openRowMenuVideoId === song.videoId,
									(open) => (openRowMenuVideoId = open ? song.videoId : null)
								}
							>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="secondary"
											size="icon-sm"
											aria-label="Song options"
											class="opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:data-[state=open]:opacity-100"
										>
											<MoreHorizontalIcon class="size-4" />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								{#if openRowMenuVideoId === song.videoId}
								<DropdownMenu.Content align="end" class="min-w-52">
									<DropdownMenu.Item onclick={() => addToQueue(index)}>
										<ListPlusIcon class="size-4" />
										Add to queue
									</DropdownMenu.Item>
									{#if data.otherPlaylists.length > 0}
										<DropdownMenu.Item onclick={() => openCopyDialogForSong(song.videoId, 'copy')}>
											<ListMusicIcon class="size-4" />
											Copy to playlist…
										</DropdownMenu.Item>
										{#if !isReadOnly}
											<DropdownMenu.Item onclick={() => openCopyDialogForSong(song.videoId, 'move')}>
												<ListMusicIcon class="size-4" />
												Move to playlist…
											</DropdownMenu.Item>
										{/if}
									{/if}
									{#if !isReadOnly}
										<DropdownMenu.Item
											onclick={() => (removeTarget = { videoId: song.videoId, title: song.title })}
										>
											<ListMusicIcon class="size-4" />
											Remove from playlist
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
								{/if}
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
		{#if visibleCount < visibleIndices.length}
			<InfiniteScrollSentinel onIntersect={loadMore} />
		{/if}
	{:else}
		<ul class="flex flex-col">
			{#each windowedIndices as index (songs[index]!.videoId)}
				{@const song = songs[index]!}
				{@const unfiltered = isCustomUnfilteredView}
				{@const draggable = !isAutoGenerated && unfiltered && allSongsLoaded && visibleCount >= visibleIndices.length}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<li
					class="group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors active:bg-muted hover:bg-muted {selected.has(
						song.videoId
					)
						? 'bg-muted ring-1 ring-inset ring-ring/50'
						: player.currentTrack?.videoId === song.videoId
							? 'bg-muted'
							: ''} {draggingIndex === index ? 'opacity-50' : ''}"
					style={draggingIndex === null ? undefined : `order: ${visualOrder(index)}`}
					draggable={draggable}
					ondragstart={() => draggable && handleDragStart(index)}
					ondragover={(e) => draggable && handleDragOver(e, index)}
					ondragend={() => draggable && handleDragEnd()}
					onclick={(e) => handleRowClick(e, index)}
					animate:flip={motionParams({ duration: reorderAnimationDuration })}
				>
					<!-- Deliberately still hover-only, not sm:-gated like the other
					     row controls: HTML5 drag-and-drop never fires from touch
					     gestures, so this handle is genuinely inert on a phone —
					     the "..." menu's Move up/down items are the reorder path
					     there instead (see that menu's own comment). -->
					<button
						type="button"
						class="cursor-grab touch-none text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing {draggable
							? ''
							: 'invisible'}"
						aria-label="Drag to reorder"
						tabindex={draggable ? 0 : -1}
						onclick={(e) => e.stopPropagation()}
					>
						<GripVerticalIcon class="size-4" />
					</button>

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

					{#if song.embeddingStatus === 'done'}
						<span
							class="hidden shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground sm:flex"
						>
							<SparklesIcon class="size-3" />
							Embedded
						</span>
					{/if}

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
						<DropdownMenu.Root
							bind:open={
								() => openRowMenuVideoId === song.videoId,
								(open) => (openRowMenuVideoId = open ? song.videoId : null)
							}
							onOpenChange={(open) => {
								if (open && unfiltered) ensureAllSongsLoaded();
							}}
						>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										variant="ghost"
										size="icon-sm"
										aria-label="Song options"
										class="opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:data-[state=open]:opacity-100"
									>
										<MoreHorizontalIcon class="size-4" />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
						<!-- Only the open row's menu is instantiated. Every row in this
						     list carries one, and the list only grows as you scroll (see
						     visibleCount), so building a menu's positioning/context
						     machinery per row costs frames for UI that is almost never open. -->
						{#if openRowMenuVideoId === song.videoId}
						<DropdownMenu.Content align="end" class="min-w-52">
							<!-- Touch has no persistent hover to reveal the drag handle
							     with (see the handle's own comment below), and HTML5
							     drag-and-drop doesn't fire from touch gestures at all —
							     these two menu items are the only way to reorder a song
							     on a phone. Always shown (not sm:-gated) since desktop
							     users can use them too, drag is just the faster path there.
							     Gated on `unfiltered && allSongsLoaded`, not `draggable` —
							     a plain adjacent swap doesn't care whether every row below
							     has scrolled into *view* yet (unlike drag, see draggable's
							     own comment), but persistReorder submits the *entire*
							     songs array as the playlist's new full order, which the
							     server rejects unless it's exactly every song currently in
							     the playlist — so this still needs everything loaded, just
							     not necessarily windowed/rendered. The dropdown's own
							     onOpenChange above kicks off that load the moment it opens,
							     same as ensureAllSongsLoaded's other callers. -->
							{#if !isAutoGenerated && unfiltered && allSongsLoaded}
								<DropdownMenu.Item disabled={index === 0} onclick={() => moveSong(index, index - 1)}>
									<ArrowUpIcon class="size-4" />
									Move up
								</DropdownMenu.Item>
								<DropdownMenu.Item
									disabled={index === songs.length - 1}
									onclick={() => moveSong(index, index + 1)}
								>
									<ArrowDownIcon class="size-4" />
									Move down
								</DropdownMenu.Item>
							{/if}
							<DropdownMenu.Item onclick={() => addToQueue(index)}>
								<ListPlusIcon class="size-4" />
								Add to queue
							</DropdownMenu.Item>
							{#if data.otherPlaylists.length > 0}
								<DropdownMenu.Item onclick={() => openCopyDialogForSong(song.videoId, 'copy')}>
									<ListMusicIcon class="size-4" />
									Copy to playlist…
								</DropdownMenu.Item>
								{#if !isReadOnly}
									<DropdownMenu.Item onclick={() => openCopyDialogForSong(song.videoId, 'move')}>
										<ListMusicIcon class="size-4" />
										Move to playlist…
									</DropdownMenu.Item>
								{/if}
							{/if}
							{#if !isReadOnly}
								<DropdownMenu.Item
									onclick={() => (removeTarget = { videoId: song.videoId, title: song.title })}
								>
									<ListMusicIcon class="size-4" />
									Remove from playlist
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
						{/if}
						</DropdownMenu.Root>
					</span>
				</li>
			{/each}
		</ul>
		{#if visibleCount < visibleIndices.length}
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
			<Dialog.Title>{copyDialogMode === 'move' ? 'Move' : 'Copy'} to playlist</Dialog.Title>
			<Dialog.Description>
				{copyTarget !== null ? 'This song' : `${selected.size} song(s)`}
				{copyDialogMode === 'move'
					? 'will be moved to the playlist you pick, removed from here.'
					: 'will also be added to the playlist you pick — it stays here too.'}
			</Dialog.Description>
		</Dialog.Header>
		<ul class="flex max-h-64 flex-col gap-1 overflow-y-auto">
			{#each data.otherPlaylists as playlist (playlist.id)}
				<li>
					<Button
						variant="outline"
						class="w-full justify-start gap-2"
						disabled={copySubmitting}
						onclick={() => handleCopyOrMove(playlist.id)}
					>
						{#if copyingPlaylistId === playlist.id}
							<LoaderCircleIcon class="size-3.5 animate-spin" />
						{/if}
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

<Dialog.Root open={removeTarget !== null} onOpenChange={(open) => !open && (removeTarget = null)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Remove "{removeTarget?.title}"?</Dialog.Title>
			<Dialog.Description>This only removes it from this playlist.</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (removeTarget = null)}>Cancel</Button>
			<Button variant="destructive" disabled={removeSubmitting} onclick={handleRemove}>
				{removeSubmitting ? 'Removing…' : 'Remove'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={batchRemoveConfirm} onOpenChange={(open) => !open && (batchRemoveConfirm = false)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Remove {selected.size} songs?</Dialog.Title>
			<Dialog.Description>This only removes them from this playlist.</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (batchRemoveConfirm = false)}>Cancel</Button>
			<Button variant="destructive" disabled={batchWorking} onclick={handleBatchRemove}>
				{batchWorking ? 'Removing…' : 'Remove'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={batchDeleteConfirm} onOpenChange={(open) => !open && (batchDeleteConfirm = false)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Delete {selected.size} songs?</Dialog.Title>
			<Dialog.Description>
				This deletes them from your library entirely, not just this playlist. This can't be undone.
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

<Dialog.Root open={deleteTarget !== null} onOpenChange={(open) => !open && (deleteTarget = null)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Delete "{deleteTarget?.title}"?</Dialog.Title>
			<Dialog.Description>
				This deletes the song from your library entirely, not just this playlist — it disappears from
				every playlist it's in. This can't be undone.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteTarget = null)}>Cancel</Button>
			<Button variant="destructive" disabled={deleteSubmitting} onclick={handleDelete}>
				{deleteSubmitting ? 'Deleting…' : 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
