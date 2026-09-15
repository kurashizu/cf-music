<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
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
	import TagIcon from '@lucide/svelte/icons/tag';
	import SearchIcon from '@lucide/svelte/icons/search';
	import MusicIcon from '@lucide/svelte/icons/music';
	import PlaylistCover from '$lib/components/playlist-cover.svelte';
	import { player } from '$lib/client/player.svelte';
	import * as Select from '$lib/components/ui/select/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let createOpen = $state(false);
	let createName = $state('');
	let createSubmitting = $state(false);

	let searchQuery = $state('');
	let artistFilter = $state<string>('all');

	const artistOptions = $derived(
		[...new Set(data.librarySongs.map((s) => s.artist).filter((a): a is string => a !== null))].sort(
			(a, b) => a.localeCompare(b)
		)
	);

	const normalizedQuery = $derived(searchQuery.trim().toLowerCase());

	const filteredPlaylists = $derived(
		normalizedQuery.length === 0
			? data.playlists
			: data.playlists.filter((p) => p.name.toLowerCase().includes(normalizedQuery))
	);
	const filteredSmartPlaylists = $derived(
		normalizedQuery.length === 0
			? data.smartPlaylists
			: data.smartPlaylists.filter((g) => g.value.toLowerCase().includes(normalizedQuery))
	);
	// Song results only show once there's an actual query or artist filter —
	// with neither active, every one of potentially hundreds of library
	// songs would "match", which isn't a useful thing to render below the
	// playlist grid.
	const matchingSongs = $derived(
		normalizedQuery.length === 0 && artistFilter === 'all'
			? []
			: data.librarySongs.filter((s) => {
					if (artistFilter !== 'all' && s.artist !== artistFilter) return false;
					if (normalizedQuery.length === 0) return true;
					return (
						s.title.toLowerCase().includes(normalizedQuery) ||
						(s.artist?.toLowerCase().includes(normalizedQuery) ?? false)
					);
				})
	);

	async function playSong(song: { videoId: string; title: string; durationSeconds: number | null }) {
		const index = matchingSongs.findIndex((s) => s.videoId === song.videoId);
		await player.playQueue(matchingSongs, Math.max(0, index));
	}

	function formatDuration(seconds: number | null): string {
		if (seconds === null) return '—';
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${m}:${s.toString().padStart(2, '0')}`;
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
				toast.error('Failed to create playlist');
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
				toast.error('Failed to rename playlist');
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
				toast.error('Failed to delete playlist');
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
	{#if data.playlists.length > 0 || data.smartPlaylists.length > 0}
		<div class="mb-6 flex flex-wrap items-center gap-2">
			<div class="relative min-w-48 flex-1">
				<SearchIcon class="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input placeholder="Search playlists and songs…" bind:value={searchQuery} class="pl-9" />
			</div>
			{#if artistOptions.length > 0}
				<Select.Root type="single" bind:value={artistFilter}>
					<Select.Trigger class="w-40">
						{artistFilter === 'all' ? 'All artists' : artistFilter}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="all" label="All artists">All artists</Select.Item>
						{#each artistOptions as artist (artist)}
							<Select.Item value={artist} label={artist}>{artist}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			{/if}
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
		<div class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
			<ListMusicIcon class="size-8 text-muted-foreground" />
			<p class="text-sm text-muted-foreground">No playlists yet. Create one, or import from a link.</p>
			<Button size="sm" variant="outline" onclick={() => (createOpen = true)}>New playlist</Button>
		</div>
	{:else if filteredPlaylists.length > 0}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
			{#each filteredPlaylists as playlist (playlist.id)}
				<Card.Root
					class="group relative overflow-hidden py-0 transition-colors hover:border-ring/50"
				>
					<a href="/library/{playlist.id}" class="flex flex-col gap-3 p-4">
						<div
							class="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-muted transition-transform duration-200 group-hover:scale-[1.02]"
						>
							<PlaylistCover coverUrls={playlist.coverUrls}>
								{#snippet fallback()}
									<ListMusicIcon class="size-8 text-muted-foreground" />
								{/snippet}
							</PlaylistCover>
						</div>
						<div class="min-w-0">
							<p class="truncate text-sm font-medium">{playlist.name}</p>
							{#if playlist.id === data.defaultPlaylistId}
								<p class="truncate text-xs text-muted-foreground">Your whole library</p>
							{/if}
						</div>
					</a>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon-sm"
									class="absolute top-2 right-2 bg-card/80 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
								>
									<MoreVerticalIcon class="size-4" />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end">
							<DropdownMenu.Item onclick={() => openRename(playlist)}>
								<PencilIcon class="size-4" />
								Rename
							</DropdownMenu.Item>
							{#if playlist.id !== data.defaultPlaylistId}
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
				</Card.Root>
			{/each}
		</div>
	{/if}

	{#if (searchQuery.trim().length > 0 || artistFilter !== 'all') && filteredPlaylists.length === 0 && filteredSmartPlaylists.length === 0 && matchingSongs.length === 0}
		<p class="py-8 text-center text-sm text-muted-foreground">
			{searchQuery.trim().length > 0 ? `No matches for "${searchQuery}".` : `No songs by ${artistFilter}.`}
		</p>
	{/if}

	{#if matchingSongs.length > 0}
		<h2 class="mt-10 mb-4 text-sm font-medium text-muted-foreground">
			Songs ({matchingSongs.length})
		</h2>
		<div class="flex flex-col gap-1">
			{#each matchingSongs as song (song.videoId)}
				<button
					type="button"
					class="flex items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted"
					onclick={() => playSong(song)}
				>
					<div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
						<MusicIcon class="size-3.5 text-muted-foreground" />
					</div>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-medium">{song.title}</p>
						{#if song.artist}
							<p class="truncate text-xs text-muted-foreground">{song.artist}</p>
						{/if}
					</div>
					<span class="shrink-0 text-xs text-muted-foreground">{formatDuration(song.durationSeconds)}</span>
				</button>
			{/each}
		</div>
	{/if}

	{#if filteredSmartPlaylists.length > 0}
		<h2 class="mt-10 mb-4 text-sm font-medium text-muted-foreground">Auto-categorized</h2>
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
			{#each filteredSmartPlaylists as group (group.id)}
				<Card.Root class="group relative overflow-hidden py-0 transition-colors hover:border-ring/50">
					<a href="/library/smart/{encodeURIComponent(group.id)}" class="flex flex-col gap-3 p-4">
						<div
							class="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-muted transition-transform duration-200 group-hover:scale-[1.02]"
						>
							<PlaylistCover coverUrls={group.coverUrls}>
								{#snippet fallback()}
									{#if group.field === 'artist'}
										<UserIcon class="size-8 text-muted-foreground" />
									{:else}
										<TagIcon class="size-8 text-muted-foreground" />
									{/if}
								{/snippet}
							</PlaylistCover>
						</div>
						<div class="min-w-0">
							<p class="truncate text-sm font-medium">{group.value}</p>
							<p class="truncate text-xs text-muted-foreground">
								{group.songCount} {group.songCount === 1 ? 'song' : 'songs'}
							</p>
						</div>
					</a>
				</Card.Root>
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
				This removes the playlist. Songs only referenced by this playlist may also be freed from your
				storage quota.
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
