<script lang="ts">
	import { formatDuration } from '$lib/shared/format';
	import { apiErrorMessage } from '$lib/client/api-error';
	import SearchField from '$lib/components/search-field.svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { flip } from 'svelte/animate';
	import { motionParams } from '$lib/client/motion';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ListMusicIcon from '@lucide/svelte/icons/list-music';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import MoreVerticalIcon from '@lucide/svelte/icons/more-vertical';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import UserIcon from '@lucide/svelte/icons/user';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import MusicIcon from '@lucide/svelte/icons/music';
	import PlaylistCard from '$lib/components/playlist-card.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import { player } from '$lib/client/player.svelte';
	import SongSortFilterBar from '$lib/components/song-sort-filter-bar.svelte';
	import {
		sortSongs,
		matchesDurationRange,
		type SongSortField,
		type SortDirection
	} from '$lib/shared/song-sort-filter';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let createOpen = $state(false);
	let createName = $state('');
	let createSubmitting = $state(false);

	let searchQuery = $state('');
	let artistFilter = $state<string>('all');
	let sortField = $state<SongSortField>('title');
	let sortDirection = $state<SortDirection>('asc');
	let minDurationMinutes = $state('');
	let maxDurationMinutes = $state('');

	const SORT_OPTIONS = [
		{ value: 'title' as const, label: 'Title' },
		{ value: 'artist' as const, label: 'Artist' },
		{ value: 'duration' as const, label: 'Duration' }
	];

	const artistOptions = $derived(
		[
			...new Set(data.librarySongs.map((s) => s.artist).filter((a): a is string => a !== null))
		].sort((a, b) => a.localeCompare(b))
	);

	const normalizedQuery = $derived(searchQuery.trim().toLowerCase());

	const filteredPlaylists = $derived(
		normalizedQuery.length === 0
			? data.playlists
			: data.playlists.filter((p) => p.name.toLowerCase().includes(normalizedQuery))
	);
	const filteredArtistPlaylists = $derived(
		normalizedQuery.length === 0
			? data.artistPlaylists
			: data.artistPlaylists.filter((p) => p.name.toLowerCase().includes(normalizedQuery))
	);
	const filteredRecommendedPlaylists = $derived(
		normalizedQuery.length === 0
			? data.recommendedPlaylists
			: data.recommendedPlaylists.filter((p) => p.name.toLowerCase().includes(normalizedQuery))
	);
	// Song results only show once there's an actual query or artist filter —
	// with neither active, every one of potentially hundreds of library
	// songs would "match", which isn't a useful thing to render below the
	// playlist grid.
	const matchingSongs = $derived.by(() => {
		if (
			normalizedQuery.length === 0 &&
			artistFilter === 'all' &&
			minDurationMinutes.trim() === '' &&
			maxDurationMinutes.trim() === ''
		) {
			return [];
		}
		const minSeconds = minDurationMinutes.trim() === '' ? null : Number(minDurationMinutes) * 60;
		const maxSeconds = maxDurationMinutes.trim() === '' ? null : Number(maxDurationMinutes) * 60;
		const filtered = data.librarySongs.filter((s) => {
			if (artistFilter !== 'all' && s.artist !== artistFilter) return false;
			if (!matchesDurationRange(s.durationSeconds, { minSeconds, maxSeconds })) return false;
			if (normalizedQuery.length === 0) return true;
			return (
				s.title.toLowerCase().includes(normalizedQuery) ||
				(s.artist?.toLowerCase().includes(normalizedQuery) ?? false)
			);
		});
		return sortSongs(filtered, sortField, sortDirection);
	});

	async function playSong(song: {
		videoId: string;
		title: string;
		durationSeconds: number | null;
	}) {
		const index = matchingSongs.findIndex((s) => s.videoId === song.videoId);
		await player.playQueue(matchingSongs, Math.max(0, index));
	}

	let renameTarget = $state<{ id: string; name: string } | null>(null);
	let renameValue = $state('');
	let renameSubmitting = $state(false);

	let deleteTarget = $state<{ id: string; name: string } | null>(null);
	let deleteSubmitting = $state(false);

	async function handleCreate(event: SubmitEvent) {
		event.preventDefault();
		if (createName.trim().length === 0) return;
		createSubmitting = true;
		try {
			const response = await fetch('/api/playlists', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: createName.trim() })
			});
			if (!response.ok) {
				toast.error(await apiErrorMessage(response, 'Failed to create playlist'));
				return;
			}
			toast.success('Playlist created');
			createOpen = false;
			createName = '';
			await invalidateAll();
		} catch {
			toast.error('Failed to create playlist');
		} finally {
			createSubmitting = false;
		}
	}

	function openRename(playlist: { id: string; name: string }) {
		renameTarget = playlist;
		renameValue = playlist.name;
	}

	async function handleRename(event: SubmitEvent) {
		event.preventDefault();
		if (!renameTarget || renameValue.trim().length === 0) return;
		renameSubmitting = true;
		try {
			const response = await fetch(`/api/playlists/${renameTarget.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: renameValue.trim() })
			});
			if (!response.ok) {
				toast.error(await apiErrorMessage(response, 'Failed to rename playlist'));
				return;
			}
			toast.success('Playlist renamed');
			renameTarget = null;
			await invalidateAll();
		} catch {
			toast.error('Failed to rename playlist');
		} finally {
			renameSubmitting = false;
		}
	}

	async function handleDelete() {
		if (!deleteTarget) return;
		deleteSubmitting = true;
		try {
			const response = await fetch(`/api/playlists/${deleteTarget.id}`, { method: 'DELETE' });
			if (!response.ok) {
				toast.error(await apiErrorMessage(response, 'Failed to delete playlist'));
				return;
			}
			toast.success('Playlist deleted');
			deleteTarget = null;
			await invalidateAll();
		} catch {
			toast.error('Failed to delete playlist');
		} finally {
			deleteSubmitting = false;
		}
	}
</script>

<svelte:head>
	<title>Library · KRSZ Music</title>
</svelte:head>

<div class="mx-auto max-w-screen-2xl p-4 md:p-8">
	{#if data.playlists.length > 0 || data.artistPlaylists.length > 0 || data.recommendedPlaylists.length > 0}
		<div class="mb-6 flex flex-wrap items-center gap-2">
			<SearchField bind:value={searchQuery} placeholder="Search playlists and songs…" />
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
		</div>
	{/if}

	<div class="mb-6 flex items-center justify-between gap-4">
		<h1 class="text-lg font-medium">Your playlists</h1>
		<Dialog.Root bind:open={createOpen}>
			<Dialog.Trigger>
				{#snippet child({ props })}
					<Button {...props} size="sm" class="gap-1.5">
						<PlusIcon class="size-4" />
						New playlist
					</Button>
				{/snippet}
			</Dialog.Trigger>
			<Dialog.Content class="sm:max-w-sm">
				<Dialog.Header>
					<Dialog.Title>New playlist</Dialog.Title>
					<Dialog.Description>Give your playlist a name.</Dialog.Description>
				</Dialog.Header>
				<form class="flex flex-col gap-4" onsubmit={handleCreate}>
					<div class="flex flex-col gap-2">
						<Label for="new-playlist-name">Name</Label>
						<Input id="new-playlist-name" required bind:value={createName} />
					</div>
					<Dialog.Footer>
						<Button type="submit" disabled={createSubmitting}>
							{createSubmitting ? 'Creating…' : 'Create'}
						</Button>
					</Dialog.Footer>
				</form>
			</Dialog.Content>
		</Dialog.Root>
	</div>

	{#if data.playlists.length === 0}
		<EmptyState message="No playlists yet. Create one, or import from a link.">
			{#snippet icon()}
				<ListMusicIcon class="text-muted-foreground size-8" />
			{/snippet}
			<Button size="sm" variant="outline" onclick={() => (createOpen = true)}>New playlist</Button>
		</EmptyState>
	{:else if filteredPlaylists.length > 0}
		<div
			class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7"
		>
			{#each filteredPlaylists as playlist (playlist.id)}
				<PlaylistCard
					href="/library/{playlist.id}"
					name={playlist.name}
					coverUrls={playlist.coverUrls}
					subtitle="{playlist.id === data.defaultPlaylistId
						? 'Your whole library · '
						: ''}{playlist.songCount} {playlist.songCount === 1 ? 'song' : 'songs'}"
				>
					{#snippet emptyIcon()}
						<ListMusicIcon class="text-muted-foreground size-8" />
					{/snippet}
					{#snippet menu()}
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										variant="ghost"
										size="icon-sm"
										class="bg-card/90 absolute top-2 right-2 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:data-[state=open]:opacity-100"
									>
										<MoreVerticalIcon class="size-4" />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="end">
								{#if playlist.kind === 'user' && playlist.id !== data.defaultPlaylistId}
									<DropdownMenu.Item onclick={() => openRename(playlist)}>
										<PencilIcon class="size-4" />
										Rename
									</DropdownMenu.Item>
									<DropdownMenu.Item
										variant="destructive"
										onclick={() => (deleteTarget = playlist)}
									>
										<Trash2Icon class="size-4" />
										Delete
									</DropdownMenu.Item>
								{/if}
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					{/snippet}
				</PlaylistCard>
			{/each}
		</div>
	{/if}

	{#if (searchQuery.trim().length > 0 || artistFilter !== 'all' || minDurationMinutes.trim() !== '' || maxDurationMinutes.trim() !== '') && filteredPlaylists.length === 0 && filteredArtistPlaylists.length === 0 && filteredRecommendedPlaylists.length === 0 && matchingSongs.length === 0}
		<p class="text-muted-foreground py-8 text-center text-sm">
			{searchQuery.trim().length > 0
				? `No matches for "${searchQuery}".`
				: 'No songs match the current filters.'}
		</p>
	{/if}

	{#if matchingSongs.length > 0}
		<h2 class="text-muted-foreground mt-8 mb-3 text-sm font-medium sm:mt-10 sm:mb-4">
			Songs ({matchingSongs.length})
		</h2>
		<div class="flex flex-col gap-1">
			{#each matchingSongs as song (song.videoId)}
				<button
					type="button"
					class="active:bg-muted hover:bg-muted flex items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors"
					onclick={() => playSong(song)}
					animate:flip={motionParams({ duration: 200 })}
				>
					<div class="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
						<MusicIcon class="text-muted-foreground size-3.5" />
					</div>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-medium">{song.title}</p>
						{#if song.artist}
							<p class="text-muted-foreground truncate text-xs">{song.artist}</p>
						{/if}
					</div>
					<span class="text-muted-foreground shrink-0 text-xs"
						>{formatDuration(song.durationSeconds)}</span
					>
				</button>
			{/each}
		</div>
	{/if}

	{#if filteredRecommendedPlaylists.length > 0}
		<h2 class="text-muted-foreground mt-8 mb-3 text-sm font-medium sm:mt-10 sm:mb-4">
			Smart Playlists
		</h2>
		<div
			class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7"
		>
			{#each filteredRecommendedPlaylists as playlist (playlist.id)}
				<PlaylistCard
					href="/library/{playlist.id}"
					name={playlist.name}
					coverUrls={playlist.coverUrls}
					subtitle="{playlist.songCount} {playlist.songCount === 1 ? 'song' : 'songs'}"
				>
					{#snippet emptyIcon()}
						<SparklesIcon class="text-muted-foreground size-8" />
					{/snippet}
				</PlaylistCard>
			{/each}
		</div>
	{/if}

	{#if filteredArtistPlaylists.length > 0}
		<h2 class="text-muted-foreground mt-8 mb-3 text-sm font-medium sm:mt-10 sm:mb-4">Artists</h2>
		<div
			class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7"
		>
			{#each filteredArtistPlaylists as playlist (playlist.id)}
				<PlaylistCard
					href="/library/{playlist.id}"
					name={playlist.name}
					coverUrls={playlist.coverUrls}
					subtitle="{playlist.songCount} {playlist.songCount === 1 ? 'song' : 'songs'}"
				>
					{#snippet emptyIcon()}
						<UserIcon class="text-muted-foreground size-8" />
					{/snippet}
				</PlaylistCard>
			{/each}
		</div>
	{/if}
</div>

<Dialog.Root open={renameTarget !== null} onOpenChange={(open) => !open && (renameTarget = null)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Rename playlist</Dialog.Title>
		</Dialog.Header>
		<form class="flex flex-col gap-4" onsubmit={handleRename}>
			<div class="flex flex-col gap-2">
				<Label for="rename-playlist-name">Name</Label>
				<Input id="rename-playlist-name" required bind:value={renameValue} />
			</div>
			<Dialog.Footer>
				<Button type="submit" disabled={renameSubmitting}>
					{renameSubmitting ? 'Saving…' : 'Save'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={deleteTarget !== null} onOpenChange={(open) => !open && (deleteTarget = null)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Delete "{deleteTarget?.name}"?</Dialog.Title>
			<Dialog.Description>
				This removes the playlist. Songs only referenced by this playlist may also be freed from
				your storage quota.
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
